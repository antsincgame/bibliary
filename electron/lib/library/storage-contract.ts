/* Centralize library storage layout and crystallize gating across UI batch and E2E. */
import * as path from "path";
import type { BookStatus, BookCatalogMeta } from "./types.js";
import { getBookDir } from "./paths.js";
import {
  buildHumanBookPath,
  resolveWithMaxPathGuard,
  extractSphereFromImportPath,
} from "./path-sanitizer.js";
import { promises as fs } from "fs";

interface EvaluationLike {
  quality_score: number;
  is_fiction_or_water: boolean;
}

export interface StoredBookPaths {
  bookDir: string;
  mdPath: string;
  originalFile: string;
  originalPath: string;
  metaPath: string;
  illustrationsPath: string;
  /** Relative path from library root (for SQLite md_path). */
  relPath: string;
}

export interface CrystallizeGateResult {
  canCrystallize: boolean;
  reason: string | null;
}

export function getStoredOriginalFileName(format: BookCatalogMeta["originalFormat"]): string {
  return `original.${format}`;
}

export function getBookSidecarBaseName(mdPath: string): string {
  return path.basename(mdPath, path.extname(mdPath));
}

export function getSidecarFileName(mdPath: string, kind: "meta" | "illustrations" | "original", format?: BookCatalogMeta["originalFormat"]): string {
  const base = getBookSidecarBaseName(mdPath);
  if (kind === "meta") return `${base}.meta.json`;
  if (kind === "illustrations") return `${base}.illustrations.json`;
  if (!format) throw new Error("getSidecarFileName(original): format required");
  return `${base}.original.${format}`;
}

export function resolveSidecarPaths(
  mdPath: string,
  originalFormat: BookCatalogMeta["originalFormat"],
): { bookDir: string; originalFile: string; originalPath: string; metaPath: string; illustrationsPath: string } {
  const bookDir = path.dirname(mdPath);
  const originalFile = getSidecarFileName(mdPath, "original", originalFormat);
  return {
    bookDir,
    originalFile,
    originalPath: path.join(bookDir, originalFile),
    metaPath: path.join(bookDir, getSidecarFileName(mdPath, "meta")),
    illustrationsPath: path.join(bookDir, getSidecarFileName(mdPath, "illustrations")),
  };
}

export function resolveLegacySidecarPaths(
  mdPath: string,
  originalFile: string | undefined,
  originalFormat: BookCatalogMeta["originalFormat"],
): { bookDir: string; originalFile: string; originalPath: string; metaPath: string; illustrationsPath: string } {
  const bookDir = path.dirname(mdPath);
  const sourceFile = originalFile?.trim() || getStoredOriginalFileName(originalFormat);
  return {
    bookDir,
    originalFile: sourceFile,
    originalPath: path.join(bookDir, sourceFile),
    metaPath: path.join(bookDir, "meta.json"),
    illustrationsPath: path.join(bookDir, "illustrations.json"),
  };
}

export async function resolveCatalogSidecarPaths(
  meta: Pick<BookCatalogMeta, "originalFile" | "originalFormat"> & { mdPath: string },
): Promise<{ bookDir: string; originalFile: string; originalPath: string; metaPath: string; illustrationsPath: string }> {
  const preferred = resolveLegacySidecarPaths(meta.mdPath, meta.originalFile, meta.originalFormat);
  try {
    await fs.access(preferred.originalPath);
    return preferred;
  } catch {
    const modern = resolveSidecarPaths(meta.mdPath, meta.originalFormat);
    return { ...modern, originalFile: meta.originalFile?.trim() || modern.originalFile };
  }
}

/** Legacy ID-based path resolver. Kept for gating functions. */
export function resolveStoredBookPaths(
  libraryRoot: string,
  bookId: string,
  originalFormat: BookCatalogMeta["originalFormat"],
): StoredBookPaths {
  const bookDir = getBookDir(libraryRoot, bookId);
  const originalFile = getStoredOriginalFileName(originalFormat);
  return {
    bookDir,
    mdPath: path.join(bookDir, "book.md"),
    originalFile,
    originalPath: path.join(bookDir, originalFile),
    metaPath: path.join(bookDir, "meta.json"),
    illustrationsPath: path.join(bookDir, "illustrations.json"),
    relPath: path.join(bookId, "book.md"),
  };
}

/**
 * Human-readable path resolver.
 * Structure: {libraryRoot}/{language}/{domain}/{author}/{Title}.md
 * Sidecars use the same basename next to the markdown:
 *   {Title}.original.{ext}, {Title}.meta.json, {Title}.illustrations.json
 * Handles MAX_PATH fallback and file-level collision suffixes.
 */
export async function resolveHumanBookPaths(
  libraryRoot: string,
  meta: Pick<BookCatalogMeta, "id" | "title" | "author" | "originalFormat" | "language" | "domain">,
  importSourcePath: string,
  importRoot?: string,
): Promise<StoredBookPaths> {
  const sphere = importRoot
    ? extractSphereFromImportPath(importSourcePath, importRoot)
    : "unsorted";

  const humanPath = buildHumanBookPath({
    language: normalizeLanguageSegment(meta.language),
    domain: meta.domain || sphere,
    author: meta.author,
    title: meta.title,
    bookIdShort: meta.id.slice(0, 8),
  });

  const resolved = resolveWithMaxPathGuard(libraryRoot, humanPath, meta.id.slice(0, 8));
  const mdPath = await resolveFileCollisionSuffix(resolved.mdPath, fs);
  const bookDir = path.dirname(mdPath);
  const sidecars = resolveSidecarPaths(mdPath, meta.originalFormat);

  return {
    bookDir,
    mdPath,
    originalFile: sidecars.originalFile,
    originalPath: sidecars.originalPath,
    metaPath: sidecars.metaPath,
    illustrationsPath: sidecars.illustrationsPath,
    relPath: path.relative(libraryRoot, mdPath),
  };
}

export function resolveCatalogBookSourcePath(
  meta: Pick<BookCatalogMeta, "originalFile" | "originalFormat"> & { mdPath: string },
): string {
  const legacy = resolveLegacySidecarPaths(meta.mdPath, meta.originalFile, meta.originalFormat);
  return legacy.originalPath;
}

export async function resolveCatalogBookSourcePathAsync(
  meta: Pick<BookCatalogMeta, "originalFile" | "originalFormat"> & { mdPath: string },
): Promise<string> {
  const paths = await resolveCatalogSidecarPaths(meta);
  return paths.originalPath;
}

async function resolveFileCollisionSuffix(
  mdPath: string,
  fsLike: { access(p: string): Promise<void> },
): Promise<string> {
  try {
    await fsLike.access(mdPath);
  } catch {
    return mdPath;
  }
  const dir = path.dirname(mdPath);
  const ext = path.extname(mdPath);
  const stem = path.basename(mdPath, ext);
  for (let i = 2; i <= 99; i++) {
    const candidate = path.join(dir, `${stem}-${i}${ext}`);
    try {
      await fsLike.access(candidate);
    } catch {
      return candidate;
    }
  }
  return path.join(dir, `${stem}-${Date.now()}${ext}`);
}

function normalizeLanguageSegment(lang: string | undefined): string {
  const v = lang?.trim().toLowerCase();
  if (!v) return "unknown";
  return v.replace(/[^a-z0-9_-]+/g, "_").slice(0, 16) || "unknown";
}

export function gateCatalogBookForCrystallize(
  meta: Pick<BookCatalogMeta, "status" | "qualityScore" | "isFictionOrWater">,
  opts: { minQuality: number; skipFictionOrWater: boolean },
): CrystallizeGateResult {
  if (!["evaluated", "failed", "indexed"].includes(meta.status)) {
    return { canCrystallize: false, reason: `status=${meta.status} (must be evaluated/retryable)` };
  }
  if (typeof meta.qualityScore !== "number") {
    return { canCrystallize: false, reason: "no quality_score" };
  }
  if (meta.qualityScore < opts.minQuality) {
    return { canCrystallize: false, reason: `qualityScore=${meta.qualityScore} < ${opts.minQuality}` };
  }
  if (opts.skipFictionOrWater && meta.isFictionOrWater === true) {
    return { canCrystallize: false, reason: "is_fiction_or_water" };
  }
  return { canCrystallize: true, reason: null };
}

export function gateE2EBookForCrystallize(opts: {
  parseVerdict: "PASS" | "FAIL" | "SKIP";
  skipEvaluate: boolean;
  skipCrystallize: boolean;
  minQuality: number;
  evaluation: EvaluationLike | null;
}): CrystallizeGateResult {
  if (opts.skipCrystallize) {
    return { canCrystallize: false, reason: "crystallize-disabled" };
  }
  if (opts.skipEvaluate) {
    return { canCrystallize: false, reason: "evaluate-disabled" };
  }
  if (opts.parseVerdict !== "PASS") {
    return { canCrystallize: false, reason: "parse-not-passed" };
  }
  if (!opts.evaluation) {
    return { canCrystallize: false, reason: "no-evaluation" };
  }
  if (opts.evaluation.quality_score < opts.minQuality) {
    return {
      canCrystallize: false,
      reason: `quality ${opts.evaluation.quality_score} < ${opts.minQuality}`,
    };
  }
  if (opts.evaluation.is_fiction_or_water) {
    return { canCrystallize: false, reason: "fiction-or-water" };
  }
  return { canCrystallize: true, reason: null };
}

export function isTerminalE2EBookStatus(
  status: BookStatus | "done" | "duplicate",
  opts: { skipEvaluate: boolean; skipCrystallize: boolean },
): boolean {
  if (status === "done" || status === "failed" || status === "duplicate" || status === "indexed") {
    return true;
  }
  if (opts.skipCrystallize && status === "evaluated") return true;
  if (opts.skipEvaluate && status === "imported") return true;
  return false;
}
