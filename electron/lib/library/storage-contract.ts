/* Centralize library storage layout and crystallize gating across UI batch and E2E. */
import * as path from "path";
import type { BookStatus, BookCatalogMeta } from "./types.js";
import { getBookDir } from "./paths.js";

interface EvaluationLike {
  quality_score: number;
  is_fiction_or_water: boolean;
}

export interface StoredBookPaths {
  bookDir: string;
  mdPath: string;
  originalFile: string;
  originalPath: string;
}

export interface CrystallizeGateResult {
  canCrystallize: boolean;
  reason: string | null;
}

export function getStoredOriginalFileName(format: BookCatalogMeta["originalFormat"]): string {
  return `original.${format}`;
}

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
  };
}

export function resolveCatalogBookSourcePath(
  meta: Pick<BookCatalogMeta, "originalFile" | "originalFormat"> & { mdPath: string },
): string {
  const bookDir = path.dirname(meta.mdPath);
  const sourceFile = meta.originalFile?.trim() || getStoredOriginalFileName(meta.originalFormat);
  return path.join(bookDir, sourceFile);
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
