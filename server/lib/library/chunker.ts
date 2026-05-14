/**
 * Structural chunker — делит главу на чанки 300..1500 слов, режет по
 * subheadings и пустым блокам-разделителям. НЕ использует cosine
 * similarity для drift detection: для подавляющего большинства книг
 * structural split даёт sensible chunks, а thematic drift — marginal
 * refinement, не correctness issue. Embedder в server/lib/embedder/
 * есть, но он зарезервирован под retrieval, не под chunk boundaries.
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
 *
 * Phase Δa: implemented as a flattening wrapper around the richer
 * splitMarkdownIntoSections() — keeps existing callers/tests working
 * while the topological pipeline migrates to Sections.
 */
export interface ChapterBlock {
  chapterTitle: string;
  paragraphs: string[];
}

const FRONTMATTER_RE = /^---\n[\s\S]*?\n---\n/;

/**
 * Phase Δa — full hierarchy-aware split. Each Section carries its
 * heading depth, local title, breadcrumb path from H1 → its own level,
 * and the paragraphs that live BEFORE the next heading at any depth.
 *
 * Why not just keep flat chapters?
 *   - Author-given structure (Part / Chapter / Section / Subsection) is
 *     free signal. Treating H3+ as paragraph text discards the most
 *     reliable topology hint a book provides.
 *   - Section.order is a stable monotonic index for prev/next sibling
 *     traversal (sqlite chunks.prev_id, chunks.next_id wires).
 *   - Section.pathTitles is the breadcrumb used by the crystallizer
 *     prompt: "Part II > Chapter 7 > Section 3" disambiguates duplicate
 *     subsection titles across a book.
 *
 * Level 0 = leading text BEFORE any heading. Useful when a book opens
 * with an unmarked preface/abstract.
 */
export interface Section {
  level: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  title: string;
  pathTitles: string[];
  order: number;
  paragraphs: string[];
}

export function splitMarkdownIntoSections(markdown: string): Section[] {
  const out: Section[] = [];
  for (const s of iterateMarkdownSections(markdown)) out.push(s);
  return out;
}

/**
 * Streaming variant of splitMarkdownIntoSections — yields one Section
 * at a time. Caller can process and discard each section without
 * accumulating the whole array. Peak RAM for chunker output drops
 * from O(book) to O(largest-section). The input `markdown` string
 * itself is still fully loaded (Appwrite SDK doesn't expose a true
 * Readable stream), but downstream allocations stay bounded.
 *
 * Used by extractor-bridge to process units lazily and let GC reclaim
 * each unit's intermediate arrays before the next unit's are
 * allocated.
 */
export function* iterateMarkdownSections(markdown: string): Generator<Section> {
  const cleaned = markdown.replace(FRONTMATTER_RE, "").trim();
  if (cleaned.length === 0) return;

  let level: Section["level"] = 0;
  let title = "";
  let pathStack: string[] = [];
  let paragraphs: string[] = [];
  let buffer: string[] = [];
  let order = 0;
  let sawAnySection = false;

  let lineStart = 0;
  /* Walk the markdown one line at a time without materializing the
   * full `lines` array. `lastIndexOf("\n")` would be O(n) per call;
   * we hand-roll the scanner. */
  for (let i = 0; i <= cleaned.length; i++) {
    if (i !== cleaned.length && cleaned.charCodeAt(i) !== 10 /* \n */) continue;
    const rawLine = cleaned.slice(lineStart, i);
    /* Strip a trailing \r if present (Windows newlines). */
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    lineStart = i + 1;

    const trimmed = line.trim();
    const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      /* Flush current open section. */
      const para = buffer.join(" ").trim();
      if (para) paragraphs.push(para);
      buffer = [];
      if (paragraphs.length > 0 || level > 0) {
        order += 1;
        sawAnySection = true;
        yield {
          level,
          title,
          pathTitles: [...pathStack],
          order,
          paragraphs,
        };
      }
      paragraphs = [];

      const newLevel = headingMatch[1].length as Section["level"];
      const newTitle = headingMatch[2].trim();
      pathStack = pathStack.slice(0, newLevel - 1);
      pathStack.push(newTitle);
      level = newLevel;
      title = newTitle;
      continue;
    }
    if (trimmed === "") {
      const para = buffer.join(" ").trim();
      if (para) paragraphs.push(para);
      buffer = [];
    } else {
      buffer.push(trimmed);
    }
  }
  /* Flush trailing section. */
  const trailingPara = buffer.join(" ").trim();
  if (trailingPara) paragraphs.push(trailingPara);
  if (paragraphs.length > 0 || level > 0) {
    order += 1;
    sawAnySection = true;
    yield {
      level,
      title,
      pathTitles: [...pathStack],
      order,
      paragraphs,
    };
  }

  /* No-heading fallback: emit single body section. We have to walk
   * `cleaned` again with a different paragraph rule (split on blank
   * lines, not headings) so the test for "plain text → one body" stays
   * back-compat. Falls back rarely so the double-walk is fine. */
  if (!sawAnySection) {
    const paras = cleaned
      .split(/\n{2,}/)
      .map((p) => p.replace(/\n/g, " ").trim())
      .filter(Boolean);
    if (paras.length > 0) {
      yield {
        level: 0,
        title: "",
        pathTitles: [],
        order: 1,
        paragraphs: paras,
      };
    }
  }
}

/**
 * Back-compat: flatten Sections to ChapterBlock[]. We collapse H1/H2
 * boundaries (matches legacy behaviour); deeper H3+ headings get
 * folded into their parent section's paragraphs as plain "## Title"
 * lines so existing chunker heuristics still split on them.
 */
export function splitMarkdownIntoChapters(markdown: string): ChapterBlock[] {
  const sections = splitMarkdownIntoSections(markdown);
  if (sections.length === 0) return [];

  const chapters: ChapterBlock[] = [];
  let current: ChapterBlock | null = null;
  for (const s of sections) {
    if (s.level <= 2) {
      if (current) chapters.push(current);
      current = {
        chapterTitle: s.title || "Body",
        paragraphs: [...s.paragraphs],
      };
    } else if (current) {
      if (s.title) current.paragraphs.push(`${"#".repeat(s.level)} ${s.title}`);
      current.paragraphs.push(...s.paragraphs);
    } else {
      /* Stray H3+ before any H1/H2 — start an implicit Body chapter. */
      current = { chapterTitle: "Body", paragraphs: [...s.paragraphs] };
    }
  }
  if (current) chapters.push(current);
  return chapters;
}

/**
 * Phase Δa — section-aware chunker. Produces chunks that carry their
 * full hierarchy breadcrumb. Each Section is chunked INDEPENDENTLY so
 * we never silently merge text across a heading boundary.
 *
 * partN: 1-based position within the owning Section.
 * partOf: total chunks in that Section (lets prompt say "part 3 of 5").
 */
export interface SectionAwareChunk extends ExtractorInputChunk {
  pathTitles: string[];
  sectionLevel: number;
  sectionOrder: number;
  partN: number;
  partOf: number;
}

export function chunkSections(
  sections: Section[],
  opts: ChunkerOptions = {},
): SectionAwareChunk[] {
  const out: SectionAwareChunk[] = [];
  for (const s of sections) {
    if (s.paragraphs.length === 0) continue;
    const local = chunkChapter({ paragraphs: s.paragraphs, chapterTitle: s.title }, opts);
    for (let i = 0; i < local.length; i++) {
      out.push({
        partN: local[i].partN,
        text: local[i].text,
        pathTitles: s.pathTitles,
        sectionLevel: s.level,
        sectionOrder: s.order,
        partOf: local.length,
      });
    }
  }
  return out;
}

/**
 * Phase Δa — group sections into "extraction units". A unit starts at
 * every H1/H2 (or the leading level-0 preface) and absorbs all H3+
 * descendants up to the next H1/H2. This keeps LLM cost equal to
 * legacy per-chapter extraction while preserving full hierarchy on
 * every emitted chunk.
 */
export interface ExtractionUnit {
  /** Display title for the unit: H1/H2 heading, or "Body" for level 0. */
  thesisTitle: string;
  /** Breadcrumb of the unit's ROOT section (H1 > H2). H3+ live inside. */
  rootPath: string[];
  /** Heading level of the root (0/1/2). */
  rootLevel: 0 | 1 | 2;
  /** Stable order of the root section. */
  rootOrder: number;
  /** The root section + all its H3+ descendants in document order. */
  sections: Section[];
}

export function groupSectionsForExtraction(sections: Iterable<Section>): ExtractionUnit[] {
  const out: ExtractionUnit[] = [];
  for (const u of iterateExtractionUnits(sections)) out.push(u);
  return out;
}

/**
 * Streaming variant of groupSectionsForExtraction — yields a fully
 * assembled ExtractionUnit each time a new H1/H2 (or EOF) closes the
 * previous one. Peak RAM is bounded by a single unit's sections array,
 * not the whole book. Used in conjunction with iterateMarkdownSections
 * so the extractor-bridge can process and discard each unit before the
 * next is materialized.
 */
export function* iterateExtractionUnits(
  sections: Iterable<Section>,
): Generator<ExtractionUnit> {
  let current: ExtractionUnit | null = null;
  for (const s of sections) {
    if (s.level <= 2) {
      if (current) yield current;
      current = {
        thesisTitle: s.title || "Body",
        rootPath: s.pathTitles.length > 0 ? [...s.pathTitles] : [],
        rootLevel: s.level as 0 | 1 | 2,
        rootOrder: s.order,
        sections: [s],
      };
    } else if (current) {
      current.sections.push(s);
    } else {
      /* Stray H3+ before any H1/H2 — implicit Body unit. */
      current = {
        thesisTitle: "Body",
        rootPath: [],
        rootLevel: 0,
        rootOrder: s.order,
        sections: [s],
      };
    }
  }
  if (current) yield current;
}
