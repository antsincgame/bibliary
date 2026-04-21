/**
 * Stage 1 — Топологический чанкер.
 *
 * Три уровня нарезки (от структурного к семантическому):
 *
 *   1. **Structural split** — режет по подзаголовкам (H2/H3/H4), разделителям,
 *      пустым строкам-блоками. Уважает авторскую архитектуру книги.
 *
 *   2. **Thematic drift** — если блок слишком большой (>SAFE_LIMIT слов),
 *      ищет «долины» косинусного сходства между соседними параграфами
 *      через e5-small embeddings. Разрезает в точках тематического сдвига,
 *      а не по механическому счётчику слов.
 *
 *   3. **Context overlap** — последний параграф предыдущего чанка дублируется
 *      в начало следующего как «крючок», чтобы LLM не теряла связность.
 *
 * Чанки < SAFE_LIMIT слов не режутся вообще — Qwen3.6 35B с 32k контекстом
 * легко обрабатывает 4000 слов без «lost in the middle».
 */

import type { BookSection } from "../scanner/parsers/index.js";
import type { SemanticChunk } from "./types.js";
import { embedQuery } from "../rag/index.js";

/** Максимум слов, при котором блок отдаётся LLM целиком без разрезания. */
const SAFE_LIMIT = 4000;

/** Минимальный размер для самостоятельного чанка. Меньше — склеиваем с соседом. */
const MIN_CHUNK_WORDS = 300;

/** Порог падения cosine similarity для детекции тематического сдвига. */
const DRIFT_THRESHOLD = 0.45;

/** Сколько «overlap»-параграфов дублировать на стыке. */
const OVERLAP_PARAGRAPHS = 1;

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

function wordsOf(paragraphs: string[]): number {
  return paragraphs.reduce((s, p) => s + wordCount(p), 0);
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/* ───────────────── Step 1: Structural split by headings ───────────────── */

interface StructuralBlock {
  heading: string;
  paragraphs: string[];
}

const HEADING_RE = /^(#{1,4}\s|глава\s|раздел\s|часть\s|chapter\s|section\s|part\s)/i;
const SEPARATOR_RE = /^(\*{3,}|_{3,}|-{3,}|={3,})$/;

/**
 * Разделяет параграфы главы по подзаголовкам и разделителям.
 * Если в тексте нет подзаголовков — возвращает один блок на всю главу.
 */
function splitByHeadings(paragraphs: string[], sectionTitle: string): StructuralBlock[] {
  const blocks: StructuralBlock[] = [];
  let current: StructuralBlock = { heading: sectionTitle, paragraphs: [] };

  for (const p of paragraphs) {
    const trimmed = p.trim();
    if (!trimmed) continue;

    const isHeading = HEADING_RE.test(trimmed) && wordCount(trimmed) < 15;
    const isSeparator = SEPARATOR_RE.test(trimmed);

    if (isHeading || isSeparator) {
      if (current.paragraphs.length > 0) blocks.push(current);
      current = { heading: isHeading ? trimmed : current.heading, paragraphs: [] };
      continue;
    }
    current.paragraphs.push(trimmed);
  }
  if (current.paragraphs.length > 0) blocks.push(current);

  return blocks.length > 0 ? blocks : [{ heading: sectionTitle, paragraphs: [...paragraphs].filter((p) => p.trim()) }];
}

/* ───────────────── Step 2: Thematic drift detection ───────────────── */

/**
 * Находит индексы параграфов, после которых происходит тематический сдвиг.
 * Использует e5-small embeddings: embed каждый параграф, считает cosine
 * similarity между соседями, ищет «долины» ниже DRIFT_THRESHOLD.
 */
/** Hard cap, чтобы один монстр-блок не зажал embed-pipeline на минуты. */
const MAX_PARAGRAPHS_FOR_DRIFT = 800;

async function findThematicBoundaries(paragraphs: string[], signal?: AbortSignal): Promise<number[]> {
  if (paragraphs.length < 3) return [];
  /* Длинные блоки → пропускаем embed-проход; падаем на hard-limit fallback. */
  if (paragraphs.length > MAX_PARAGRAPHS_FOR_DRIFT) return [];

  const vectors: number[][] = [];
  for (let i = 0; i < paragraphs.length; i++) {
    if (signal?.aborted) throw new Error("chunker aborted");
    vectors.push(await embedQuery(paragraphs[i].slice(0, 500)));
  }

  const boundaries: number[] = [];
  for (let i = 0; i < vectors.length - 1; i++) {
    const sim = cosine(vectors[i], vectors[i + 1]);
    if (sim < DRIFT_THRESHOLD) {
      boundaries.push(i);
    }
  }
  return boundaries;
}

/**
 * Разделяет большой блок по тематическим границам. Если границ нет — режет
 * по hard-limit (SAFE_LIMIT * 1.5), чтобы не отдавать 10k слов в LLM.
 */
async function splitByThematicDrift(paragraphs: string[], signal?: AbortSignal): Promise<string[][]> {
  const boundaries = await findThematicBoundaries(paragraphs, signal);

  if (boundaries.length === 0) {
    const hardLimit = Math.floor(SAFE_LIMIT * 1.5);
    const result: string[][] = [];
    let buf: string[] = [];
    for (const p of paragraphs) {
      buf.push(p);
      if (wordsOf(buf) >= hardLimit) {
        result.push(buf);
        buf = [];
      }
    }
    if (buf.length > 0) result.push(buf);
    return result;
  }

  const boundarySet = new Set(boundaries);
  const result: string[][] = [];
  let buf: string[] = [];
  for (let i = 0; i < paragraphs.length; i++) {
    buf.push(paragraphs[i]);
    if (boundarySet.has(i) || wordsOf(buf) >= SAFE_LIMIT * 1.5) {
      result.push(buf);
      buf = [];
    }
  }
  if (buf.length > 0) result.push(buf);
  return result;
}

/* ───────────────── Step 3: Context overlap ───────────────── */

function applyContextOverlap(chunks: SemanticChunk[], overlapN: number): SemanticChunk[] {
  if (overlapN <= 0 || chunks.length < 2) return chunks;

  for (let i = 1; i < chunks.length; i++) {
    const prevParagraphs = chunks[i - 1].text.split("\n\n");
    const hook = prevParagraphs.slice(-overlapN).join("\n\n").trim();
    if (hook.length > 20) {
      chunks[i].overlapText = hook;
    }
  }
  return chunks;
}

/* ───────────────── Public API ───────────────── */

export interface ChunkChapterArgs {
  section: BookSection;
  chapterIndex: number;
  bookTitle: string;
  bookSourcePath: string;
  /** Override safe limit (default 4000 words). */
  safeLimit?: number;
  /** Прокидывается в embed-цикл — отмена между параграфами. */
  signal?: AbortSignal;
}

/**
 * Топологическая нарезка главы:
 *   1. splitByHeadings → structural blocks
 *   2. for each block > safeLimit → findThematicBoundaries → split at drift valleys
 *   3. applyContextOverlap → hook paragraphs on seams
 */
export async function chunkChapter(args: ChunkChapterArgs): Promise<SemanticChunk[]> {
  const { section, chapterIndex, bookTitle, bookSourcePath } = args;
  const safeLimit = args.safeLimit ?? SAFE_LIMIT;

  if (section.paragraphs.length === 0) return [];

  const structuralBlocks = splitByHeadings(section.paragraphs, section.title);
  const rawChunks: Array<{ heading: string; paragraphs: string[] }> = [];

  for (const block of structuralBlocks) {
    const bw = wordsOf(block.paragraphs);

    if (bw <= safeLimit) {
      rawChunks.push(block);
      continue;
    }

    const subChunks = await splitByThematicDrift(block.paragraphs, args.signal);
    for (const sub of subChunks) {
      rawChunks.push({ heading: block.heading, paragraphs: sub });
    }
  }

  const filtered = rawChunks.filter((c) => wordsOf(c.paragraphs) >= MIN_CHUNK_WORDS);
  if (filtered.length === 0 && rawChunks.length > 0) {
    filtered.push(...rawChunks);
  }

  const partTotal = filtered.length;
  const chunks: SemanticChunk[] = filtered.map((c, i) => {
    const text = c.paragraphs.join("\n\n").trim();
    return {
      text,
      breadcrumb: JSON.stringify({
        bookTitle,
        chapter: `${chapterIndex + 1}: ${section.title}`,
        subHeading: c.heading !== section.title ? c.heading : undefined,
        part: `${i + 1}/${partTotal}`,
      }),
      partN: i + 1,
      partTotal,
      chapterIndex,
      chapterTitle: section.title,
      bookTitle,
      bookSourcePath,
      wordCount: wordCount(text),
    };
  });

  return applyContextOverlap(chunks, OVERLAP_PARAGRAPHS);
}

/** Exported for testing. */
export const __testing__ = { splitByHeadings, findThematicBoundaries, cosine, wordCount, wordsOf };
