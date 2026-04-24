/**
 * Book → Markdown converter (Pre-flight Evaluation architecture).
 *
 * Превращает любую поддерживаемую книгу в **один** .md файл, содержащий:
 *   1. YAML frontmatter с lean-метаданными (читается SQLite-кэшем при rebuild)
 *   2. Опциональную секцию `## Evaluator Reasoning` с CoT эпистемолога
 *   3. Структурированный текст с заголовками глав
 *   4. Reference links для картинок (Base64 Data URIs в самом конце файла)
 *
 * Контракт читаемости: длинные Base64-строки ВСЕГДА в конце документа,
 * чтобы человек или редактор мог листать главы без зависаний.
 *
 * Контракт CPU/GPU: эта функция -- чистая CPU-задача. Безопасно вызывать
 * параллельно с GPU-кристаллизацией (LM Studio).
 */

import * as path from "path";
import { parseBook, detectExt, type SupportedExt } from "../scanner/parsers/index.js";
import { isOcrSupported } from "../scanner/ocr/index.js";
import { extractBookImages } from "./image-extractors.js";
import { computeFileSha256, bookIdFromSha } from "./sha-stream.js";
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
  // bibliographic
  lines.push(`title: ${escapeYaml(meta.title)}`);
  if (meta.author) lines.push(`author: ${escapeYaml(meta.author)}`);
  if (meta.titleEn) lines.push(`titleEn: ${escapeYaml(meta.titleEn)}`);
  if (meta.authorEn) lines.push(`authorEn: ${escapeYaml(meta.authorEn)}`);
  if (meta.year !== undefined) lines.push(`year: ${meta.year}`);
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
  /* Отрезаем секцию image refs (всё после маркера -- Base64 Data URIs). */
  const imgIdx = rest.indexOf(IMAGE_REFS_MARKER);
  if (imgIdx !== -1) {
    /* Поднимаемся до начала "---" разделителя перед маркером. */
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
 * Body Markdown'а: главы как `## Title`, параграфы разделены пустой
 * строкой. Обложка вставляется в начало body как `![Cover][img-cover]`.
 */
function buildBody(chapters: ConvertedChapter[], hasCover: boolean): string {
  const parts: string[] = [];
  if (hasCover) parts.push("![Cover][img-cover]\n");
  for (const ch of chapters) {
    const title = ch.title.trim() || `Chapter ${ch.index + 1}`;
    parts.push(`## ${title}\n`);
    for (const p of ch.paragraphs) parts.push(`${p}\n`);
  }
  return parts.join("\n");
}

/**
 * Секция reference-links в самом конце файла. Каждая ссылка -- одна длинная
 * строка с Data URI. Разделители-комментарии помогают человеку быстро
 * прыгнуть до начала галереи.
 */
function buildImageRefs(images: ImageRef[]): string {
  if (images.length === 0) return "";
  const parts: string[] = ["", "---", "", "<!-- Image references (Base64 Data URIs) -->"];
  for (const img of images) {
    const b64 = img.buffer.toString("base64");
    parts.push(`[${img.id}]: data:${img.mimeType};base64,${b64}`);
  }
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

  /* Stage 1 -- text + structure через существующий парсер. */
  let parsed = await parseBook(absFilePath, { ocrEnabled: opts.ocrEnabled === true, signal: opts.signal });
  if (parsed.sections.length === 0 && opts.ocrEnabled !== false && isOcrSupported() && (format === "pdf" || format === "djvu")) {
    parsed = await parseBook(absFilePath, { ocrEnabled: true, ocrAccuracy: "accurate", ocrPdfDpi: 200, signal: opts.signal });
  }

  const chapters: ConvertedChapter[] = parsed.sections.map((sec, i) => {
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

  const status: BookStatus = chapters.length === 0 ? "unsupported" : "imported";

  const meta: BookCatalogMeta = {
    id: bookIdFromSha(sha256),
    sha256,
    originalFile,
    originalFormat: format,
    title: parsed.metadata.title?.trim() || path.parse(originalFile).name,
    author: parsed.metadata.author,
    year: parsed.metadata.year,
    isbn: parsed.metadata.identifier,
    publisher: parsed.metadata.publisher,
    wordCount: totalWords,
    chapterCount: chapters.length,
    status,
    warnings: allWarnings.length > 0 ? allWarnings : undefined,
  };

  const body = buildBody(chapters, cover !== null);
  const refs = buildImageRefs(images);
  const markdown = `${buildFrontmatter(meta)}\n\n# ${meta.title}\n\n${body}${refs}`;

  return { meta, chapters, images, markdown };
}
