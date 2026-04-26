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
  sphere: string;
  folderName: string;
  mdFileName: string;
  relPath: string;
}

export function buildHumanBookPath(opts: {
  sphere: string;
  author?: string;
  title: string;
  bookIdShort: string;
}): HumanBookPath {
  const sphere = sanitizeSegment(opts.sphere || "unsorted");
  const titleSeg = sanitizeSegment(opts.title || "Untitled");

  let folderName: string;
  if (opts.author && opts.author.trim().length > 0) {
    const authorSeg = sanitizeSegment(opts.author);
    folderName = `${authorSeg}_${titleSeg}`;
    if (folderName.length > MAX_SEGMENT_LEN) {
      const halfAuthor = authorSeg.slice(0, 20).replace(/_+$/, "");
      const halfTitle = titleSeg.slice(0, 25).replace(/_+$/, "");
      folderName = `${halfAuthor}_${halfTitle}`;
    }
  } else {
    folderName = titleSeg;
  }

  const mdFileName = `${titleSeg}.md`;
  const relPath = path.join(sphere, folderName, mdFileName);

  return { sphere, folderName, mdFileName, relPath };
}

export function resolveWithMaxPathGuard(
  libraryRoot: string,
  humanPath: HumanBookPath,
  bookIdShort: string,
): { bookDir: string; mdPath: string; relPath: string } {
  const fullMdPath = path.join(libraryRoot, humanPath.relPath);

  if (fullMdPath.length <= MAX_PATH_LEN) {
    const bookDir = path.join(libraryRoot, humanPath.sphere, humanPath.folderName);
    return { bookDir, mdPath: fullMdPath, relPath: humanPath.relPath };
  }

  const budget = MAX_PATH_LEN - libraryRoot.length - 20;
  const maxSeg = Math.max(8, Math.floor(budget / 4));
  const shortSphere = humanPath.sphere.slice(0, maxSeg);
  const shortFolder = `${humanPath.folderName.slice(0, maxSeg)}_${bookIdShort}`;
  const shortMdFile = `${bookIdShort}.md`;
  const shortRel = path.join(shortSphere, shortFolder, shortMdFile);
  const bookDir = path.join(libraryRoot, shortSphere, shortFolder);
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
