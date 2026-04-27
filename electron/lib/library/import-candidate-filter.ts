import * as path from "path";

export interface ImportCandidateContext {
  rootDir: string;
  candidatePath: string;
  ext: string;
  sizeBytes: number;
}

const NOISE_SEGMENTS: ReadonlySet<string> = new Set([
  "_vti_cnf",
  "assets",
  "asset",
  "textures",
  "texture",
  "images",
  "image",
  "img",
  "thumbnails",
  "thumbnail",
  "thumbs",
  "thumb",
  "css",
  "js",
  "code",
  "codes",
  "examples",
  "example",
  "samples",
  "sample",
  "extras",
  "extra",
  "ftp",
  "vendor",
  "node_modules",
  "__macosx",
]);

const NOISE_BASENAMES: ReadonlySet<string> = new Set([
  "readme",
  "license",
  "changelog",
  "changes",
  "contents",
  "content",
  "toc",
  "index",
  "cover",
  "front",
  "back",
  "_downloaded",
  "-",
]);

const HTML_SEGMENT_BLOCKLIST: ReadonlySet<string> = new Set([
  "html",
  "index",
  "_vti_cnf",
]);

const TXT_NAME_RE = /(stepik|solution|answers?|решени[ея]|урок|lesson|шаг\s*\d+)/i;
const HTML_NAME_RE = /(chapter|part\s*\d+|ch\d{1,3}|idx[_-]?\d+|page\s*\d+|lesson|урок|stepik|шаг\s*\d+)/i;
const COMMON_NOISE_RE = /(readme|license|changelog|contents?|toc|cover|front|back|thumbnail|thumb)/i;
const FORUM_SEGMENT_RE = /^forum[_-]?\d+$/i;
const COURSE_SEGMENT_RE = /(stepik|beegeek|coursera|udemy|курс|урок|lesson)/i;
// Companion code paths that appear as intermediate segments — not top-level dirs.
// Note: "html" / "htm" / "docu" intentionally excluded — composite HTML books live there.
const COMPANION_DIR_RE = /^(chap\d+|chapter\d+|part\d+|listings?|task_?\d+|exercise_?\d+|src|lib|pkg|cmd|internal)$/i;

const MIN_TEXT_BYTES = 10_240;
const MIN_HTML_BYTES = 64 * 1024;

function normalizeSegments(rootDir: string, candidatePath: string): string[] {
  const relative = path.relative(rootDir, candidatePath);
  if (!relative || relative.startsWith("..")) {
    return [path.basename(candidatePath)];
  }
  return relative.split(/[\\/]+/).filter(Boolean);
}

function tokenize(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .split(/\s+/)
      .filter((token) => token.length >= 3),
  );
}

export function nameTokenSimilarity(a: string, b: string): number {
  const left = tokenize(a);
  const right = tokenize(b);
  if (left.size === 0 || right.size === 0) return 0;
  let hits = 0;
  for (const token of left) {
    if (right.has(token)) hits += 1;
  }
  return hits / Math.max(left.size, right.size);
}

export function shouldIncludeImportCandidate(ctx: ImportCandidateContext): boolean {
  const ext = ctx.ext.toLowerCase();
  const segments = normalizeSegments(ctx.rootDir, ctx.candidatePath);
  const lowerSegments = segments.map((segment) => segment.toLowerCase());
  const fileName = lowerSegments[lowerSegments.length - 1] ?? path.basename(ctx.candidatePath).toLowerCase();
  const baseName = path.basename(fileName, path.extname(fileName));
  const parentName = lowerSegments.length >= 2 ? lowerSegments[lowerSegments.length - 2] : "";

  if (lowerSegments.some((segment) => FORUM_SEGMENT_RE.test(segment))) return false;
  if (lowerSegments.some((segment) => COURSE_SEGMENT_RE.test(segment))) return false;
  if (lowerSegments.some((segment) => NOISE_SEGMENTS.has(segment))) return false;
  // Block companion code paths only in intermediate segments (not top-level, not filename)
  if (lowerSegments.length >= 2 && lowerSegments.slice(0, -1).some((segment) => COMPANION_DIR_RE.test(segment))) return false;
  if (NOISE_BASENAMES.has(fileName) || NOISE_BASENAMES.has(baseName)) return false;
  if (COMMON_NOISE_RE.test(baseName)) return false;

  if (ext === "txt") {
    if (ctx.sizeBytes < MIN_TEXT_BYTES) return false;
    if (TXT_NAME_RE.test(baseName)) return false;
    return true;
  }

  if (ext === "html" || ext === "htm") {
    // Single large HTML files (e.g. exported docs) — keep as standalone book if big enough.
    // Small HTML files in flat dirs are rejected here; files inside Composite HTML dirs
    // are handled by composite-html-detector.ts BEFORE this filter is called, so they
    // are never passed to shouldIncludeImportCandidate individually.
    if (lowerSegments.some((segment) => HTML_SEGMENT_BLOCKLIST.has(segment))) return false;
    if (HTML_NAME_RE.test(baseName)) return false;
    // Single standalone HTML: must be ≥ 64 KB and not a deep fragment (depth > 3)
    if (lowerSegments.length > 3) return false;
    if (ctx.sizeBytes < MIN_HTML_BYTES) return false;
    if (parentName && nameTokenSimilarity(baseName, parentName) < 0.45) return false;
    return true;
  }

  if (TXT_NAME_RE.test(baseName) && (ext === "pdf" || ext === "doc" || ext === "docx" || ext === "rtf")) {
    return false;
  }

  return true;
}
