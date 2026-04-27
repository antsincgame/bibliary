/**
 * ISBN extraction from plain text (first pages + last pages of a parsed book).
 *
 * Strategy:
 *   1. Look for explicit "ISBN" label followed by digits/dashes/X — most reliable.
 *   2. Regex-scan for bare 13-digit sequences starting with 978/979.
 *   3. Validate with ISBN-13 check digit (Modulo 10 / Luhn-like).
 *   4. Normalise to digits-only string.
 *
 * Non-goals:
 *   - ISBN-10 validation (these are converted to ISBN-13 by online sources anyway).
 *   - Fetching metadata (done by lookup clients after extraction).
 */

/** Regex matching an ISBN-13 (97[89] + 10 more digits, optional separators). */
const ISBN13_RE = /(?:isbn[-\s]?(?:13)?[:.\s]?\s*)?(97[89][\s-]?(?:\d[\s-]?){9}\d)/gi;

/** Regex for ISBN-10 (10 digits, last may be X). */
const ISBN10_RE = /(?:isbn[-\s]?(?:10)?[:.\s]?\s*)?((?:\d[\s-]?){9}[\dX])/gi;

function stripNonDigits(raw: string): string {
  return raw.replace(/[^\dX]/gi, "").toUpperCase();
}

function validateIsbn13(digits: string): boolean {
  if (digits.length !== 13) return false;
  if (!/^97[89]/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    const d = Number(digits[i]);
    sum += i % 2 === 0 ? d : d * 3;
  }
  const check = (10 - (sum % 10)) % 10;
  return check === Number(digits[12]);
}

function validateIsbn10(digits: string): boolean {
  if (digits.length !== 10) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    const d = Number(digits[i]);
    if (isNaN(d)) return false;
    sum += d * (10 - i);
  }
  const last = digits[9] === "X" ? 10 : Number(digits[9]);
  sum += last;
  return sum % 11 === 0;
}

/** Convert ISBN-10 to ISBN-13 (prefix 978, recalc check digit). */
function isbn10to13(isbn10digits: string): string {
  const core = "978" + isbn10digits.slice(0, 9);
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    sum += Number(core[i]) * (i % 2 === 0 ? 1 : 3);
  }
  const check = (10 - (sum % 10)) % 10;
  return core + check;
}

/**
 * Extract up to `maxResults` valid ISBN-13 strings (digits only, no separators)
 * from arbitrary text. Prefers ISBN-13 candidates; converts valid ISBN-10.
 */
export function extractIsbns(text: string, maxResults = 3): string[] {
  const found = new Set<string>();

  // Pass 1 – ISBN-13 patterns
  for (const match of text.matchAll(ISBN13_RE)) {
    const digits = stripNonDigits(match[1] ?? "");
    if (digits.length === 13 && validateIsbn13(digits)) {
      found.add(digits);
      if (found.size >= maxResults) return [...found];
    }
  }

  // Pass 2 – ISBN-10 patterns (convert to 13)
  for (const match of text.matchAll(ISBN10_RE)) {
    const raw = stripNonDigits(match[1] ?? "");
    if (raw.length === 10 && validateIsbn10(raw)) {
      const as13 = isbn10to13(raw);
      if (validateIsbn13(as13)) {
        found.add(as13);
        if (found.size >= maxResults) return [...found];
      }
    }
  }

  return [...found];
}

/**
 * Extract ISBNs from parsed book sections (sections = array of paragraphs).
 * Scans the first `headPages` paragraphs + last `tailPages` paragraphs only.
 * Each page is approximated as ~50 paragraphs.
 */
export function extractIsbnsFromSections(
  sections: Array<{ paragraphs: string[] }>,
  opts: { headPages?: number; tailPages?: number; maxResults?: number } = {},
): string[] {
  const { headPages = 5, tailPages = 3, maxResults = 3 } = opts;

  const parasPerPage = 50;
  const headLimit = headPages * parasPerPage;
  const tailLimit = tailPages * parasPerPage;

  const allParas: string[] = sections.flatMap((s) => s.paragraphs);

  const headText = allParas.slice(0, headLimit).join(" ");
  const tailText =
    allParas.length > headLimit
      ? allParas.slice(Math.max(headLimit, allParas.length - tailLimit)).join(" ")
      : "";

  return extractIsbns(headText + " " + tailText, maxResults);
}
