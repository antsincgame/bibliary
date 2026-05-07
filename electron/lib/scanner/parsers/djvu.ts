import { promises as fs } from "fs";
import * as path from "path";
import { cleanParagraph, looksLikeHeading, type BookParser, type ParseOptions, type ParseResult, type BookSection } from "./types.js";
import { isOcrSupported, recognizeImageBuffer, reorderLanguagesForCyrillic } from "../ocr/index.js";
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
    const sections = textToSections(text);
    return {
      metadata: { title: guessTitleFromText(text) || baseName, warnings },
      sections,
      rawCharCount: text.length,
    };
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

    /* Fallback на прямой OCR cascade (старый путь, сохранён как safety net). */
    if (isOcrSupported()) {
      const result = await ocrDjvuPages(filePath, baseName, "system", opts, warnings);
      if (result.sections.length > 0) return result;
      warnings.push("system OCR returned no text — falling back to vision-llm");
    }
    const visionAvailable = await hasVisionOcrModel(opts.visionModelKey);
    if (visionAvailable) {
      return ocrDjvuPages(filePath, baseName, "vision-llm", opts, warnings);
    }
    /* НЕ DjVuLibre проблема — DjVu успешно прочитан, у файла просто нет text-layer'а.
       Реальная проблема: ни system OCR, ни vision-LLM не работают. Указываем
       конкретно что чинить в настройках. */
    warnings.push("DJVU has no embedded OCR text layer (image-only scan)");
    warnings.push("System OCR: unavailable on this OS (works only on Windows/macOS)");
    warnings.push("Vision-LLM: no model assigned to vision_ocr role (configure in Models)");
    warnings.push("To extract text from this DjVu: assign a vision_ocr model in LM Studio");
    return { metadata: { title: baseName, warnings }, sections: [], rawCharCount: 0 };
  }

  if (provider === "system" && !isOcrSupported()) {
    /* Пользователь явно выбрал system OCR, но платформа Linux. DjVuLibre тут не
       при чём — он сделал свою работу. Указываем альтернативу. */
    warnings.push("DJVU has no embedded OCR text layer (image-only scan)");
    warnings.push("System OCR is available only on Windows and macOS");
    warnings.push("Linux alternative: switch DJVU OCR provider to vision-llm and assign a vision_ocr model");
    return { metadata: { title: baseName, warnings }, sections: [], rawCharCount: 0 };
  }

  return ocrDjvuPages(filePath, baseName, provider, opts, warnings);
}

/** Проверяет, доступна ли vision-OCR модель в LM Studio (через role resolver). */
async function hasVisionOcrModel(preferredKey?: string): Promise<boolean> {
  try {
    if (preferredKey?.trim()) return true;
    const { modelRoleResolver } = await import("../../llm/model-role-resolver.js");
    const resolved = await modelRoleResolver.resolve("vision_ocr");
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
  provider: "system" | "vision-llm",
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
     * Multi-language fallback (Iter 14.7): если первый язык дал слишком мало
     * текста (≤30 chars при разрешении ≥150 dpi), это часто означает что
     * Windows.Media.Ocr использует НЕ тот language pack (например `en` для
     * украинской страницы). Пробуем оставшиеся языки из effectiveLangs по
     * очереди. Накопительная стратегия: берём самый длинный результат среди
     * попыток. Stops at first language giving ≥MIN_OCR_TEXT_THRESHOLD chars. */
    const MIN_OCR_TEXT_THRESHOLD = 30;
    opts.onPageProgress?.({
      pageIndex: page,
      totalPages: pageCount,
      source: provider === "vision-llm" ? "ocr-vision" : "ocr-system",
    });
    try {
      const imageBuffer = await runDdjvu(filePath, page, dpi, opts.signal);
      const pngBuffer = await imageBufferToPng(imageBuffer);

      let bestText = "";
      let bestLang = effectiveLangs[0] ?? "";
      const langsToTry = effectiveLangs.length > 0 ? effectiveLangs : ["ru", "uk", "en"];

      for (const lang of langsToTry) {
        if (opts.signal?.aborted) break;
        const result = provider === "vision-llm"
          ? await recognizeWithVisionLlm(pngBuffer, {
            languages: [lang],
            signal: opts.signal,
            mimeType: "image/png",
            modelKey: opts.visionModelKey,
          })
          : await recognizeImageBuffer(
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
        warnings.push(`DJVU page ${page + 1}: lang fallback "${langsToTry[0]}" → "${bestLang}" (better OCR result)`);
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
  return sections.filter((s) => s.paragraphs.length > 0);
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
