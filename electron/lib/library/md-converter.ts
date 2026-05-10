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
import { parseBook, detectExt } from "../scanner/parsers/index.js";
import { isOcrSupported } from "../scanner/ocr/index.js";
import { repairParseResultAllStrategies } from "../scanner/text-mojibake-repair.js";
import { extractBookImages } from "./image-extractors.js";
import { computeFileSha256, bookIdFromSha } from "./sha-stream.js";
import { pickBestBookTitle } from "./title-heuristics.js";
import { extractIsbnsFromSections } from "./isbn-extractor.js";
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
  /** Сколько глав берём для language detection. */
  langDetectChapters: 3,
  /** Максимум символов для language detection sample. */
  langDetectSampleChars: 4096,
} as const;

function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/** YAML 1.2 double-quoted style -- безопасно для всех строк. */
function escapeYaml(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

/* `year` добавлен (2026-05-10): buildFrontmatter пишет `year: 1965` без
 * кавычек, parseFrontmatter должен прочитать обратно как number, иначе
 * roundtrip ломается (BookCatalogMeta.year: number). */
const NUMERIC_KEYS: ReadonlySet<string> = new Set([
  "wordCount",
  "chapterCount",
  "qualityScore",
  "conceptualDensity",
  "originality",
  "conceptsExtracted",
  "conceptsAccepted",
  "layoutVersion",
  "year",
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
    return value.slice(1, -1)
      .replace(/\\\\/g, "\u0000")
      .replace(/\\"/g, '"')
      .replace(/\\n/g, "\n")
      .replace(/\u0000/g, "\\");
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
 * Iter 14.4 (2026-05-04, /imperor — H11 fix): найти НАЧАЛО блока image-refs
 * чтобы безопасно отрезать его при перезаписи.
 *
 * Раньше использовался `body.lastIndexOf("\n---\n", imgIdx)` — ловил ЛЮБОЙ
 * `\n---\n` перед маркером. Если в книге есть Markdown-разделитель сцен
 * `---` (валидный element в CommonMark), всё после него обрезалось,
 * УНИЧТОЖАЯ контент книги при reimport обложки.
 *
 * Новая логика: ищем точную последовательность `\n\n---\n\n<MARKER>\n`,
 * которая создаётся только `buildImageRefs`. Если маркер найден без такой
 * рамки (legacy книги) — возвращаем позицию маркера и полагаемся на
 * caller'a, который не отрежет тело ниже маркера.
 *
 * @returns индекс позиции `\n` ПЕРЕД `\n---\n\n<MARKER>` или -1 если
 *          маркер вообще не найден.
 */
function findImageRefsBlockStart(body: string): number {
  const cas = body.indexOf(IMAGE_REFS_MARKER_CAS);
  const old = body.indexOf(IMAGE_REFS_MARKER);
  const imgIdx = cas !== -1 ? cas : old;
  if (imgIdx === -1) return -1;

  /* Ищем ровно ту разделительную последовательность, что генерирует
   * buildImageRefs: `\n---\n\n<MARKER>` (двойной перенос строки между
   * `---` и комментарием). Это уникальная подпись image-refs блока. */
  const marker = cas !== -1 ? IMAGE_REFS_MARKER_CAS : IMAGE_REFS_MARKER;
  const exact = `\n---\n\n${marker}`;
  const exactIdx = body.lastIndexOf(exact, imgIdx);
  if (exactIdx !== -1) return exactIdx;

  /* Fallback для legacy-книг без двойного переноса: `\n---\n<MARKER>`. */
  const legacy = `\n---\n${marker}`;
  const legacyIdx = body.lastIndexOf(legacy, imgIdx);
  if (legacyIdx !== -1) return legacyIdx;

  /* Маркер есть, но без `---` рамки → отрезаем только сам маркер
   * и всё после него, не трогая контент выше. */
  return -2; /* sentinel: «есть imgIdx но нет фрейма — отрезай по imgIdx» */
}

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
  /* Отрезаем секцию image refs (Base64 или CAS asset links).
   * H11 fix: используем findImageRefsBlockStart с точной подписью маркера,
   * чтобы не порезать книгу по случайному `---` Markdown-разделителю. */
  const imgBlockStart = findImageRefsBlockStart(rest);
  if (imgBlockStart >= 0) {
    rest = rest.slice(0, imgBlockStart);
  } else if (imgBlockStart === -2) {
    /* Маркер найден без `---` рамки — отрезаем только маркер и ниже. */
    const cas = rest.indexOf(IMAGE_REFS_MARKER_CAS);
    const old = rest.indexOf(IMAGE_REFS_MARKER);
    const imgIdx = cas !== -1 ? cas : old;
    if (imgIdx !== -1) rest = rest.slice(0, imgIdx);
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
  /* H11 fix (2026-05-04, /imperor): раньше `lastIndexOf("\n---\n", oldIdx)`
   * мог поймать ЛЮБОЙ Markdown-разделитель `---` в теле книги (валидный
   * CommonMark scene-break) и отрезать всё после него — катастрофа для UX
   * (пол-книги теряется при reimport обложки). Новая логика ищет точную
   * сигнатуру блока image-refs (см. findImageRefsBlockStart). */
  let body = markdown;
  const blockStart = findImageRefsBlockStart(body);
  if (blockStart >= 0) {
    body = body.slice(0, blockStart);
    body = body.replace(/\n+$/, "\n");
  } else if (blockStart === -2) {
    /* Legacy-вариант: маркер без `---` рамки — отрезаем строго от маркера. */
    const cas = body.indexOf(IMAGE_REFS_MARKER_CAS);
    const old = body.indexOf(IMAGE_REFS_MARKER);
    const imgIdx = cas !== -1 ? cas : old;
    if (imgIdx !== -1) {
      body = body.slice(0, imgIdx).replace(/\n+$/, "\n");
    }
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
  const canOcr = opts.ocrEnabled === true;
  const ocrPathAvailable = isOcrSupported() || (opts.djvuOcrProvider !== "system" && opts.djvuOcrProvider !== "none");
  const ocrRetriable = canOcr && ocrPathAvailable && (format === "pdf" || format === "djvu");

  let parsed = await parseBook(absFilePath, {
    ocrEnabled: ocrRetriable ? false : canOcr,
    ocrAccuracy,
    ocrPdfDpi,
    djvuRenderDpi,
    djvuMaxBytes: opts.djvuMaxFileSizeMb ? opts.djvuMaxFileSizeMb * 1024 * 1024 : undefined,
    djvuOcrProvider: opts.djvuOcrProvider,
    ocrLanguages: opts.ocrLanguages,
    visionOcrModel: opts.visionOcrModel,
    signal: opts.signal,
  });
  let allRepairs = repairParseResultAllStrategies(parsed);
  parsed = allRepairs.parsed;

  let ocrAutoRetried = false;
  // Only retry with OCR when:
  //   a) text layer is empty (no sections), OR
  //   b) classifyTextProblem returned "ocr_confusion" (PDF glyph garble that
  //      encoding repairs could not fix).
  // "encoding_garble" is intentionally excluded: encoding repairs already fixed it,
  // so an OCR retry would produce the same broken result as the original (same font map).
  const shouldRetryOcr = ocrRetriable
    && (parsed.sections.length === 0 || allRepairs.problem === "ocr_confusion");

  if (shouldRetryOcr) {
    ocrAutoRetried = true;
    parsed = await parseBook(absFilePath, {
      ocrEnabled: true,
      ocrAccuracy,
      ocrPdfDpi,
      djvuRenderDpi,
      djvuOcrProvider: opts.djvuOcrProvider,
      ocrLanguages: opts.ocrLanguages,
      visionOcrModel: opts.visionOcrModel,
      signal: opts.signal,
    });
    allRepairs = repairParseResultAllStrategies(parsed);
    parsed = allRepairs.parsed;
    /* Record the reason for the second pass so the user sees it in import logs. */
    if (!parsed.metadata.warnings) parsed.metadata.warnings = [];
    let retryWarning: string;
    if (allRepairs.problem === "ocr_confusion") {
      retryWarning = `parser: text layer had OCR/glyph garble, OCR auto-retry produced ${parsed.sections.length} sections`;
    } else if (parsed.sections.length > 0) {
      retryWarning = `parser: text layer empty, OCR auto-retry produced ${parsed.sections.length} sections`;
    } else {
      retryWarning = `parser: text layer empty, OCR auto-retry also returned 0 sections`;
    }
    parsed.metadata.warnings.push(retryWarning);
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

  /* Stage 2.5 — ISBN extraction (local only). */
  let extractedIsbn: string | undefined;
  {
    const isbns = extractIsbnsFromSections(parsed.sections);
    const metaIsbn = typeof parsed.metadata.identifier === "string" ? parsed.metadata.identifier.replace(/[^\dX]/gi, "") : undefined;
    extractedIsbn = isbns[0] ?? (metaIsbn && (metaIsbn.length === 13 || metaIsbn.length === 10) ? metaIsbn : undefined);
  }

  /* Stage 2.55 — AI text fallback метаданных.
     Когда: parsed metadata слабые (нет title / title = filename).
     Использует роль "crystallizer" из настроек "Модели" (полностью локально). */
  let aiTextMeta: TextMeta | null = null;
  const parsedTitleForFallback = parsed.metadata.title?.trim();
  const parsedTitleIsWeak = !parsedTitleForFallback
    || parsedTitleForFallback.length < META_FALLBACK_CONFIG.titleMinChars
    || parsedTitleForFallback === path.parse(originalFile).name;
  const needsAiFallback = parsedTitleIsWeak
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
      allWarnings.push(`ai-text-meta: extracted from book text (${fields}) via ${aiResult.model ?? "?"}`);
    } else if (aiResult.error) {
      allWarnings.push(`ai-text-meta: skipped (${aiResult.error})`);
    }
  }

  /* Resolve final title/author/year/publisher.
     Priority (local sources only):
       1. parsed metadata (PDF Info/XMP, EPUB OPF, FB2 title-info).
       2. ai-text-meta (LM Studio crystallizer from first pages).
       3. filename -- final non-AI fallback. */
  const parsedTitle = parsed.metadata.title?.trim();
  const filenameTitle = path.parse(originalFile).name;

  const useAiText = aiTextMeta !== null;

  const finalTitle = pickBestBookTitle(
    parsedTitle,
    undefined,
    undefined,
    useAiText ? aiTextMeta!.title : undefined,
    filenameTitle,
  ) ?? filenameTitle;

  const finalAuthor =
    parsed.metadata.author
    ?? (useAiText ? aiTextMeta!.author : undefined);

  const finalYear =
    parsed.metadata.year
    ?? (useAiText ? aiTextMeta!.year : undefined);

  const finalPublisher =
    parsed.metadata.publisher
    ?? (useAiText ? aiTextMeta!.publisher : undefined);

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

  const meta: BookCatalogMeta = {
    id: bookIdFromSha(sha256),
    sha256,
    originalFile,
    originalFormat: format,
    title: finalTitle,
    author: finalAuthor,
    year: finalYear,
    language: detectedLanguage,
    isbn: parsed.metadata.identifier ?? extractedIsbn,
    publisher: finalPublisher,
    wordCount: totalWords,
    chapterCount: chapters.length,
    status,
    warnings: allWarnings.length > 0 ? allWarnings : undefined,
  };

  const refs = buildImageRefs(images);
  const markdown = `${buildFrontmatter(meta)}\n\n${rawBody}${refs}`;

  return { meta, chapters, images, markdown };
}
