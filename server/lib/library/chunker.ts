/**
 * Structural chunker — Phase 6d MVP без embedder-based drift detection.
 *
 * Делит главу на чанки 300..1500 слов, режет по subheadings и пустым
 * блокам-разделителям. НЕ использует cosine similarity (нет embedder
 * в server/ до Phase 7) — но для большинства книг structural split
 * даёт sensible chunks; thematic drift лишь optimization.
 *
 * Когда embedder подъедет в server/lib/embedder/, можно поднять
 * `electron/lib/dataset-v2/semantic-chunker.ts` целиком и заменить
 * structural-only путь.
 */

import type { ExtractorInputChunk } from "../../../shared/llm/extractor-schema.js";

export interface ChapterChunkInput {
  /** Plain text paragraphs (frontmatter stripped, no markdown headings). */
  paragraphs: string[];
  /** Used only for context — chunk не несёт chapterTitle сам. */
  chapterTitle?: string;
}

export interface ChunkerOptions {
  /** Желаемый размер чанка в словах. По умолчанию 1000. */
  targetWords?: number;
  /** Жёсткий cap. По умолчанию 1500. */
  maxWords?: number;
  /** Минимум — меньше слов → склейка с соседом. По умолчанию 300. */
  minWords?: number;
  /** Сколько финальных параграфов из предыдущего чанка дублировать. По умолчанию 1. */
  overlapParagraphs?: number;
}

const DEFAULT_TARGET = 1000;
const DEFAULT_MAX = 1500;
const DEFAULT_MIN = 300;
const DEFAULT_OVERLAP = 1;

const HEADING_RE = /^(#{1,4}\s|глава\s|раздел\s|часть\s|chapter\s|section\s|part\s)/i;
const SEPARATOR_RE = /^(\*{3,}|_{3,}|-{3,}|={3,})$/;

function wordsOf(text: string): number {
  return text.split(/\s+/u).filter(Boolean).length;
}

function totalWords(paragraphs: string[]): number {
  let s = 0;
  for (const p of paragraphs) s += wordsOf(p);
  return s;
}

/**
 * Структурный split по подзаголовкам — внутри блоков параграфы остаются
 * последовательными, на границах блоков разрывается chunk.
 */
function splitByHeadings(paragraphs: string[]): string[][] {
  const blocks: string[][] = [];
  let current: string[] = [];
  for (const raw of paragraphs) {
    const p = raw.trim();
    if (!p) {
      if (current.length > 0) {
        blocks.push(current);
        current = [];
      }
      continue;
    }
    const isHeading = HEADING_RE.test(p) && wordsOf(p) < 15;
    const isSeparator = SEPARATOR_RE.test(p);
    if (isHeading || isSeparator) {
      if (current.length > 0) {
        blocks.push(current);
        current = [];
      }
      /* Heading body не теряется — он становится первым параграфом
       * следующего блока (если LLM хочет узнать заголовок). */
      if (isHeading) current.push(p);
      continue;
    }
    current.push(p);
  }
  if (current.length > 0) blocks.push(current);
  return blocks;
}

/**
 * Группирует блоки в чанки size-target. Если блок сам по себе > maxWords,
 * режется по предложениям; если < minWords, склеивается с соседом.
 */
function packBlocksIntoChunks(
  blocks: string[][],
  opts: Required<ChunkerOptions>,
): string[][] {
  const chunks: string[][] = [];
  let buffer: string[] = [];
  let bufferWords = 0;

  for (const block of blocks) {
    const bw = totalWords(block);
    /* Очень большой блок — режем по параграфам ровно по targetWords. */
    if (bw > opts.maxWords) {
      if (buffer.length > 0) {
        chunks.push(buffer);
        buffer = [];
        bufferWords = 0;
      }
      chunks.push(...splitLargeBlock(block, opts.targetWords));
      continue;
    }
    /* Если буфер + блок ≤ maxWords — копим. Иначе flush + начинаем новый. */
    if (bufferWords + bw <= opts.maxWords) {
      buffer.push(...block);
      bufferWords += bw;
    } else {
      if (buffer.length > 0) {
        chunks.push(buffer);
      }
      buffer = [...block];
      bufferWords = bw;
    }
    /* Если буфер достиг target — flush и начнём заново. */
    if (bufferWords >= opts.targetWords) {
      chunks.push(buffer);
      buffer = [];
      bufferWords = 0;
    }
  }
  if (buffer.length > 0) chunks.push(buffer);

  /* Подметаем хвосты < minWords: склеиваем с предыдущим chunk. */
  return mergeTinyChunks(chunks, opts.minWords);
}

function splitLargeBlock(paragraphs: string[], targetWords: number): string[][] {
  const chunks: string[][] = [];
  let buffer: string[] = [];
  let count = 0;
  for (const p of paragraphs) {
    const w = wordsOf(p);
    if (count + w > targetWords && buffer.length > 0) {
      chunks.push(buffer);
      buffer = [];
      count = 0;
    }
    buffer.push(p);
    count += w;
  }
  if (buffer.length > 0) chunks.push(buffer);
  return chunks;
}

function mergeTinyChunks(chunks: string[][], minWords: number): string[][] {
  if (chunks.length <= 1) return chunks;
  const out: string[][] = [];
  for (const c of chunks) {
    if (out.length === 0) {
      out.push(c);
      continue;
    }
    const prev = out[out.length - 1];
    if (totalWords(c) < minWords) {
      prev.push(...c);
    } else {
      out.push(c);
    }
  }
  return out;
}

function applyOverlap(chunks: string[][], overlap: number): string[][] {
  if (overlap <= 0 || chunks.length <= 1) return chunks;
  const out: string[][] = [chunks[0]];
  for (let i = 1; i < chunks.length; i++) {
    const prev = chunks[i - 1];
    const tail = prev.slice(Math.max(0, prev.length - overlap));
    out.push([...tail, ...chunks[i]]);
  }
  return out;
}

/**
 * Главный вход: chapter paragraphs → ExtractorInputChunk[].
 *
 * partN индексация 1-based (matches `electron/lib/dataset-v2/types.ts`
 * SemanticChunk.partN semantics).
 */
export function chunkChapter(
  input: ChapterChunkInput,
  opts: ChunkerOptions = {},
): ExtractorInputChunk[] {
  const merged: Required<ChunkerOptions> = {
    targetWords: opts.targetWords ?? DEFAULT_TARGET,
    maxWords: opts.maxWords ?? DEFAULT_MAX,
    minWords: opts.minWords ?? DEFAULT_MIN,
    overlapParagraphs: opts.overlapParagraphs ?? DEFAULT_OVERLAP,
  };

  const filtered = input.paragraphs.filter((p) => p.trim().length > 0);
  if (filtered.length === 0) return [];

  const totalWordsCount = totalWords(filtered);
  /* Если глава целиком меньше maxWords — один чанк, без split. */
  if (totalWordsCount <= merged.maxWords) {
    return [
      {
        partN: 1,
        text: filtered.join("\n\n"),
      },
    ];
  }

  const blocks = splitByHeadings(filtered);
  const packed = packBlocksIntoChunks(blocks, merged);
  const withOverlap = applyOverlap(packed, merged.overlapParagraphs);

  return withOverlap.map((paragraphs, i) => ({
    partN: i + 1,
    text: paragraphs.join("\n\n"),
  }));
}

/**
 * Helper для bridge: режет полный markdown книги на главы (по H1/H2),
 * возвращает {chapterTitle, paragraphs[]} per chapter. Frontmatter
 * (между --- ... ---) пропускается.
 */
export interface ChapterBlock {
  chapterTitle: string;
  paragraphs: string[];
}

const FRONTMATTER_RE = /^---\n[\s\S]*?\n---\n/;
const CHAPTER_HEADING_RE = /^(#{1,2})\s+(.+)$/m;

export function splitMarkdownIntoChapters(markdown: string): ChapterBlock[] {
  const cleaned = markdown.replace(FRONTMATTER_RE, "").trim();
  if (cleaned.length === 0) return [];

  const lines = cleaned.split(/\r?\n/);
  const chapters: ChapterBlock[] = [];
  /* "Body" — дефолт чтобы no-headings markdown создавал один сензимый
   * pseudo-chapter, не "Untitled". */
  let currentTitle = "Body";
  let currentParas: string[] = [];
  let buffer: string[] = [];

  const flushBuffer = (): void => {
    const para = buffer.join(" ").trim();
    if (para) currentParas.push(para);
    buffer = [];
  };
  const flushChapter = (): void => {
    flushBuffer();
    if (currentParas.length > 0) {
      chapters.push({ chapterTitle: currentTitle, paragraphs: currentParas });
    }
    currentParas = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();
    const headingMatch = trimmed.match(/^(#{1,2})\s+(.+)$/);
    if (headingMatch) {
      flushChapter();
      currentTitle = headingMatch[2].trim();
      continue;
    }
    if (trimmed === "") {
      flushBuffer();
    } else {
      buffer.push(trimmed);
    }
  }
  flushChapter();

  /* Если split не нашёл ни одного H1/H2 — вся книга = один pseudo-chapter. */
  if (chapters.length === 0 && cleaned) {
    const paragraphs = cleaned
      .split(/\n{2,}/)
      .map((p) => p.replace(/\n/g, " ").trim())
      .filter(Boolean);
    if (paragraphs.length > 0) {
      chapters.push({ chapterTitle: "Body", paragraphs });
    }
  }
  return chapters;
}

void CHAPTER_HEADING_RE; // kept for grep — regex source documentation
