/**
 * Phase 8e — Chunk cleanup: strip metadata noise before LLM sees content.
 *
 * Цель: «оставить только плод знаний» — убрать всё что не несёт
 * semantic value но потребляет токены + сбивает crystallizer/synthesizer
 * с фокуса.
 *
 * Применяется в bridge'ах ПЕРЕД chunkChapter / sharegpt synthesizer.
 * Pure-функция, no I/O, no LLM — fast, deterministic.
 *
 * Что чистим:
 *   1. Page markers: «— 47 —», «[47]», «Page 47», «p. 47», «47.»
 *      stand-alone строкой.
 *   2. Running headers/footers — короткие строки (<40 chars) которые
 *      повторяются ≥3 раз в одной главе.
 *   3. Copyright/ISBN lines: «© 2015 Doe», «ISBN 978-...», «All rights reserved».
 *   4. Footnote markers: standalone `[1]`, `*`, `†` в конце строки —
 *     удаляем сам маркер, текст оставляем (он часто содержит знание).
 *   5. TOC repeats — если первый chapter содержит >5 коротких строк
 *      которые повторяются буквально дальше в тексте как headings.
 *   6. Empty/short paragraphs (<20 chars без alphanumeric) — phrases
 *      типа «* * *», «———», «Конец главы».
 *
 * Каждый строб — отдельный optional pass; caller выбирает уровень.
 */

const PAGE_MARKER_PATTERNS: RegExp[] = [
  /^[-—–]\s*\d{1,4}\s*[-—–]\s*$/,        // "— 47 —"
  /^\[\s*\d{1,4}\s*\]\s*$/,              // "[47]"
  /^(?:page|p\.|стр\.?|страница)\s*\d{1,4}\s*$/i, // "Page 47" / "стр. 47"
  /^\d{1,4}\s*$/,                        // standalone "47" (only if very short paragraph)
  /^—{2,}\s*\d+\s*—{2,}$/,               // "—— 47 ——"
];

const ISBN_COPYRIGHT_PATTERNS: RegExp[] = [
  /^isbn[\s\-:]?\s*\d/i,
  /^©\s*\d{4}/,
  /^copyright\s*©?\s*\d{4}/i,
  /^all\s+rights\s+reserved/i,
  /^все\s+права\s+защищены/i,
  /^printed\s+in\s+/i,
  /^напечатано\s+в\s+/i,
  /^library\s+of\s+congress/i,
];

const DECORATIVE_PATTERNS: RegExp[] = [
  /^\s*[*•·•⋅★☆◆◇■□▪▫◦‣⁃]\s*[*•·•⋅★☆◆◇■□▪▫◦‣⁃]\s*[*•·•⋅★☆◆◇■□▪▫◦‣⁃]\s*$/,
  /^[-—–_=]{3,}\s*$/,
  /^(?:end of chapter|конец главы|конец|the end|fin)\s*\.?\s*$/i,
];

const FOOTNOTE_MARKER_PATTERN = /(?:^|[\s])(\[\d+\]|†+|‡+|\^?\d+)\s*$/;

export interface ChunkCleanupOptions {
  /** Strip page markers like "— 47 —". Default true. */
  stripPageNumbers?: boolean;
  /** Strip ISBN/copyright lines. Default true. */
  stripBoilerplate?: boolean;
  /** Strip footnote markers at line end. Default true. */
  stripFootnoteMarkers?: boolean;
  /** Detect + remove running headers/footers. Default true.
   *  Triggers только если строка <40 chars и повторяется ≥runningRepeats раз. */
  stripRunningLines?: boolean;
  /** Threshold для running line detection. Default 3. */
  runningRepeats?: number;
  /** Strip "* * *" / "———" / "End of chapter". Default true. */
  stripDecorative?: boolean;
}

const DEFAULT_RUNNING_REPEATS = 3;

/**
 * Strip noise from a chapter's paragraphs array. Возвращает новый array,
 * не мутирует input. Параграфы которые целиком удалены — отбрасываются.
 */
export function cleanChapterParagraphs(
  paragraphs: string[],
  opts: ChunkCleanupOptions = {},
): string[] {
  const stripPage = opts.stripPageNumbers !== false;
  const stripBoil = opts.stripBoilerplate !== false;
  const stripNote = opts.stripFootnoteMarkers !== false;
  const stripRun = opts.stripRunningLines !== false;
  const stripDeco = opts.stripDecorative !== false;
  const runRepeats = opts.runningRepeats ?? DEFAULT_RUNNING_REPEATS;

  /* Step 1: count short-line frequencies для detection running headers. */
  const shortLineFreq = stripRun ? new Map<string, number>() : null;
  if (shortLineFreq) {
    for (const p of paragraphs) {
      const trimmed = p.trim();
      if (trimmed.length > 0 && trimmed.length < 40) {
        shortLineFreq.set(trimmed, (shortLineFreq.get(trimmed) ?? 0) + 1);
      }
    }
  }

  const out: string[] = [];
  for (const para of paragraphs) {
    let trimmed = para.trim();
    if (trimmed.length === 0) continue;

    if (stripPage && PAGE_MARKER_PATTERNS.some((re) => re.test(trimmed))) continue;
    if (stripBoil && ISBN_COPYRIGHT_PATTERNS.some((re) => re.test(trimmed))) continue;
    if (stripDeco && DECORATIVE_PATTERNS.some((re) => re.test(trimmed))) continue;

    if (
      stripRun &&
      shortLineFreq &&
      trimmed.length < 40 &&
      (shortLineFreq.get(trimmed) ?? 0) >= runRepeats
    ) {
      continue;
    }

    if (stripNote) {
      trimmed = trimmed.replace(FOOTNOTE_MARKER_PATTERN, "").trimEnd();
      if (trimmed.length === 0) continue;
    }

    /* Final guard: paragraph должен иметь хотя бы 1 word (letters), не
     * только digits/punctuation. */
    if (!/[\p{L}]/u.test(trimmed)) continue;

    out.push(trimmed);
  }
  return out;
}

/**
 * Convenience: strip noise from a raw text block (after parsing). Splits
 * on blank lines + cleans, returns clean text re-joined.
 */
export function cleanRawText(text: string, opts: ChunkCleanupOptions = {}): string {
  const paragraphs = text.split(/\n{2,}/).map((p) => p.replace(/\n/g, " ").trim());
  const cleaned = cleanChapterParagraphs(paragraphs, opts);
  return cleaned.join("\n\n");
}
