/**
 * Surrogate Document Builder — строит "Структурный Дистиллят" книги для LLM.
 *
 * Контракт алгоритма (определён продуктом):
 *   1. Каркас (TOC):           полное оглавление по главам
 *   2. Тезис (Intro):          первые ~1000 слов текста
 *   3. Синтез (Outro):         последние ~1000 слов текста
 *   4. Узловые срезы (Nodal):  первые 2 параграфа из 3-5 самых длинных глав
 *
 * Цель: ~3000-4000 слов вместо 100k+. Эпистемолог-LLM получает ровно тот
 * минимум, по которому может корректно оценить концептуальную ценность.
 *
 * Чистая CPU-функция, безопасна для параллельного запуска с GPU.
 */

import type { ConvertedChapter, SurrogateDocument } from "./types.js";

const TARGET_INTRO_WORDS = 1000;
const TARGET_OUTRO_WORDS = 1000;
const MIN_NODAL_CHAPTERS = 3;
const MAX_NODAL_CHAPTERS = 5;
const NODAL_PARAGRAPHS_PER_CHAPTER = 2;
const MAX_TOC_CHAPTERS = 240;
const MAX_NODAL_PARAGRAPH_WORDS = 250;
const META_ZONE_LINES = 40;
const MAX_META_ZONE_HITS = 20;

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

function takeWordSlice(text: string, maxWords: number, fromEnd = false): string {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return text;
  const slice = fromEnd ? words.slice(-maxWords) : words.slice(0, maxWords);
  return `${slice.join(" ")} […]`;
}

/**
 * Берёт первые N слов из массива параграфов. OCR/PDF-парсеры иногда отдают
 * гигантский "параграф" на десятки тысяч слов, поэтому первый блок тоже
 * жёстко обрезается, иначе surrogate превышает context window LM Studio.
 */
function takeFirstWords(paragraphs: string[], targetWords: number): { text: string; words: number } {
  const acc: string[] = [];
  let words = 0;
  for (const p of paragraphs) {
    if (words >= targetWords && acc.length > 0) break;
    const pWords = wordCount(p);
    if (pWords > targetWords - words) {
      acc.push(takeWordSlice(p, Math.max(1, targetWords - words)));
      words = targetWords;
      break;
    }
    acc.push(p);
    words += pWords;
  }
  return { text: acc.join("\n\n"), words };
}

/** Берёт последние N слов: симметрично takeFirstWords, но с конца. */
function takeLastWords(paragraphs: string[], targetWords: number): { text: string; words: number } {
  const acc: string[] = [];
  let words = 0;
  for (let i = paragraphs.length - 1; i >= 0; i--) {
    if (words >= targetWords && acc.length > 0) break;
    const p = paragraphs[i];
    const pWords = wordCount(p);
    if (pWords > targetWords - words) {
      acc.unshift(takeWordSlice(p, Math.max(1, targetWords - words), true));
      words = targetWords;
      break;
    }
    acc.unshift(p);
    words += pWords;
  }
  return { text: acc.join("\n\n"), words };
}

/** Сплющивает все параграфы всех глав в один линейный массив. */
function flattenParagraphs(chapters: ConvertedChapter[]): string[] {
  const out: string[] = [];
  for (const ch of chapters) {
    for (const p of ch.paragraphs) {
      const trimmed = p.trim();
      if (trimmed.length > 0) out.push(trimmed);
    }
  }
  return out;
}

/**
 * Extracts a "Metadata Zone" — lines likely to contain author, year, ISBN,
 * publisher, copyright. Sources: first/last N lines of full text (title page
 * and colophon) + grep for bibliographic patterns anywhere in the text.
 */
const META_PATTERNS = [
  /(?:copyright|©)\s*.{2,80}/i,
  /isbn[\s:\-]*[\dxX\-]{10,17}/i,
  /\b(?:author|автор|by)\s*[:：]\s*.{2,60}/i,
  /\b(?:published|издательство|publisher|press|verlag|видавництво|видавець|друкарня)\s*[:：]?\s*.{2,60}/i,
  /\b(?:edition|издание|год\s*издания|year|рік\s*видання|видання|накладом)\s*[:：]?\s*\d{4}/i,
  /\b(?:19|20)\d{2}\s*(?:г\.?|год|year|edition|р\.?|рік|року)/i,
];

function buildMetadataZone(chapters: ConvertedChapter[]): string {
  const allLines: string[] = [];
  for (const ch of chapters) {
    for (const p of ch.paragraphs) {
      for (const line of p.split(/\n/)) {
        const t = line.trim();
        if (t.length > 0) allLines.push(t);
      }
    }
  }
  if (allLines.length === 0) return "";

  const seen = new Set<string>();
  const hits: string[] = [];
  const MAX_LINE_LEN = 200;

  const headLines = allLines.slice(0, META_ZONE_LINES).filter((l) => l.length <= MAX_LINE_LEN);
  const tailLines = allLines.slice(-META_ZONE_LINES).filter((l) => l.length <= MAX_LINE_LEN);
  for (const line of [...headLines, ...tailLines]) {
    if (!seen.has(line)) { seen.add(line); hits.push(line); }
  }

  for (const line of allLines) {
    if (hits.length >= headLines.length + tailLines.length + MAX_META_ZONE_HITS) break;
    if (seen.has(line) || line.length > MAX_LINE_LEN) continue;
    if (META_PATTERNS.some((rx) => rx.test(line))) {
      seen.add(line);
      hits.push(line);
    }
  }

  return hits.length > 0 ? hits.join("\n") : "";
}

/** Строит TOC: одна строка на главу `N. Название`. */
function buildToc(chapters: ConvertedChapter[]): string {
  if (chapters.length === 0) return "(no chapters detected)";
  const indexed = chapters.map((ch, i) => ({ ch, i }));
  const visible = indexed.length <= MAX_TOC_CHAPTERS
    ? indexed
    : [
        ...indexed.slice(0, Math.floor(MAX_TOC_CHAPTERS * 0.75)),
        ...indexed.slice(-(MAX_TOC_CHAPTERS - Math.floor(MAX_TOC_CHAPTERS * 0.75))),
      ];
  const lines = visible.map(({ ch, i }) => {
    const title = (ch.title ?? "").trim() || `Chapter ${i + 1}`;
    return `${i + 1}. ${title} (${ch.wordCount.toLocaleString("en-US")} words)`;
  });
  if (visible.length < indexed.length) {
    const omitted = indexed.length - visible.length;
    lines.splice(Math.floor(MAX_TOC_CHAPTERS * 0.75), 0, `... (${omitted.toLocaleString("en-US")} chapters omitted from oversized TOC)`);
  }
  return lines.join("\n");
}

/** Возвращает индексы 3-5 самых "толстых" глав, исключая first/last (они уже в Intro/Outro). */
function pickNodalChapterIndices(chapters: ConvertedChapter[]): number[] {
  if (chapters.length <= 2) return [];
  /* Кандидаты -- все главы кроме первой и последней. Сортируем по wordCount. */
  const candidates = chapters
    .map((ch, idx) => ({ idx, words: ch.wordCount }))
    .filter((c) => c.idx !== 0 && c.idx !== chapters.length - 1)
    .sort((a, b) => b.words - a.words);
  const target = Math.min(MAX_NODAL_CHAPTERS, Math.max(MIN_NODAL_CHAPTERS, Math.floor(chapters.length / 4)));
  return candidates.slice(0, target).map((c) => c.idx).sort((a, b) => a - b);
}

/** Строит "узловой срез" одной главы: первые 2 непустых параграфа. */
function buildNodalSlice(chapter: ConvertedChapter): { text: string; paragraphs: number; words: number } {
  const live = chapter.paragraphs.map((p) => p.trim()).filter((p) => p.length > 0);
  const slice = live
    .slice(0, NODAL_PARAGRAPHS_PER_CHAPTER)
    .map((p) => takeWordSlice(p, MAX_NODAL_PARAGRAPH_WORDS));
  const text = slice.join("\n\n");
  return { text, paragraphs: slice.length, words: wordCount(text) };
}

/**
 * Главный entry-point. Возвращает текст-суррогат + метаданные о его сборке.
 *
 * Если книга совсем тощая (например, < 1500 слов всего) -- возвращает её
 * полностью без дистилляции, чтобы эпистемолог не работал с обрубками.
 */
export function buildSurrogate(chapters: ConvertedChapter[]): SurrogateDocument {
  const total = chapters.reduce((s, ch) => s + ch.wordCount, 0);

  if (total === 0) {
    return {
      surrogate: "[empty book]",
      composition: { tocChapters: 0, introWords: 0, outroWords: 0, nodalSlices: [], totalWords: 0 },
    };
  }

  /* Маленькие книги (< 1.5x intro+outro target) -- скармливаем целиком. */
  if (total < (TARGET_INTRO_WORDS + TARGET_OUTRO_WORDS) * 1.5) {
    const fullText = chapters
      .map((ch, i) => {
        const title = ch.title.trim() || `Chapter ${i + 1}`;
        return `## ${title}\n\n${ch.paragraphs.join("\n\n")}`;
      })
      .join("\n\n");
    return {
      surrogate: `# Table of Contents\n${buildToc(chapters)}\n\n# Full Text (book is too small for distillation)\n\n${fullText}`,
      composition: { tocChapters: chapters.length, introWords: total, outroWords: 0, nodalSlices: [], totalWords: total },
    };
  }

  const metaZone = buildMetadataZone(chapters);

  const flat = flattenParagraphs(chapters);
  const intro = takeFirstWords(flat, TARGET_INTRO_WORDS);
  const outro = takeLastWords(flat, TARGET_OUTRO_WORDS);

  const nodalIdx = pickNodalChapterIndices(chapters);
  const nodal = nodalIdx.map((idx) => {
    const slice = buildNodalSlice(chapters[idx]);
    const title = chapters[idx].title.trim() || `Chapter ${idx + 1}`;
    return { title, ...slice };
  });

  const parts: string[] = [];
  if (metaZone.length > 0) {
    parts.push("# Metadata Zone (title page, colophon, copyright, ISBN — scan for author & year)", metaZone, "");
  }
  parts.push("# Table of Contents", buildToc(chapters), "");
  parts.push("# Introduction (first ~1000 words)", intro.text, "");
  parts.push("# Conclusion (last ~1000 words)", outro.text, "");
  if (nodal.length > 0) {
    parts.push("# Nodal Slices (opening paragraphs of the longest chapters)");
    for (const n of nodal) {
      parts.push(`## ${n.title}`, n.text, "");
    }
  }

  const surrogate = parts.join("\n").trim();
  const surrogateWords = wordCount(surrogate);

  return {
    surrogate,
    composition: {
      tocChapters: chapters.length,
      introWords: intro.words,
      outroWords: outro.words,
      nodalSlices: nodal.map((n) => ({ chapter: n.title, paragraphs: n.paragraphs, words: n.words })),
      totalWords: surrogateWords,
    },
  };
}
