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
 * Чанки < SAFE_LIMIT слов не режутся вообще. Лимит снижен до 1500 слов
 * для более гранулярной нарезки — локальная LLM лучше держит фокус
 * на коротких фрагментах.
 */

import type { BookSection } from "../scanner/parsers/index.js";
import type { SemanticChunk } from "./types.js";
/* AUDIT MED-1: параграфы книги — это passages, а не queries.
   E5-семейство (`multilingual-e5-small`) обучено на разных префиксах
   "query: " (retrieval-side) и "passage: " (corpus-side); смешивание
   снижает cosine similarity между концептуально близкими параграфами
   на ~5–8 пунктов F1 → ложные drift-границы и битые чанки. */
import { embedPassage } from "../embedder/shared.js";

/** Максимум слов, при котором блок отдаётся LLM целиком без разрезания. */
const SAFE_LIMIT = 1500;

/** Минимальный размер для самостоятельного чанка. Меньше — склеиваем с соседом. */
const MIN_CHUNK_WORDS = 300;

/** Порог падения cosine similarity для детекции тематического сдвига. */
const DRIFT_THRESHOLD = 0.45;

/** Hard cap на чанк когда drift-границ нет. */
const HARD_SPLIT_LIMIT = 2500;

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

function mergeSmallBlocks(
  blocks: Array<{ heading: string; paragraphs: string[] }>,
  minWords: number,
  safeLimit: number,
): Array<{ heading: string; paragraphs: string[] }> {
  const merged: Array<{ heading: string; paragraphs: string[] }> = [];
  let current: { heading: string; paragraphs: string[] } | null = null;

  const flush = (): void => {
    if (current && current.paragraphs.length > 0) merged.push(current);
    current = null;
  };

  for (const block of blocks) {
    const blockWords = wordsOf(block.paragraphs);
    if (!current) {
      current = { heading: block.heading, paragraphs: [...block.paragraphs] };
      if (blockWords >= minWords) flush();
      continue;
    }

    const currentWords = wordsOf(current.paragraphs);
    const canMerge = currentWords < minWords || currentWords + blockWords <= safeLimit;
    if (canMerge) {
      current.paragraphs.push(...block.paragraphs);
      if (wordsOf(current.paragraphs) >= minWords) flush();
    } else {
      flush();
      current = { heading: block.heading, paragraphs: [...block.paragraphs] };
      if (blockWords >= minWords) flush();
    }
  }
  flush();

  return merged;
}

/* ───────────────── Step 2: Thematic drift detection ───────────────── */

/**
 * Находит индексы параграфов, после которых происходит тематический сдвиг.
 * Использует e5-small embeddings: embed каждый параграф, считает cosine
 * similarity между соседями, ищет «долины» ниже DRIFT_THRESHOLD.
 */
/** Hard cap, чтобы один монстр-блок не зажал embed-pipeline на минуты. */
const MAX_PARAGRAPHS_FOR_DRIFT = 800;

async function findThematicBoundaries(
  paragraphs: string[],
  signal?: AbortSignal,
  driftTh: number = DRIFT_THRESHOLD,
  maxPara: number = MAX_PARAGRAPHS_FOR_DRIFT,
): Promise<number[]> {
  if (paragraphs.length < 3) return [];
  if (maxPara <= 0) return [];
  if (paragraphs.length > maxPara) return [];

  let vectors: number[][];
  try {
    vectors = [];
    for (let i = 0; i < paragraphs.length; i++) {
      if (signal?.aborted) throw new Error("chunker aborted");
      vectors.push(await embedPassage(paragraphs[i].slice(0, 500)));
    }
  } catch (e) {
    if (e instanceof Error && e.message === "chunker aborted") throw e;
    console.warn(`[chunker] embedPassage failed, falling back to hard-split: ${e instanceof Error ? e.message : e}`);
    return [];
  }

  const boundaries: number[] = [];
  for (let i = 0; i < vectors.length - 1; i++) {
    const sim = cosine(vectors[i], vectors[i + 1]);
    if (sim < driftTh) {
      boundaries.push(i);
    }
  }
  return boundaries;
}

/**
 * Разделяет большой блок по тематическим границам. Если границ нет — режет
 * по hard-limit (HARD_SPLIT_LIMIT), чтобы не отдавать огромные блоки в LLM.
 */
async function splitByThematicDrift(
  paragraphs: string[],
  signal?: AbortSignal,
  driftTh: number = DRIFT_THRESHOLD,
  maxPara: number = MAX_PARAGRAPHS_FOR_DRIFT,
): Promise<string[][]> {
  const boundaries = await findThematicBoundaries(paragraphs, signal, driftTh, maxPara);

  if (boundaries.length === 0) {
    const hardLimit = HARD_SPLIT_LIMIT;
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
    if (boundarySet.has(i) || wordsOf(buf) >= HARD_SPLIT_LIMIT) {
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
  safeLimit?: number;
  minChunkWords?: number;
  driftThreshold?: number;
  maxParagraphsForDrift?: number;
  overlapParagraphs?: number;
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
  const minWords = args.minChunkWords ?? MIN_CHUNK_WORDS;
  const driftTh = args.driftThreshold ?? DRIFT_THRESHOLD;
  const maxParaDrift = args.maxParagraphsForDrift ?? MAX_PARAGRAPHS_FOR_DRIFT;
  const overlap = args.overlapParagraphs ?? OVERLAP_PARAGRAPHS;

  if (section.paragraphs.length === 0) {
    console.log(`[chunker] ch${chapterIndex} "${section.title}" — 0 paragraphs, skipping`);
    return [];
  }

  console.log(`[chunker] ch${chapterIndex} "${section.title}" — ${section.paragraphs.length} paras, ${wordsOf(section.paragraphs)} words (safe=${safeLimit} min=${minWords})`);

  const structuralBlocks = splitByHeadings(section.paragraphs, section.title);
  console.log(`[chunker]   structural blocks: ${structuralBlocks.length}`);
  const rawChunks: Array<{ heading: string; paragraphs: string[] }> = [];

  for (const block of structuralBlocks) {
    const bw = wordsOf(block.paragraphs);

    if (bw <= safeLimit) {
      rawChunks.push(block);
      continue;
    }

    console.log(`[chunker]   block "${block.heading}" too big (${bw} words), splitting by drift...`);
    const subChunks = await splitByThematicDrift(block.paragraphs, args.signal, driftTh, maxParaDrift);
    console.log(`[chunker]   → ${subChunks.length} sub-chunks`);
    for (const sub of subChunks) {
      rawChunks.push({ heading: block.heading, paragraphs: sub });
    }
  }

  const mergedChunks = mergeSmallBlocks(rawChunks, minWords, safeLimit);
  if (mergedChunks.length !== rawChunks.length) {
    console.log(`[chunker]   merged small chunks: ${rawChunks.length} → ${mergedChunks.length}`);
  }

  const filtered = mergedChunks.filter((c) => wordsOf(c.paragraphs) >= minWords);
  if (filtered.length === 0 && rawChunks.length > 0) {
    const largest = [...mergedChunks].sort((a, b) => wordsOf(b.paragraphs) - wordsOf(a.paragraphs))[0];
    console.log(`[chunker]   no chunks reached minWords (${minWords}), keeping largest fallback`);
    if (largest) filtered.push(largest);
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

  console.log(`[chunker] ch${chapterIndex} result: ${chunks.length} chunks [${chunks.map(c => c.wordCount + "w").join(", ")}]`);
  return applyContextOverlap(chunks, overlap);
}
