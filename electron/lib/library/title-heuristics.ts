const NOISE_BOOK_TITLES = new Set([
  "предисловие",
  "введение",
  "оглавление",
  "содержание",
  "об авторе",
  "об авторх",
  "об авторах",
  "about the author",
  "about the authors",
  "contents",
  "table of contents",
  "foreword",
  "preface",
  "introduction",
  "copyright",
  "colophon",
  "title page",
]);

const STRUCTURAL_TITLE_RE = /^(?:chapter|section|page|глава|раздел|страница)\s+[0-9ivxlcdm]+$/iu;

function normalizeTitleCandidate(value: string): string {
  return value
    .trim()
    .replace(/^[\s"'`([{]+|[\s"'`)\].,:;!?]+$/gu, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

export function isLowValueBookTitle(value: string | null | undefined): boolean {
  if (!value || !value.trim()) return true;
  const normalized = normalizeTitleCandidate(value);
  if (!normalized) return true;
  return NOISE_BOOK_TITLES.has(normalized) || STRUCTURAL_TITLE_RE.test(normalized);
}

export function pickBestBookTitle(...candidates: Array<string | null | undefined>): string | undefined {
  let fallback: string | undefined;
  for (const candidate of candidates) {
    const trimmed = candidate?.trim();
    if (!trimmed) continue;
    fallback ??= trimmed;
    if (!isLowValueBookTitle(trimmed)) {
      return trimmed;
    }
  }
  return fallback;
}
