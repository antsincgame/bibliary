/**
 * Path Sanitizer — строгая санитизация имён файлов и папок для Windows.
 *
 * Гарантии:
 *   - Никаких \/:*?"<>| и управляющих символов
 *   - Никаких зарезервированных имён Windows (CON, PRN, NUL, ...)
 *   - Unicode NFC нормализация, пробелы → _
 *   - Сегмент ≤ MAX_SEGMENT_LEN символов
 *   - Полный путь ≤ MAX_PATH_LEN символов (с fallback на короткое имя)
 *   - Транслитерация запрещена: оригинальные символы сохраняются
 */

import * as path from "path";

const MAX_SEGMENT_LEN = 50;
const MAX_PATH_LEN = 240;

const FORBIDDEN_RE = /[\\/:*?"<>|]/g;
const CONTROL_RE = /[\u0000-\u001F\u007F]/g;
const RESERVED_NAMES = new Set([
  "CON", "PRN", "AUX", "NUL",
  "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
  "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
]);

export function sanitizeSegment(raw: string): string {
  let s = raw.normalize("NFC");
  s = s.replace(FORBIDDEN_RE, "");
  s = s.replace(CONTROL_RE, "");
  s = s.replace(/\.\./g, ".");
  s = s.trim();
  s = s.replace(/^\.+/, "").replace(/\.+$/, "");
  s = s.trim();
  s = s.replace(/\s+/g, "_");

  if (s.length === 0) s = "_unnamed";

  const base = s.replace(/\.[^.]+$/, "");
  if (RESERVED_NAMES.has(base.toUpperCase())) {
    s = `_${s}`;
  }

  if (s.length > MAX_SEGMENT_LEN) {
    s = s.slice(0, MAX_SEGMENT_LEN).replace(/_+$/, "");
    if (s.length === 0) s = "_unnamed";
  }

  return s;
}

export interface HumanBookPath {
  language: string;
  domain: string;
  authorFolder: string;
  /** Back-compat alias for older callers/tests. Now equals authorFolder. */
  folderName: string;
  mdFileName: string;
  relPath: string;
}

export function buildHumanBookPath(opts: {
  /** ISO-ish language segment; fallback "unknown". */
  language?: string;
  /** Domain/sphere segment; fallback "unsorted". */
  domain?: string;
  /** Back-compat: old caller passes sphere; treated as domain. */
  sphere?: string;
  author?: string;
  title: string;
  bookIdShort: string;
}): HumanBookPath {
  const language = sanitizeSegment(opts.language || "unknown");
  const domain = sanitizeSegment(opts.domain || opts.sphere || "unsorted");
  const titleSeg = sanitizeSegment(opts.title || "Untitled");
  let authorFolder: string;
  if (opts.author && opts.author.trim().length > 0) {
    authorFolder = sanitizeSegment(opts.author);
  } else {
    authorFolder = "unknown_author";
  }

  const mdFileName = `${titleSeg}.md`;
  const relPath = path.join(language, domain, authorFolder, mdFileName);

  return { language, domain, authorFolder, folderName: authorFolder, mdFileName, relPath };
}

export function resolveWithMaxPathGuard(
  libraryRoot: string,
  humanPath: HumanBookPath,
  bookIdShort: string,
): { bookDir: string; mdPath: string; relPath: string } {
  const fullMdPath = path.join(libraryRoot, humanPath.relPath);

  if (fullMdPath.length <= MAX_PATH_LEN) {
    const bookDir = path.join(libraryRoot, humanPath.language, humanPath.domain, humanPath.authorFolder);
    return { bookDir, mdPath: fullMdPath, relPath: humanPath.relPath };
  }

  const budget = MAX_PATH_LEN - libraryRoot.length - 20;
  const maxSeg = Math.max(8, Math.floor(budget / 4));
  const shortLanguage = humanPath.language.slice(0, Math.max(2, Math.min(maxSeg, 12)));
  const shortDomain = humanPath.domain.slice(0, maxSeg);
  const shortAuthor = humanPath.authorFolder.slice(0, maxSeg);
  const shortMdFile = `${bookIdShort}.md`;
  const shortRel = path.join(shortLanguage, shortDomain, shortAuthor, shortMdFile);
  const bookDir = path.join(libraryRoot, shortLanguage, shortDomain, shortAuthor);
  return { bookDir, mdPath: path.join(libraryRoot, shortRel), relPath: shortRel };
}

export function extractSphereFromImportPath(filePath: string, importRoot: string): string {
  const rel = path.relative(importRoot, filePath);
  const parts = rel.split(path.sep).filter(Boolean);
  if (parts.length <= 1) return "unsorted";
  return sanitizeSegment(parts[0]);
}

export async function resolveCollisionSuffix(
  bookDir: string,
  fs: { access(p: string): Promise<void> },
): Promise<string> {
  try {
    await fs.access(bookDir);
  } catch {
    return bookDir;
  }
  for (let i = 2; i <= 99; i++) {
    const candidate = `${bookDir}-${i}`;
    try {
      await fs.access(candidate);
    } catch {
      return candidate;
    }
  }
  return `${bookDir}-${Date.now()}`;
}

export { MAX_SEGMENT_LEN, MAX_PATH_LEN };
