import { promises as fs } from "fs";
import * as path from "path";
import { cleanParagraph, looksLikeHeading, type BookParser, type ParseOptions, type ParseResult, type BookSection } from "./types.js";
import { isOcrSupported, recognizeImageBuffer, reorderLanguagesForCyrillic } from "../ocr/index.js";
import { isTesseractAvailable, recognizeWithTesseract } from "../ocr/tesseract.js";
import { recognizeWithVisionLlm } from "../../llm/vision-ocr.js";
import { getDjvuBookmarks, getDjvuInstallHint, getDjvuPageCount, runDdjvu, runDjvutxt, runDjvutxtPage } from "./djvu-cli.js";
import { imageBufferToPng } from "../../native/sharp-loader.js";
import { pickBestBookTitle } from "../../library/title-heuristics.js";
import { isQualityText, detectLatinCyrillicConfusion } from "../extractors/quality-heuristic.js";
import { convertDjvu } from "../converters/djvu.js";

/* Re-export для backward-compat: tests/djvu-quality-heuristic.test.ts импортирует
   isQualityText из этого модуля. После переноса логики в extractors/ — оставляем
   тонкий re-export. Future cleanup (отдельный поход): обновить импорт в тестах
   на extractors/quality-heuristic и удалить отсюда. */
export { isQualityText };

const MAX_DJVU_FILE_BYTES = 500 * 1024 * 1024;
const MIN_DJVU_OVERRIDE_BYTES = 50 * 1024 * 1024;
const MAX_DJVU_OVERRIDE_BYTES = 4 * 1024 * 1024 * 1024;

async function parseDjvu(filePath: string, opts: ParseOptions = {}): Promise<ParseResult> {
  const stat = await fs.stat(filePath);
  const baseName = path.basename(filePath, path.extname(filePath));
  const warnings: string[] = [];

  /* Hard limit: default 500 MB, override через opts.djvuMaxBytes (зажат в 50 MB..4 GB).
   * Архивные тома (Britannica, БСЭ) часто 800-2000 MB — пользователь может
   * явно их разрешить через preferences.djvuMaxBytes. */
  const limitBytes = (() => {
    const o = opts.djvuMaxBytes;
    if (typeof o !== "number" || !Number.isFinite(o) || o <= 0) return MAX_DJVU_FILE_BYTES;
    return Math.min(MAX_DJVU_OVERRIDE_BYTES, Math.max(MIN_DJVU_OVERRIDE_BYTES, o));
  })();

  if (stat.size > limitBytes) {
    const sizeMb = (stat.size / 1024 / 1024).toFixed(1);
    const limitMb = (limitBytes / 1024 / 1024).toFixed(0);
    return {
      metadata: {
        title: baseName,
        warnings: [`DJVU too large (${sizeMb} MB > ${limitMb} MB limit) — refused`],
      },
      sections: [],
      rawCharCount: 0,
    };
  }

  let text = "";
  try {
    text = await runDjvutxt(filePath, opts.signal);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    warnings.push(`djvutxt unavailable or failed: ${msg.slice(0, 140)}`);
    warnings.push(getDjvuInstallHint());
  }

  if (isQualityText(text)) {
    /* v1.1.2 Bug #4 fix: проверяем text-layer на Latin-Cyrillic confusion ДО
       того как считать его пригодным. Без этой проверки FineReader/ABBYY OCR
       без cyrillic language pack даёт текст с homoglyph-кашей (Latin p вместо
       Cyrillic р, digit subs типа `06pa3y`), который проходит letter-ratio
       check, попадает в книгу, а потом evaluator получает мусор и ставит
       quality_score близкий к 0. Path 2 (per-page OCR) уже делает эту
       проверку — здесь добавляем симметрично. */
    const confusion = detectLatinCyrillicConfusion(text);
    if (!confusion.isConfused) {
      /* Bug #2 fix: если у DjVu есть outline (bookmarks) — построить
         главы по нему через per-page extraction (правильные chapter
         anchors). Иначе текст распиливается на одну гигантскую секцию
         и chapterCount=1, что блокирует surrogate-builder и эвалюатор. */
      const sections = await sectionsFromTextOrOutline(filePath, text, opts.signal, warnings);
      return {
        metadata: { title: guessTitleFromText(text) || baseName, warnings },
        sections,
        rawCharCount: text.length,
      };
    }
    warnings.push(
      `DJVU text layer flagged as Latin-Cyrillic confused ` +
      `(homoglyphTokens=${confusion.homoglyphTokens}, digitSubs=${confusion.digitSubstitutions}) — falling through to OCR`,
    );
  }

  const provider = opts.djvuOcrProvider ?? "auto";
  if (opts.ocrEnabled !== true) {
    warnings.push("DJVU has no usable text layer and OCR is disabled");
    return { metadata: { title: baseName, warnings }, sections: [], rawCharCount: 0 };
  }
  if (provider === "none") {
    warnings.push("DJVU has no usable text layer and OCR is disabled (provider=none)");
    return { metadata: { title: baseName, warnings }, sections: [], rawCharCount: 0 };
  }

  /* AUTO: convertDjvu → pdfParser → fallback на ocrDjvuPages (system→vision).
   *
   * Spartan retreat возврат из Итерации 3: parseDjvu теперь делегирует
   * convertDjvu (двухступенчатый: djvutxt → ddjvu→pdf). Имиджевый PDF от ddjvu
   * парсится существующим pdfParser, у которого уже отлажен Universal Cascade
   * (pdf-inspector → rasterise → OS OCR → vision-LLM). Это сохраняет принцип
   * «формат это контейнер»: вместо собственного OCR-цикла используем готовый
   * pipeline pdfParser.
   *
   * Если pdfParser cascade вернул пусто (редкий случай — повреждённый ddjvu
   * output или pdf-inspector ошибочно классифицировал) — fallback на старый
   * прямой ocrDjvuPages cascade (system→vision per-page). Это Mahakala
   * expand-contract паттерн: новая ветка ДО старой, старая остаётся как safety net. */
  if (provider === "auto") {
    /* Передаём precomputedText чтобы convertDjvu не вызывал runDjvutxt повторно
       (parseDjvu выше уже его сделал и сохранил в `text` для quality check). */
    const conv = await convertDjvu(filePath, { signal: opts.signal, precomputedText: text });
    try {
      if (conv.kind === "delegate" && conv.ext === "pdf") {
        /* Lazy import чтобы избежать циклических зависимостей djvu↔pdf на этапе
           загрузки модуля. На рантайме pdfParser уже загружен через parsers/index. */
        const { pdfParser } = await import("./pdf.js");
        try {
          const pdfResult = await pdfParser.parse(conv.path, opts);
          if (pdfResult.sections.length > 0 && pdfResult.rawCharCount > 0) {
            warnings.push("DJVU converted to imaged PDF and parsed via pdfParser cascade");
            if (conv.warnings.length > 0) warnings.push(...conv.warnings);
            return {
              metadata: {
                ...pdfResult.metadata,
                title: pdfResult.metadata.title || baseName,
                warnings: [...warnings, ...pdfResult.metadata.warnings],
              },
              sections: pdfResult.sections,
              rawCharCount: pdfResult.rawCharCount,
            };
          }
          warnings.push("DJVU→PDF cascade returned no sections — falling back to direct OCR");
          if (pdfResult.metadata.warnings.length > 0) warnings.push(...pdfResult.metadata.warnings);
        } catch (pdfErr) {
          const msg = pdfErr instanceof Error ? pdfErr.message : String(pdfErr);
          warnings.push(`DJVU→PDF parse failed: ${msg.slice(0, 200)} — falling back to direct OCR`);
        }
      } else if (conv.warnings.length > 0) {
        /* convertDjvu вернул text-extracted (ddjvu сам не справился) — переходим
           в прямой ocrDjvuPages cascade ниже. */
        warnings.push(...conv.warnings);
      }
    } finally {
      await conv.cleanup();
    }

    /* AUTO cascade: Tesseract Tier-1a → system OCR Tier-1b → vision-LLM Tier-2.
       Tesseract первым, потому что:
       1. Bundled rus/ukr/eng tessdata — работает на всех платформах identically.
       2. ~3s/page, CPU-only — не нагружает GPU LLM.
       3. Solid Cyrillic из коробки (rus/ukr models). Закрывает Linux gap, где
          system OCR не существует, и вытесняет vision-LLM (плохо знает кириллицу)
          в Tier-2. */
    if (isTesseractAvailable()) {
      const result = await ocrDjvuPages(filePath, baseName, "tesseract", opts, warnings);
      if (result.sections.length > 0) return result;
      warnings.push("tesseract OCR returned no text — falling back to system / vision-llm");
    }
    if (isOcrSupported()) {
      const result = await ocrDjvuPages(filePath, baseName, "system", opts, warnings);
      if (result.sections.length > 0) return result;
      warnings.push("system OCR returned no text — falling back to vision-llm");
    }
    const visionAvailable = await hasVisionOcrModel(opts.visionOcrModel);
    if (visionAvailable) {
      return ocrDjvuPages(filePath, baseName, "vision-llm", opts, warnings);
    }
    /* Все варианты исчерпаны. */
    warnings.push("DJVU has no embedded OCR text layer (image-only scan)");
    warnings.push("Tesseract bundled tessdata not found — verify vendor/tessdata/ in build");
    warnings.push("System OCR: unavailable on this OS (works only on Windows/macOS)");
    warnings.push("Vision-LLM: no model assigned to vision_ocr role (configure in Models)");
    return { metadata: { title: baseName, warnings }, sections: [], rawCharCount: 0 };
  }

  if (provider === "tesseract" && !isTesseractAvailable()) {
    warnings.push("DJVU OCR provider=tesseract but bundled tessdata not found");
    warnings.push("Expected vendor/tessdata/{rus,ukr,eng}.traineddata in app resources");
    return { metadata: { title: baseName, warnings }, sections: [], rawCharCount: 0 };
  }

  if (provider === "system" && !isOcrSupported()) {
    warnings.push("DJVU has no embedded OCR text layer (image-only scan)");
    warnings.push("System OCR is available only on Windows and macOS");
    warnings.push("Linux alternative: switch DJVU OCR provider to tesseract or vision-llm");
    return { metadata: { title: baseName, warnings }, sections: [], rawCharCount: 0 };
  }

  return ocrDjvuPages(filePath, baseName, provider, opts, warnings);
}

/** Проверяет, доступна ли vision-OCR модель в LM Studio (через role resolver). */
async function hasVisionOcrModel(preferredKey?: string): Promise<boolean> {
  try {
    if (preferredKey?.trim()) return true;
    const { getVisionOcrModel } = await import("../../llm/model-resolver.js");
    const resolved = await getVisionOcrModel();
    return resolved !== null;
  } catch {
    return false;
  }
}

/** Минимум осмысленного текста на странице чтобы пропустить OCR (per-page routing). */
const PER_PAGE_TEXT_THRESHOLD = 50;

/**
 * Прямой OCR cascade per-page для DjVu.
 *
 * Это Tier 2 fallback в parseDjvu — используется когда convertDjvu→pdfParser
 * не справился (см. parseDjvu provider="auto" ветка) ИЛИ когда пользователь
 * явно выбрал djvuOcrProvider:"system"/"vision-llm".
 *
 * Per-page routing (Итерация 4 Часть Б): для каждой страницы СНАЧАЛА пробуем
 * `runDjvutxtPage` (бесплатно). Если страница имеет ≥50 chars осмысленного
 * текста — используем его, OCR пропускаем. Это даёт 80%+ heavy lane экономии
 * на смешанных DjVu (научные книги: текстовые страницы с FineReader OCR-слоем,
 * formula/diagram страницы — без слоя).
 */
async function ocrDjvuPages(
  filePath: string,
  baseName: string,
  provider: "tesseract" | "system" | "vision-llm",
  opts: ParseOptions,
  warnings: string[],
): Promise<ParseResult> {
  let pageCount = 1;
  try {
    pageCount = await getDjvuPageCount(filePath, opts.signal);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    warnings.push(`djvused page count failed: ${msg.slice(0, 120)}`);
    warnings.push(getDjvuInstallHint());
  }

  const dpi = opts.djvuRenderDpi ?? opts.ocrPdfDpi ?? 200;
  const paragraphs: Array<{ page: number; text: string }> = [];
  let totalChars = 0;
  let ocrPages = 0;
  let textLayerPages = 0;

  for (let page = 0; page < pageCount; page++) {
    if (opts.signal?.aborted) {
      /* Различаем причину abort: пользовательская отмена / per-file timeout /
       * unknown. Текстовая подсказка попадает в UI (Import failed: ...).
       * До этого фикса всегда писалось 'djvu OCR aborted' без пояснения. */
      const reason = opts.signal.reason;
      const reasonStr =
        typeof reason === "string"
          ? reason
          : reason instanceof Error
            ? reason.message
            : reason !== undefined
              ? String(reason)
              : "unknown";
      const friendly =
        reasonStr === "user-cancel"
          ? "DjVu OCR cancelled by user"
          : reasonStr.includes("timeout")
            ? `DjVu OCR exceeded per-file time budget (${reasonStr})`
            : `DjVu OCR aborted: ${reasonStr}`;
      throw new Error(friendly);
    }

    /* Tier 0 per-page: пробуем встроенный текстовый слой страницы. Дешёво
       (один djvutxt --page=N вызов, обычно <100ms). Если на странице есть
       ≥ PER_PAGE_TEXT_THRESHOLD chars И текст не является OCR-кашей
       (Latin-Cyrillic confusion, digit substitutions) — пропускаем OCR. */
    opts.onPageProgress?.({ pageIndex: page, totalPages: pageCount, source: "text-layer" });
    const pageText = await runDjvutxtPage(filePath, page, opts.signal);
    let confusedTextLayer = false;
    if (pageText.length >= PER_PAGE_TEXT_THRESHOLD) {
      const confusion = detectLatinCyrillicConfusion(pageText);
      if (!confusion.isConfused) {
        const blocks = pageText
          .split(/\n{2,}/)
          .map((line) => cleanParagraph(line))
          .filter((line) => line.length > 0);
        for (const block of blocks) {
          paragraphs.push({ page: page + 1, text: block });
          totalChars += block.length;
        }
        textLayerPages++;
        continue;
      }
      /* Text layer exists but is confused (Latin homoglyphs / digit subs) —
         fall through to OCR. Force Cyrillic-first language order so the OS OCR
         engine doesn't repeat the same English-only mistake. */
      confusedTextLayer = true;
    }

    /* When the text layer was identified as confused, use Cyrillic-first lang order.
       On Windows, @napi-rs/system-ocr uses ONLY the first language, so putting
       "ru" first is critical for correct Cyrillic recognition. */
    const effectiveLangs = confusedTextLayer
      ? reorderLanguagesForCyrillic(opts.ocrLanguages ?? [])
      : (opts.ocrLanguages ?? []);

    /* Tier 1/2 per-page: страница без встроенного текста — рендерим и OCR'им.
     *
     * Multi-language strategy зависит от platform/provider:
     *
     *   Windows.Media.Ocr (system on Win): использует ТОЛЬКО первый язык из
     *     preferredLangs. Если страница на украинском но в langs первый "en" —
     *     получим garbage. → Cycling: каждый язык по очереди, выбираем самый
     *     длинный результат (early stop ≥30 chars).
     *
     *   macOS Vision Framework (system on Mac): нативно multi-language. Один
     *     call с массивом всех языков отрабатывает быстрее cycling'а в N раз
     *     (нет повторной obj-c calls). → Single call with all langs.
     *
     *   vision-LLM (LM Studio любая платформа): LLM сам понимает текст
     *     многоязычно из image content. Передаём все языки как hint в prompt
     *     (recognizeWithVisionLlm объединяет их в "ru/uk/en"). → Single call.
     *
     *   Linux system OCR: недоступно (нет нативного API). Сюда не доходим —
     *     parseDjvu выше уже переключил на vision-LLM или вернул warning. */
    const MIN_OCR_TEXT_THRESHOLD = 30;
    opts.onPageProgress?.({
      pageIndex: page,
      totalPages: pageCount,
      source: provider === "vision-llm" ? "ocr-vision" : "ocr-system",
    });
    try {
      const imageBuffer = await runDdjvu(filePath, page, dpi, opts.signal);
      const pngBuffer = await imageBufferToPng(imageBuffer);

      const langsToTry = effectiveLangs.length > 0 ? effectiveLangs : ["ru", "uk", "en"];
      /* Tesseract нативно multi-lang в одном вызове (передаём все языки в worker
       * init). vision-LLM тоже multi-lang. Только Win.Media.Ocr требует
       * cycling — single-lang per call. */
      const supportsNativeMultiLang =
        provider === "tesseract" || provider === "vision-llm";

      let bestText = "";
      let bestLang = langsToTry[0];

      if (supportsNativeMultiLang) {
        const pngBytes = new Uint8Array(pngBuffer.buffer, pngBuffer.byteOffset, pngBuffer.byteLength);
        const result = provider === "tesseract"
          ? await recognizeWithTesseract(pngBytes, {
            languages: langsToTry,
            pageIndex: page,
            signal: opts.signal,
          })
          : provider === "vision-llm"
          ? await recognizeWithVisionLlm(pngBuffer, {
            languages: langsToTry,
            signal: opts.signal,
            mimeType: "image/png",
            modelKey: opts.visionOcrModel,
          })
          : await recognizeImageBuffer(
            pngBytes,
            page,
            langsToTry,
            opts.ocrAccuracy ?? "accurate",
            opts.signal,
          );
        bestText = result.text.trim();
      } else {
        /* Windows.Media.Ocr: cycling — single-lang per call. */
        for (const lang of langsToTry) {
          if (opts.signal?.aborted) break;
          const result = await recognizeImageBuffer(
            new Uint8Array(pngBuffer.buffer, pngBuffer.byteOffset, pngBuffer.byteLength),
            page,
            [lang],
            opts.ocrAccuracy ?? "accurate",
            opts.signal,
          );
          const candidate = result.text.trim();
          if (candidate.length > bestText.length) {
            bestText = candidate;
            bestLang = lang;
          }
          if (candidate.length >= MIN_OCR_TEXT_THRESHOLD) break;
        }
        if (bestLang !== langsToTry[0] && bestText.length > 0) {
          warnings.push(`DJVU page ${page + 1}: lang fallback "${langsToTry[0]}" → "${bestLang}" (Win.Media.Ocr single-lang)`);
        }
      }
      const text = bestText;
      if (!text) continue;
      const blocks = text
        .split(/\n{2,}/)
        .map((line) => cleanParagraph(line))
        .filter((line) => line.length > 0);
      for (const block of blocks) {
        paragraphs.push({ page: page + 1, text: block });
        totalChars += block.length;
      }
      ocrPages++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      warnings.push(`DJVU OCR failed on page ${page + 1}: ${msg.slice(0, 120)}`);
    }
  }

  if (textLayerPages > 0) warnings.push(`DJVU per-page text layer used for ${textLayerPages}/${pageCount} page(s) (heavy lane saved)`);
  if (ocrPages > 0) warnings.push(`DJVU OCR applied to ${ocrPages}/${pageCount} page(s) using ${provider}`);
  if (ocrPages === 0 && textLayerPages === 0) {
    /* DjVuLibre отработал на page count и rasterise; пусто — это OCR engine
       (system / vision-LLM) ничего не распознал. Указываем настоящую причину. */
    warnings.push(`DJVU OCR engine (${provider}) produced no text from any page`);
    warnings.push("Possible causes: missing language pack (system OCR), vision-LLM model mismatch, or unreadable scan quality");
  }

  /* Outline (bookmarks) — если автор оцифровки сделал TOC, используем его
   * как chapter boundaries. Best-effort: при отсутствии outline возвращает [],
   * paragraphsToSections фоллбекит на "Page N" без поломки. */
  let bookmarks: Awaited<ReturnType<typeof getDjvuBookmarks>> = [];
  try {
    bookmarks = await getDjvuBookmarks(filePath, opts.signal);
    if (bookmarks.length > 0) {
      warnings.push(`DjVu outline found: ${bookmarks.length} bookmark(s) → MD chapter anchors`);
    }
  } catch {
    /* not fatal — fallback на "Page N" sections */
  }

  const sections = paragraphsToSections(paragraphs, bookmarks);
  return {
    metadata: { title: baseName, warnings },
    sections,
    rawCharCount: totalChars,
  };
}

function textToSections(text: string): BookSection[] {
  const blocks = text.split(/\n\s*\n/).map((b) => cleanParagraph(b)).filter(Boolean);
  const sections: BookSection[] = [];
  let current: BookSection | null = null;
  let untitled = 0;
  for (const block of blocks) {
    const lines = block.split("\n");
    if (lines.length === 1 && looksLikeHeading(lines[0])) {
      current = { level: 1, title: lines[0].trim(), paragraphs: [] };
      sections.push(current);
      continue;
    }
    if (!current) {
      untitled++;
      current = { level: 1, title: `Section ${untitled}`, paragraphs: [] };
      sections.push(current);
    }
    current.paragraphs.push(block.replace(/\n/g, " "));
  }
  const cleaned = sections.filter((s) => s.paragraphs.length > 0);
  /* Bug #2 fallback: если ни один блок не выглядел как heading, мы получаем
     ровно одну "Section 1" со всем текстом. Это убивает surrogate-builder:
     pickNodalChapterIndices исключает first/last → нет nodal slices, оценка
     эпистемолога теряет узловые срезы. Пробуем расщепить по сильным
     bibliographic markers ("Глава 1", "Chapter 1", "Часть N", "Раздел N"). */
  if (cleaned.length <= 1 && text.length > 5_000) {
    const split = splitByChapterMarkers(text);
    if (split.length >= 3) return split;
  }
  return cleaned;
}

/**
 * v1.1.2 Bug #2 fix — heuristic split for DjVu text layer without outline.
 *
 * Ищем устойчивые маркеры начала главы:
 *   - "Глава N" / "ГЛАВА N" (русский)
 *   - "Розділ N" / "РОЗДІЛ N" (украинский)
 *   - "Chapter N" / "CHAPTER N" (английский)
 *   - "Часть N" / "Часть N" / "Part N"
 *   - "§N" / "§ N" (учебники математики/физики)
 *
 * Маркер должен быть в начале строки (после `\n`), за ним номер 1-3 цифры
 * либо римская цифра. Это ловит большинство учебников и монографий.
 *
 * Если нашлось ≥ 2 маркера — режем текст по ним. Иначе возвращаем пустой
 * массив, caller использует исходный textToSections fallback.
 */
function splitByChapterMarkers(text: string): BookSection[] {
  const marker = /^[ \t]*((?:ГЛАВА|Глава|Розділ|РОЗДІЛ|Chapter|CHAPTER|Часть|ЧАСТЬ|Part|PART|Раздел|РАЗДЕЛ)\s+(?:[IVXLCDM]+|\d{1,3})[.\s:].{0,200})$/gmu;
  const positions: { idx: number; title: string }[] = [];
  let match;
  while ((match = marker.exec(text)) !== null) {
    positions.push({ idx: match.index, title: match[1].trim() });
    if (positions.length > 200) break;
  }
  if (positions.length < 2) return [];

  const sections: BookSection[] = [];
  for (let i = 0; i < positions.length; i++) {
    const start = positions[i].idx;
    const end = i + 1 < positions.length ? positions[i + 1].idx : text.length;
    const body = text.slice(start, end);
    const lineEnd = body.indexOf("\n");
    const headLine = lineEnd > 0 ? body.slice(0, lineEnd) : body;
    const rest = lineEnd > 0 ? body.slice(lineEnd + 1) : "";
    const paragraphs = rest
      .split(/\n\s*\n/)
      .map((p) => cleanParagraph(p).replace(/\n/g, " "))
      .filter((p) => p.length > 0);
    if (paragraphs.length === 0) continue;
    sections.push({
      level: 1,
      title: headLine.trim() || positions[i].title,
      paragraphs,
    });
  }
  return sections;
}

/**
 * v1.1.2 Bug #2 — если у DjVu есть outline, всегда строим главы по нему
 * через per-page extraction. Path 1 (full-doc djvutxt) одной строкой не
 * может привязать text → page → bookmark, поэтому в этом случае мы
 * перевызываем djvutxt per-page и склеиваем уже с правильными anchors.
 *
 * Если outline пуст или его не удалось получить — fallback на текстовый
 * `textToSections` (с heuristic-расщеплением по chapter markers).
 */
async function sectionsFromTextOrOutline(
  filePath: string,
  fullText: string,
  signal: AbortSignal | undefined,
  warnings: string[],
): Promise<BookSection[]> {
  let bookmarks: Awaited<ReturnType<typeof getDjvuBookmarks>> = [];
  try {
    bookmarks = await getDjvuBookmarks(filePath, signal);
  } catch {
    /* outline не критичен — fallback на text-based sectioning */
  }
  if (bookmarks.length === 0) {
    return textToSections(fullText);
  }

  /* Outline есть — пробуем построить sections per-page чтобы привязать
     bookmarks к страницам. Если per-page extraction провалился (например,
     djvutxt --page=N не работает на этом файле), деградируем на
     text-based sectioning, чтобы хоть что-то отдать. */
  let pageCount = 0;
  try {
    pageCount = await getDjvuPageCount(filePath, signal);
  } catch {
    return textToSections(fullText);
  }
  if (pageCount <= 1) return textToSections(fullText);

  const paragraphs: Array<{ page: number; text: string }> = [];
  for (let page = 0; page < pageCount; page++) {
    if (signal?.aborted) break;
    let pageText = "";
    try {
      pageText = await runDjvutxtPage(filePath, page, signal);
    } catch {
      continue;
    }
    if (!pageText) continue;
    const blocks = pageText
      .split(/\n{2,}/)
      .map((line) => cleanParagraph(line))
      .filter((line) => line.length > 0);
    for (const block of blocks) {
      paragraphs.push({ page: page + 1, text: block });
    }
  }
  if (paragraphs.length === 0) return textToSections(fullText);

  warnings.push(`DjVu outline used: ${bookmarks.length} bookmark(s) → MD chapter anchors`);
  return paragraphsToSections(paragraphs, bookmarks);
}

/** Экспорт для регрессионных тестов (Iter 14.5: вертикальный текст).
 *
 * Если bookmarks (outline DjVu) переданы, использует их title как заголовок
 * главы. Это даёт МД с настоящими chapter-границами вместо безликих "Page N".
 * Bookmark `pageIndex` — 0-based, paragraphs.page здесь 1-based, поэтому
 * сравнение через `bookmark.pageIndex + 1`. Если на конкретную страницу
 * bookmark'а нет — пишем "Page N" как раньше (для страниц до первого
 * bookmark или между bookmark'ами при разреженном outline).
 */
export function paragraphsToSections(
  paragraphs: Array<{ page: number; text: string }>,
  bookmarks: Array<{ title: string; pageIndex: number }> = [],
): BookSection[] {
  const sections: BookSection[] = [];
  let current: BookSection | null = null;
  let lastPage = -1;
  /* page (1-based) → bookmark.title для O(1) lookup. */
  const bookmarkByPage = new Map<number, string>();
  for (const b of bookmarks) bookmarkByPage.set(b.pageIndex + 1, b.title);

  for (const { page, text } of paragraphs) {
    if (page !== lastPage) {
      const bookmarkTitle = bookmarkByPage.get(page);
      current = {
        level: 1,
        title: bookmarkTitle ?? `Page ${page}`,
        paragraphs: [],
      };
      sections.push(current);
      lastPage = page;
    }
    /* Per-page DjVu OCR (особенно из встроенного текстового слоя) часто
     * приходит как «слово\nслово\nслово» — одно слово на строку. Это убивает
     * вёрстку: книга превращается в вертикальный столбик букв. Склейка
     * одиночных `\n` в пробел восстанавливает абзацы. Двойные `\n` уже стали
     * границами блоков выше (`pageText.split(/\n{2,}/)`), поэтому абзацы
     * не теряются. Соответствует поведению `textToSections` для full-doc
     * пути (см. djvu.ts:textToSections). */
    const flat = text.replace(/\n/g, " ").replace(/\s{2,}/g, " ").trim();
    if (!flat) continue;
    if (looksLikeHeading(flat) && flat.length < 100) {
      current = { level: 1, title: flat, paragraphs: [] };
      sections.push(current);
      continue;
    }
    current!.paragraphs.push(flat);
  }
  return sections.filter((s) => s.paragraphs.length > 0);
}

function guessTitleFromText(text: string): string | null {
  const firstLine = text.split("\n").find((l) => l.trim().length > 3);
  if (!firstLine || firstLine.trim().length >= 120) return null;
  return pickBestBookTitle(firstLine) ?? null;
}

export const djvuParser: BookParser = { ext: "djvu", parse: parseDjvu };
