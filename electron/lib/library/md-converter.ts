/**
 * Book → Markdown converter (Pre-flight Evaluation architecture).
 *
 * Превращает любую поддерживаемую книгу в **один** .md файл, содержащий:
 *   1. YAML frontmatter с lean-метаданными (читается SQLite-кэшем при rebuild)
 *   2. Опциональную секцию `## Evaluator Reasoning` с CoT эпистемолога
 *   3. Структурированный текст с заголовками глав
 *   4. Reference links на CAS assets (bibliary-asset://sha256/...)
 *
 * Картинки НЕ встраиваются как Base64. Буферы передаются caller'у (import.ts),
 * который сохраняет их в CAS (.blobs/) и проставляет assetUrl перед записью.
 *
 * Контракт CPU/GPU: эта функция -- чистая CPU-задача.
 */

import * as path from "path";
import { applyLayout, shouldRenderMath } from "./layout-pipeline.js";
import { parseBook, detectExt } from "../scanner/parsers/index.js";
import { isOcrSupported } from "../scanner/ocr/index.js";
import { extractBookImages } from "./image-extractors.js";
import { computeFileSha256, bookIdFromSha } from "./sha-stream.js";
import { extractMetadataFromCover } from "../llm/vision-meta.js";
import { pickBestBookTitle } from "./title-heuristics.js";
import { extractIsbnsFromSections } from "./isbn-extractor.js";
import { lookupIsbnOpenLibrary } from "../bookhunter/sources/openlibrary.js";
import { lookupIsbnGoogleBooks } from "../bookhunter/sources/google-books-meta.js";
import { detectLanguageByRegex } from "../llm/lang-detector.js";
import { extractTextMetaFromBookText, type TextMeta } from "./text-meta-extractor.js";
import {
  SUPPORTED_BOOK_EXTS,
  type BookCatalogMeta,
  type BookStatus,
  type ConvertedBook,
  type ConvertedChapter,
  type ConvertOptions,
  type ImageRef,
  type SupportedBookFormat,
} from "./types.js";

/** Magic numbers, вынесенные из inline-литералов (Block A2). Все значения
 *  подобраны эмпирически по русско/английским PDF/DjVu, не от балды. */
const META_FALLBACK_CONFIG = {
  /** Сколько первых секций берём для AI text-meta sample. */
  textMetaSampleSections: 3,
  /** Максимум символов sample для text-meta extractor. */
  textMetaSampleChars: 3000,
  /** Минимальная длина title чтобы НЕ считать его weak. */
  titleMinChars: 3,
  /** Минимальный confidence vision-meta, чтобы использовать результат. */
  visionMetaMinConfidence: 0.5,
  /** Сколько глав берём для language detection. */
  langDetectChapters: 3,
  /** Максимум символов для language detection sample. */
  langDetectSampleChars: 4096,
  /** ISBN online lookup hard timeout, мс. */
  isbnLookupTimeoutMs: 8_000,
} as const;

function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/** YAML 1.2 double-quoted style -- безопасно для всех строк. */
function escapeYaml(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

const NUMERIC_KEYS: ReadonlySet<string> = new Set([
  "wordCount",
  "chapterCount",
  "qualityScore",
  "conceptualDensity",
  "originality",
  "conceptsExtracted",
  "conceptsAccepted",
  "layoutVersion",
]);

const BOOLEAN_KEYS: ReadonlySet<string> = new Set(["isFictionOrWater"]);

function buildFrontmatter(meta: BookCatalogMeta): string {
  const lines: string[] = ["---"];
  // identity
  lines.push(`id: ${escapeYaml(meta.id)}`);
  lines.push(`sha256: ${escapeYaml(meta.sha256)}`);
  // source
  lines.push(`originalFile: ${escapeYaml(meta.originalFile)}`);
  lines.push(`originalFormat: ${meta.originalFormat}`);
  if (meta.sourceArchive) lines.push(`sourceArchive: ${escapeYaml(meta.sourceArchive)}`);
  if (meta.sphere) lines.push(`sphere: ${escapeYaml(meta.sphere)}`);
  // bibliographic
  lines.push(`title: ${escapeYaml(meta.title)}`);
  if (meta.author) lines.push(`author: ${escapeYaml(meta.author)}`);
  if (meta.titleRu) lines.push(`titleRu: ${escapeYaml(meta.titleRu)}`);
  if (meta.authorRu) lines.push(`authorRu: ${escapeYaml(meta.authorRu)}`);
  if (meta.titleEn) lines.push(`titleEn: ${escapeYaml(meta.titleEn)}`);
  if (meta.authorEn) lines.push(`authorEn: ${escapeYaml(meta.authorEn)}`);
  if (meta.year !== undefined) lines.push(`year: ${meta.year}`);
  if (meta.language) lines.push(`language: ${escapeYaml(meta.language)}`);
  if (meta.isbn) lines.push(`isbn: ${escapeYaml(meta.isbn)}`);
  if (meta.publisher) lines.push(`publisher: ${escapeYaml(meta.publisher)}`);
  // structure
  lines.push(`wordCount: ${meta.wordCount}`);
  lines.push(`chapterCount: ${meta.chapterCount}`);
  // evaluator
  if (meta.domain) lines.push(`domain: ${escapeYaml(meta.domain)}`);
  if (meta.tags && meta.tags.length > 0) {
    lines.push(`tags: [${meta.tags.map((t) => escapeYaml(t)).join(", ")}]`);
  }
  if (meta.tagsRu && meta.tagsRu.length > 0) {
    lines.push(`tagsRu: [${meta.tagsRu.map((t) => escapeYaml(t)).join(", ")}]`);
  }
  if (meta.qualityScore !== undefined) lines.push(`qualityScore: ${meta.qualityScore}`);
  if (meta.conceptualDensity !== undefined) lines.push(`conceptualDensity: ${meta.conceptualDensity}`);
  if (meta.originality !== undefined) lines.push(`originality: ${meta.originality}`);
  if (meta.isFictionOrWater !== undefined) lines.push(`isFictionOrWater: ${meta.isFictionOrWater}`);
  if (meta.verdictReason) lines.push(`verdictReason: ${escapeYaml(meta.verdictReason)}`);
  if (meta.evaluatorModel) lines.push(`evaluatorModel: ${escapeYaml(meta.evaluatorModel)}`);
  if (meta.evaluatedAt) lines.push(`evaluatedAt: ${escapeYaml(meta.evaluatedAt)}`);
  // crystallization
  if (meta.conceptsExtracted !== undefined) lines.push(`conceptsExtracted: ${meta.conceptsExtracted}`);
  if (meta.conceptsAccepted !== undefined) lines.push(`conceptsAccepted: ${meta.conceptsAccepted}`);
  // lifecycle
  lines.push(`status: ${meta.status}`);
  if (meta.warnings && meta.warnings.length > 0) {
    lines.push(`warnings:`);
    for (const w of meta.warnings) lines.push(`  - ${escapeYaml(w)}`);
  }
  // layout (Versator)
  if (typeof meta.layoutVersion === "number" && meta.layoutVersion > 0) {
    lines.push(`layoutVersion: ${meta.layoutVersion}`);
  }
  lines.push("---");
  return lines.join("\n");
}

/**
 * YAML frontmatter parser -- ровно столько сколько нам нужно для rebuild
 * каталога из .md файлов. Не использует внешний deps. Терпим к unknown
 * ключам (например, легаси `language` / `year`) -- просто игнорирует их
 * на уровне TypeScript (Partial), но заносит в out.
 */
export function parseFrontmatter(markdown: string): Partial<BookCatalogMeta> | null {
  if (!markdown.startsWith("---\n")) return null;
  const end = markdown.indexOf("\n---\n", 4);
  if (end === -1) return null;
  const block = markdown.slice(4, end);
  const lines = block.split("\n");

  const out: Record<string, unknown> = {};
  let listKey: string | null = null;
  let listAcc: string[] = [];
  const flushList = (): void => {
    if (listKey !== null) {
      out[listKey] = listAcc;
      listKey = null;
      listAcc = [];
    }
  };

  for (const raw of lines) {
    if (raw.startsWith("  - ")) {
      if (listKey) listAcc.push(unquoteYaml(raw.slice(4).trim()));
      continue;
    }
    flushList();
    if (!raw.includes(":")) continue;
    const colon = raw.indexOf(":");
    const key = raw.slice(0, colon).trim();
    const value = raw.slice(colon + 1).trim();
    if (value === "") {
      listKey = key;
      listAcc = [];
      continue;
    }
    if (value.startsWith("[") && value.endsWith("]")) {
      const inner = value.slice(1, -1).trim();
      out[key] = inner.length === 0 ? [] : inner.split(",").map((part) => unquoteYaml(part.trim()));
      continue;
    }
    if (NUMERIC_KEYS.has(key)) {
      const n = Number(value);
      out[key] = Number.isFinite(n) ? n : value;
      continue;
    }
    if (BOOLEAN_KEYS.has(key)) {
      out[key] = value === "true";
      continue;
    }
    out[key] = unquoteYaml(value);
  }
  flushList();

  return out as Partial<BookCatalogMeta>;
}

function unquoteYaml(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, "\n").replace(/\\\\/g, "\\");
  }
  return value;
}

/**
 * Заменяет YAML frontmatter в существующем .md файле на новый, не трогая
 * body, evaluator-секцию и image refs. Используется evaluator-queue:
 * после оценки frontmatter перезаписывается с новыми qualityScore и т.п.
 */
export function replaceFrontmatter(markdown: string, newMeta: BookCatalogMeta): string {
  if (!markdown.startsWith("---\n")) return markdown;
  const end = markdown.indexOf("\n---\n", 4);
  if (end === -1) return markdown;
  const body = markdown.slice(end + 5); /* пропустить "\n---\n" */
  return `${buildFrontmatter(newMeta)}\n${body}`;
}

const REASONING_HEADER = "## Evaluator Reasoning";
const REASONING_FOOTER = "<!-- /evaluator-reasoning -->";
const IMAGE_REFS_MARKER = "<!-- Image references (Base64 Data URIs) -->";
const IMAGE_REFS_MARKER_CAS = "<!-- Image references (CAS asset links) -->";
const CHAPTER_RE = /^## (?!Evaluator Reasoning)(.+)$/;

/**
 * Парсит chapters из готового book.md. Возвращает массив `{ title, paragraphs }`.
 * Используется evaluator-queue для построения surrogate-документа без повторного
 * прогона тяжёлого parser'а.
 *
 * Контракт:
 *   - Пропускает frontmatter (`---\n...---\n`)
 *   - Пропускает секцию `## Evaluator Reasoning` (если есть)
 *   - Останавливается на маркере IMAGE_REFS_MARKER (всё после -- Base64)
 *   - Делит body по `## ` заголовкам, параграфы -- блоки между пустыми строками
 */
export function parseBookMarkdownChapters(markdown: string): ConvertedChapter[] {
  if (!markdown.startsWith("---\n")) return [];
  const fmEnd = markdown.indexOf("\n---\n", 4);
  if (fmEnd === -1) return [];
  let rest = markdown.slice(fmEnd + 5);
  /* Отрезаем секцию Evaluator Reasoning если она есть. */
  const reasoningStart = rest.indexOf(`\n${REASONING_HEADER}\n`);
  if (reasoningStart !== -1) {
    const reasoningFooter = rest.indexOf(REASONING_FOOTER, reasoningStart);
    const reasoningEnd = reasoningFooter !== -1
      ? rest.indexOf("\n", reasoningFooter + REASONING_FOOTER.length)
      : -1;
    if (reasoningEnd !== -1) rest = rest.slice(0, reasoningStart) + rest.slice(reasoningEnd);
  }
  /* Отрезаем секцию image refs (Base64 или CAS asset links). */
  let imgIdx = rest.indexOf(IMAGE_REFS_MARKER_CAS);
  if (imgIdx === -1) imgIdx = rest.indexOf(IMAGE_REFS_MARKER);
  if (imgIdx !== -1) {
    const sep = rest.lastIndexOf("\n---\n", imgIdx);
    rest = sep !== -1 ? rest.slice(0, sep) : rest.slice(0, imgIdx);
  }
  /* Разбиваем по `## Title` -- главы. */
  const lines = rest.split(/\r?\n/);
  const chapters: ConvertedChapter[] = [];
  let current: { title: string; lines: string[] } | null = null;
  const flush = (): void => {
    if (!current) return;
    /* Параграфы -- блоки между пустыми строками, очищенные от inline image refs. */
    const text = current.lines.join("\n");
    const paragraphs: string[] = [];
    for (const block of text.split(/\n\s*\n/)) {
      const trimmed = block.trim();
      if (trimmed.length === 0) continue;
      /* Пропускаем чистые ссылки на картинки `![Cover][img-cover]`. */
      if (/^!\[[^\]]*\]\[[^\]]+\]$/.test(trimmed)) continue;
      paragraphs.push(trimmed);
    }
    const wc = paragraphs.reduce((s, p) => s + p.split(/\s+/).filter(Boolean).length, 0);
    chapters.push({ index: chapters.length, title: current.title, paragraphs, wordCount: wc });
    current = null;
  };
  for (const line of lines) {
    const m = CHAPTER_RE.exec(line);
    if (m) {
      flush();
      current = { title: m[1].trim(), lines: [] };
      continue;
    }
    /* Пропускаем `# Title` (заголовок книги) -- он один и не нужен в главах. */
    if (line.startsWith("# ") && !line.startsWith("## ")) continue;
    if (current) current.lines.push(line);
  }
  flush();
  return chapters;
}

/**
 * Перестраивает секцию image refs в markdown с CAS asset URLs.
 * Вызывается из import.ts ПОСЛЕ putBlob (когда img.assetUrl заполнен).
 *
 * Логика:
 *   1. Удаляет старую секцию image refs (если была — от предыдущего прогона).
 *   2. Добавляет новую секцию с bibliary-asset://sha256/... ссылками.
 *   3. Заменяет frontmatter на finalMeta.
 */
export function injectCasImageRefs(markdown: string, images: ImageRef[], meta: BookCatalogMeta): string {
  // Strip existing image refs section (both markers)
  let body = markdown;
  let casIdx = body.indexOf(IMAGE_REFS_MARKER_CAS);
  let oldIdx = casIdx === -1 ? body.indexOf(IMAGE_REFS_MARKER) : casIdx;
  if (oldIdx !== -1) {
    const sep = body.lastIndexOf("\n---\n", oldIdx);
    body = sep !== -1 ? body.slice(0, sep) : body.slice(0, oldIdx);
    body = body.replace(/\n+$/, "\n");
  }

  // Build new refs section
  const refs = buildImageRefs(images);

  // Replace frontmatter with final meta
  const withFm = replaceFrontmatter(`${body}${refs}`, meta);
  return withFm;
}

/**
 * Вставляет (или обновляет) секцию `## Evaluator Reasoning` сразу после
 * frontmatter. Если секция уже есть -- заменяет содержимое целиком, не
 * дублируя. Если эвалюатор не вернул reasoning -- секция полностью
 * удаляется.
 *
 * Идемпотентно: повторный вызов с тем же reasoning не меняет файл.
 */
export function upsertEvaluatorReasoning(markdown: string, reasoning: string | null): string {
  if (!markdown.startsWith("---\n")) return markdown;
  const fmEnd = markdown.indexOf("\n---\n", 4);
  if (fmEnd === -1) return markdown;
  const head = markdown.slice(0, fmEnd + 5); /* до и включая "\n---\n" */
  let rest = markdown.slice(fmEnd + 5);

  /* Если секция уже была -- вырезаем её целиком (с маркером-футером). */
  const oldStart = rest.indexOf(`\n${REASONING_HEADER}\n`);
  if (oldStart !== -1) {
    const oldFooter = rest.indexOf(REASONING_FOOTER, oldStart);
    const oldEnd = oldFooter !== -1
      ? rest.indexOf("\n", oldFooter + REASONING_FOOTER.length)
      : -1;
    if (oldEnd !== -1) rest = rest.slice(0, oldStart) + rest.slice(oldEnd);
  }

  if (reasoning === null || reasoning.trim().length === 0) {
    return head + rest;
  }

  const block = `\n${REASONING_HEADER}\n\n> Chain-of-Thought from the evaluator LLM. Premium dataset asset.\n\n${reasoning.trim()}\n\n${REASONING_FOOTER}\n`;
  return head + block + rest;
}

/**
 * Body Markdown'а: cover как reference-style image, далее главы как
 * `## Title`. Page-gallery (PDF/DJVU page renders) НЕ вкладывается в body —
 * они только засоряли начало книги (см. user feedback от 2026-05-03 и
 * комментарий в `buildBody`).
 */
function buildBody(chapters: ConvertedChapter[], images: ImageRef[]): string {
  const parts: string[] = [];
  const cover = images.find((img) => img.id === "img-cover") ?? null;
  if (cover) parts.push("![Cover][img-cover]\n");
  /* P3 (2026-05-03, user feedback "зачем превью страниц, текст плохо
     отформатирован"): page-gallery (PDF/DJVU page renders) полностью
     убирается из тела book.md. Они только мешали чтению — при этом
     "Открыть оригинал" из reader-toolbar всегда показывает реальный файл.
     Reference-links на gallery-картинки оставляем (могут пригодиться
     внешним инструментам), но в видимый body их не вкладываем. */
  for (const ch of chapters) {
    const title = ch.title.trim() || `Chapter ${ch.index + 1}`;
    parts.push(`## ${title}\n`);
    for (const p of ch.paragraphs) parts.push(`${p}\n`);
  }
  return parts.join("\n");
}

/**
 * Секция reference-links в самом конце файла.
 * Картинки ссылаются через bibliary-asset:// на CAS blobs.
 * Base64 Data URI больше не используются.
 */
function buildImageRefs(images: ImageRef[]): string {
  if (images.length === 0) return "";
  const parts: string[] = ["", "---", "", "<!-- Image references (CAS asset links) -->"];
  for (const img of images) {
    if (img.assetUrl) {
      parts.push(`[${img.id}]: ${img.assetUrl}`);
    }
  }
  if (parts.length <= 4) return "";
  return parts.join("\n") + "\n";
}

/**
 * Главный entry-point. Парсит книгу, извлекает картинки, собирает .md.
 *
 * Performance: для книги в 50 МБ это ~5-15 секунд CPU-работы (PDF render
 * обложки + парсинг). EPUB c 200 картинками -- до 30 секунд (Base64 кодирование
 * больших изображений).
 *
 * Возвращает meta со status='imported' (или 'unsupported' если 0 глав).
 * Эвалюация запускается отдельно через evaluator-queue.
 */
export async function convertBookToMarkdown(
  absFilePath: string,
  opts: ConvertOptions = {},
): Promise<ConvertedBook> {
  const ext = detectExt(absFilePath);
  if (!ext || !SUPPORTED_BOOK_EXTS.has(ext as SupportedBookFormat)) {
    throw new Error(`unsupported book format: ${path.extname(absFilePath)}`);
  }
  const format = ext as SupportedBookFormat;

  const originalFile = path.basename(absFilePath);
  /* SHA-256 — content-hash через streaming (см. sha-stream.ts). Если caller
     уже посчитал sha (для дедупа до парсинга), переиспользуем — не трогаем
     диск второй раз. Иначе считаем сами потоково (без OOM на 500MB книге). */
  const sha256 = opts.precomputedSha256 ?? (await computeFileSha256(absFilePath, opts.signal));

  /* Stage 1 -- text + structure через существующий парсер.
     djvuOcrProvider включает vision-llm путь для DJVU (через локальную LM Studio
     vision-модель — провайдер 'vision-llm' маршрутизирует в parsers/djvu.ts).
     ocrLanguages — хинты для OS-OCR (Ukrainian, Russian и т.д.).
     ocrAccuracy / ocrPdfDpi / djvuRenderDpi — пробрасываются из preferences,
     чтобы UI-настройки качества OCR реально применялись на пути Library import. */
  const ocrAccuracy = opts.ocrAccuracy ?? "accurate";
  const ocrPdfDpi = opts.ocrPdfDpi ?? 400;
  const djvuRenderDpi = opts.djvuRenderDpi ?? 400;
  let parsed = await parseBook(absFilePath, {
    ocrEnabled: opts.ocrEnabled === true,
    ocrAccuracy,
    ocrPdfDpi,
    djvuRenderDpi,
    djvuOcrProvider: opts.djvuOcrProvider,
    ocrLanguages: opts.ocrLanguages,
    visionModelKey: opts.visionModelKey,
    signal: opts.signal,
  });
  /* OCR fallback: если парсер вернул 0 секций, пробуем OCR только когда пользователь
     явно включил OCR. Vision-LLM путь (через role resolver) работает на любой ОС;
     system OCR — только Win/macOS. */
  let ocrAutoRetried = false;
  const ocrPathAvailable = isOcrSupported() || (opts.djvuOcrProvider !== "system" && opts.djvuOcrProvider !== "none");
  if (opts.ocrEnabled === true && parsed.sections.length === 0 && ocrPathAvailable && (format === "pdf" || format === "djvu")) {
    ocrAutoRetried = true;
    parsed = await parseBook(absFilePath, {
      ocrEnabled: true,
      ocrAccuracy,
      ocrPdfDpi,
      djvuRenderDpi,
      djvuOcrProvider: opts.djvuOcrProvider,
      ocrLanguages: opts.ocrLanguages,
      visionModelKey: opts.visionModelKey,
      signal: opts.signal,
    });
    /* Явно фиксируем причину второго прохода — без этого пользователь видит
       только время «парсинг занял Х минут» без понимания почему было так
       долго. Сообщение попадает в book.md frontmatter и в import-log. */
    if (!parsed.metadata.warnings) parsed.metadata.warnings = [];
    parsed.metadata.warnings.push(
      parsed.sections.length > 0
        ? `parser: text layer empty, OCR auto-retry produced ${parsed.sections.length} sections`
        : `parser: text layer empty, OCR auto-retry also returned 0 sections`,
    );
  }
  void ocrAutoRetried;

  const effectiveSections = parsed.sections;

  const chapters: ConvertedChapter[] = effectiveSections.map((sec, i) => {
    const wordsInChapter = sec.paragraphs.reduce((s, p) => s + countWords(p), 0);
    return { index: i, title: sec.title, paragraphs: sec.paragraphs, wordCount: wordsInChapter };
  });
  const totalWords = chapters.reduce((s, ch) => s + ch.wordCount, 0);

  /* Stage 2 -- картинки (CPU, параллельно с возможной GPU-кристаллизацией). */
  const { images, warnings: imgWarnings } = await extractBookImages(absFilePath, format, {
    maxImageBytes: opts.maxImageBytes,
    maxImagesPerBook: opts.maxImagesPerBook,
    signal: opts.signal,
  });

  const allWarnings = [...(parsed.metadata.warnings ?? []), ...imgWarnings];
  const cover = images.find((i) => i.id === "img-cover") ?? null;

  /* Stage 2.5 — ISBN extraction + Online metadata lookup + AI fallback.
     Порядок: ISBN из текста → Open Library → Google Books → AI text fallback.
     Не throws никогда — сетевые ошибки логируются в warnings.
     metadataOnlineLookup === false полностью отключает онлайн-источники, но
     AI fallback по тексту всё равно работает (он локальный, не требует интернета). */
  let isbnMeta: { title?: string; authors?: string[]; year?: number; publisher?: string; language?: string; isbn13?: string } | null = null;
  let extractedIsbn: string | undefined;
  let onlineLookupTried = false;
  let onlineLookupHadResult = false;
  if (opts.metadataOnlineLookup !== false && !opts.signal?.aborted) {
    /* Extract ISBNs from parsed text (first 5 + last 3 pages equivalent). */
    const isbns = extractIsbnsFromSections(parsed.sections);
    /* Also check if parser already found an ISBN in metadata. */
    const metaIsbn = typeof parsed.metadata.identifier === "string" ? parsed.metadata.identifier.replace(/[^\dX]/gi, "") : undefined;
    const candidateIsbn = isbns[0] ?? (metaIsbn && metaIsbn.length === 13 ? metaIsbn : undefined);
    if (candidateIsbn) {
      extractedIsbn = candidateIsbn;
      onlineLookupTried = true;
      /* Hard timeout per lookup: enrichment should never block import for long.
         8 секунд достаточно при наличии интернета; при offline возвращает null
         мгновенно (fetch fails fast), не висит. См. META_FALLBACK_CONFIG. */
      const withTimeout = <T>(p: Promise<T | null>): Promise<T | null> => {
        const timer = new Promise<null>((res) => setTimeout(() => res(null), META_FALLBACK_CONFIG.isbnLookupTimeoutMs));
        return Promise.race([p, timer]).catch(() => null);
      };
      /* Try Open Library first (free, no key needed, good for ru/uk books).
         Iter 13.2 (2026-05-03): success-сообщения "isbn-meta: Open Library
         (ISBN xxx)" и "isbn-meta: Google Books (ISBN xxx)" больше НЕ
         пушатся в warnings — это успех lookup'а, а не warning. Метаданные
         уже отражены в title/author/year книги. Лог должен показывать
         только реальные warnings (failure-случай ниже сохранён). */
      const olResult = await withTimeout(lookupIsbnOpenLibrary(candidateIsbn, opts.signal));
      if (olResult && (olResult.title || olResult.authors?.length)) {
        isbnMeta = olResult;
        onlineLookupHadResult = true;
      } else {
        /* Fallback: Google Books. */
        const gbResult = await withTimeout(lookupIsbnGoogleBooks(candidateIsbn, opts.signal));
        if (gbResult && (gbResult.title || gbResult.authors?.length)) {
          isbnMeta = gbResult;
          onlineLookupHadResult = true;
        } else {
          /* Оба источника промолчали — например при offline или unknown ISBN.
             Это реальный warning — пользователь должен знать что online
             lookup не сработал (могут быть дубликаты, missing meta). */
          allWarnings.push(`isbn-meta: online lookup failed (ISBN ${candidateIsbn}, no internet or both catalogs returned empty)`);
        }
      }
    }
  }

  /* Stage 2.55 — AI text fallback метаданных.
     Когда срабатывает: parsed metadata НЕ содержит title (или title = filename),
     а online lookup НЕ дал результата (offline / book not in catalog / no ISBN).
     Использует роль "crystallizer" из настроек "Модели" (полностью локально). */
  let aiTextMeta: TextMeta | null = null;
  const parsedTitleForFallback = parsed.metadata.title?.trim();
  const parsedTitleIsWeak = !parsedTitleForFallback
    || parsedTitleForFallback.length < META_FALLBACK_CONFIG.titleMinChars
    || parsedTitleForFallback === path.parse(originalFile).name;
  const isbnDataIsWeak = !isbnMeta || (!isbnMeta.title && !isbnMeta.authors?.length);
  const needsAiFallback = parsedTitleIsWeak
    && isbnDataIsWeak
    && !opts.signal?.aborted
    && parsed.sections.length > 0;
  if (needsAiFallback) {
    /* Собираем выборку из первых 2-3 секций (содержит обложку/copyright/intro). */
    const textSample = parsed.sections
      .slice(0, META_FALLBACK_CONFIG.textMetaSampleSections)
      .map((s) => `${s.title}\n${s.paragraphs.join("\n")}`)
      .join("\n\n")
      .slice(0, META_FALLBACK_CONFIG.textMetaSampleChars);
    const aiResult = await extractTextMetaFromBookText(textSample, { signal: opts.signal });
    if (aiResult.ok && aiResult.meta) {
      aiTextMeta = aiResult.meta;
      const fields = Object.keys(aiResult.meta).join(",");
      allWarnings.push(`ai-text-meta: extracted from book text (${fields}) via ${aiResult.model ?? "?"}${onlineLookupTried && !onlineLookupHadResult ? " — used as offline fallback" : ""}`);
    } else if (aiResult.error) {
      allWarnings.push(`ai-text-meta: skipped (${aiResult.error})`);
    }
  }

  /* Stage 2.6 — Vision-meta enrichment через ЛОКАЛЬНУЮ LM Studio vision-модель.
     Opt-in (visionMetaEnabled: false по умолчанию). Используется как ПОСЛЕДНИЙ
     резерв только когда parsed metadata И isbn-meta не дали достаточно данных.
     Никогда не throw — на любой ошибке degrade gracefully. */
  let visionMeta: import("../llm/vision-meta.js").VisionMeta | null = null;
  if (opts.visionMetaEnabled === true && cover && cover.buffer.length > 0) {
    const t0 = Date.now();
    opts.onVisionMetaEvent?.({ phase: "start", message: `Extracting metadata from cover (${cover.buffer.length} bytes, ${cover.mimeType})` });
    const result = await extractMetadataFromCover(cover.buffer, {
      modelKey: opts.visionModelKey,
      mimeType: cover.mimeType,
      signal: opts.signal,
    });
    if (result.ok && result.meta) {
      visionMeta = result.meta;
      allWarnings.push(...(result.warnings ?? []));
      opts.onVisionMetaEvent?.({
        phase: "success",
        durationMs: Date.now() - t0,
        meta: visionMeta,
      });
    } else {
      const msg = `vision-meta failed: ${result.error ?? "unknown"}`;
      allWarnings.push(msg);
      opts.onVisionMetaEvent?.({ phase: "failed", message: msg, durationMs: Date.now() - t0 });
    }
  }

  /* Resolve финальный title/author/year/publisher.
     Приоритет (индустриальный стандарт — детерминированные источники первее LLM):
       1. parsed metadata (PDF Info/XMP, EPUB OPF, FB2 title-info) — структурное, надёжно.
       2. isbn-meta (Open Library / Google Books по ISBN) — верифицировано библиографически.
       3. vision-meta (LM Studio multimodal обложки, opt-in) — высокая точность когда есть.
       4. ai-text-meta (LM Studio crystallizer по тексту первых страниц) — последний AI fallback.
       5. filename — финальный non-AI fallback. */
  const parsedTitle = parsed.metadata.title?.trim();
  const filenameTitle = path.parse(originalFile).name;

  const useVision = visionMeta !== null && visionMeta.confidence >= META_FALLBACK_CONFIG.visionMetaMinConfidence;
  const useIsbn = isbnMeta !== null;
  const useAiText = aiTextMeta !== null;

  const finalTitle = pickBestBookTitle(
    parsedTitle,
    useIsbn ? isbnMeta!.title : undefined,
    useVision ? visionMeta!.title : undefined,
    useAiText ? aiTextMeta!.title : undefined,
    filenameTitle,
  ) ?? filenameTitle;

  const finalAuthor =
    parsed.metadata.author
    ?? (useIsbn ? isbnMeta!.authors?.[0] : undefined)
    ?? (useVision ? visionMeta!.author ?? undefined : undefined)
    ?? (useAiText ? aiTextMeta!.author : undefined);

  const finalYear =
    parsed.metadata.year
    ?? (useIsbn ? isbnMeta!.year : undefined)
    ?? (useVision ? visionMeta!.year ?? undefined : undefined)
    ?? (useAiText ? aiTextMeta!.year : undefined);

  const finalPublisher =
    parsed.metadata.publisher
    ?? (useIsbn ? isbnMeta!.publisher : undefined)
    ?? (useVision ? visionMeta!.publisher ?? undefined : undefined)
    ?? (useAiText ? aiTextMeta!.publisher : undefined);

  if (opts.visionMetaEnabled === true && cover && visionMeta && !useVision) {
    allWarnings.push(`vision-meta incomplete/low-confidence (${visionMeta.confidence}); structured metadata retained where stronger`);
  }

  const status: BookStatus = chapters.length === 0 ? "unsupported" : "imported";

  /* Language detection: чисто-regex, не зависит от LLM и не может упасть.
     Берём выборку из первых 3 глав (до 4096 символов), чтобы покрыть
     предисловие и начало основного текста. Если парсер уже вернул язык в
     metadata — предпочитаем его (metadata-зона точнее для языка издания). */
  let detectedLanguage: string | undefined;
  try {
    const parserLanguage = parsed.metadata.language?.toLowerCase?.();
    if (parserLanguage && parserLanguage !== "unknown") {
      detectedLanguage = parserLanguage;
    } else if (chapters.length > 0) {
      const textSample = chapters
        .slice(0, META_FALLBACK_CONFIG.langDetectChapters)
        .map((ch) => ch.paragraphs.join(" "))
        .join(" ")
        .slice(0, META_FALLBACK_CONFIG.langDetectSampleChars);
      const langResult = detectLanguageByRegex(textSample);
      if (langResult.lang !== "unknown") detectedLanguage = langResult.lang;
    }
  } catch {
    /* Никогда не должно упасть, но страхуемся — детектор не должен ломать импорт. */
  }

  const rawBody = buildBody(chapters, images);

  /* Versator (build-time scientific layout):
     - typograf: «ёлочки», em-dashes, NBSP;
     - callouts: «Внимание:» → стилизованные блоки;
     - definitions: «X — это Y» → <dfn>;
     - sidenotes: footnotes → Tufte-style margin notes;
     - drop caps: первая буква каждой главы;
     - math: $...$ через KaTeX (auto, если в тексте есть формулы).
     Pure-JS, без LLM, без сетевых вызовов. См. layout-pipeline.ts. */
  const layoutLang: "ru" | "en" = detectedLanguage === "en" ? "en" : "ru";
  const layoutResult = applyLayout(rawBody, {
    lang: layoutLang,
    renderMath: shouldRenderMath(rawBody),
  });

  const meta: BookCatalogMeta = {
    id: bookIdFromSha(sha256),
    sha256,
    originalFile,
    originalFormat: format,
    title: finalTitle,
    author: finalAuthor,
    year: finalYear,
    language: detectedLanguage,
    isbn: parsed.metadata.identifier ?? extractedIsbn ?? isbnMeta?.isbn13,
    publisher: finalPublisher,
    wordCount: totalWords,
    chapterCount: chapters.length,
    status,
    warnings: allWarnings.length > 0 ? allWarnings : undefined,
    layoutVersion: layoutResult.version,
  };

  const refs = buildImageRefs(images);
  const markdown = `${buildFrontmatter(meta)}\n\n# ${meta.title}\n\n${layoutResult.md}${refs}`;

  return { meta, chapters, images, markdown };
}
