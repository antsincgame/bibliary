/**
 * Pre-import folder scanner -- read-only analysis that produces a ScanReport
 * with duplicate clusters, format alternatives, and fuzzy matches.
 *
 * Streaming progress via callback. Does NOT import anything into the library.
 */

import { promises as fs } from "fs";
import * as path from "path";
import { detectExt } from "../scanner/parsers/index.js";
import { SUPPORTED_BOOK_EXTS } from "./types.js";
import { walkSupportedFiles } from "./file-walker.js";
import { computeFileSha256 } from "./sha-stream.js";
import { parseFilename } from "./filename-parser.js";
import { buildWorkKey, getFormatPriority } from "./revision-dedup.js";
import {
  findFuzzyDuplicates,
  type BookFingerprint,
  type FuzzyMatchResult,
} from "./fuzzy-matcher.js";

// ── Types ───────────────────────────────────────────────────────────────────

export type ScanPhase = "walking" | "metadata" | "dedup" | "done";

export interface ScanProgressEvent {
  scanId: string;
  phase: ScanPhase;
  scannedFiles: number;
  totalFiles: number;
  bookFilesFound: number;
  currentFile?: string;
}

export interface ScanEdition {
  path: string;
  format: string;
  year?: number;
  isbn?: string;
  score: number;
  sizeBytes: number;
}

export interface ScanEditionGroup {
  workKey: string;
  title: string;
  author: string;
  editions: ScanEdition[];
  recommended: string;
}

export interface ScanFuzzyPair {
  confidence: number;
  bookA: { path: string; title: string; author: string };
  bookB: { path: string; title: string; author: string };
}

export interface ScanReport {
  totalFiles: number;
  bookFiles: number;
  nonBookFiles: number;
  exactDuplicates: number;
  formatDuplicates: number;
  editionGroups: ScanEditionGroup[];
  fuzzyMatches: ScanFuzzyPair[];
  uniqueBooks: number;
  estimatedImportTimeMs: number;
}

export interface ScanFolderOptions {
  signal?: AbortSignal;
  onProgress?: (evt: ScanProgressEvent) => void;
  scanId?: string;
}

// ── Lightweight metadata extraction (no full parse, just filename + stat) ────

interface QuickMeta {
  filePath: string;
  format: string;
  title: string;
  author: string;
  year?: number;
  isbn?: string;
  sha256: string;
  sizeBytes: number;
}

async function extractQuickMeta(filePath: string, signal?: AbortSignal): Promise<QuickMeta | null> {
  const ext = detectExt(filePath);
  if (!ext || !(SUPPORTED_BOOK_EXTS as ReadonlySet<string>).has(ext)) return null;

  let st;
  try { st = await fs.stat(filePath); } catch { return null; }

  let sha256: string;
  try { sha256 = await computeFileSha256(filePath, signal); } catch { return null; }

  const fnMeta = parseFilename(filePath);
  const basename = path.basename(filePath, path.extname(filePath));

  return {
    filePath,
    format: ext,
    title: fnMeta?.title ?? basename,
    author: fnMeta?.author ?? "",
    year: fnMeta?.year,
    sha256,
    sizeBytes: st.size,
  };
}

// ── Main scan function ──────────────────────────────────────────────────────

export async function scanFolder(folder: string, opts: ScanFolderOptions = {}): Promise<ScanReport> {
  const scanId = opts.scanId ?? "scan";
  const emit = (phase: ScanPhase, extra: Partial<ScanProgressEvent> = {}) => {
    opts.onProgress?.({ scanId, phase, scannedFiles: 0, totalFiles: 0, bookFilesFound: 0, ...extra });
  };

  // Phase 1: Walk + collect paths
  emit("walking");
  const filePaths: string[] = [];
  let walkCount = 0;
  for await (const p of walkSupportedFiles(
    folder,
    SUPPORTED_BOOK_EXTS as ReadonlySet<string> as ReadonlySet<import("../scanner/parsers/types.js").SupportedExt>,
    { includeArchives: false, signal: opts.signal },
  )) {
    if (opts.signal?.aborted) break;
    filePaths.push(p);
    walkCount++;
    if (walkCount % 100 === 0) {
      emit("walking", { scannedFiles: walkCount, bookFilesFound: walkCount });
    }
  }
  const totalFiles = filePaths.length;
  emit("walking", { scannedFiles: totalFiles, totalFiles, bookFilesFound: totalFiles });

  // Phase 2: Extract quick metadata + SHA for each file
  emit("metadata", { totalFiles });
  const metas: QuickMeta[] = [];
  for (let i = 0; i < filePaths.length; i++) {
    if (opts.signal?.aborted) break;
    const m = await extractQuickMeta(filePaths[i], opts.signal);
    if (m) metas.push(m);
    if ((i + 1) % 50 === 0 || i === filePaths.length - 1) {
      emit("metadata", {
        scannedFiles: i + 1,
        totalFiles,
        bookFilesFound: metas.length,
        currentFile: filePaths[i],
      });
    }
  }

  // Phase 3: Dedup analysis
  emit("dedup", { scannedFiles: totalFiles, totalFiles, bookFilesFound: metas.length });

  // 3a. Exact SHA duplicates
  const shaMap = new Map<string, QuickMeta[]>();
  for (const m of metas) {
    const arr = shaMap.get(m.sha256) ?? [];
    arr.push(m);
    shaMap.set(m.sha256, arr);
  }
  let exactDuplicates = 0;
  const uniqueBySha: QuickMeta[] = [];
  for (const group of shaMap.values()) {
    if (group.length > 1) exactDuplicates += group.length - 1;
    const best = group.sort((a, b) => getFormatPriority(b.format) - getFormatPriority(a.format))[0];
    uniqueBySha.push(best);
  }

  // 3b. WorkKey grouping (title+author normalized)
  const workGroups = new Map<string, QuickMeta[]>();
  const noKey: QuickMeta[] = [];
  for (const m of uniqueBySha) {
    const wk = buildWorkKey({ title: m.title, author: m.author });
    if (wk) {
      const arr = workGroups.get(wk) ?? [];
      arr.push(m);
      workGroups.set(wk, arr);
    } else {
      noKey.push(m);
    }
  }

  // 3c. Build edition groups (multi-format or multi-edition)
  const editionGroups: ScanEditionGroup[] = [];
  let formatDuplicates = 0;
  const singleBooks: QuickMeta[] = [...noKey];

  for (const [wk, group] of workGroups) {
    if (group.length === 1) {
      singleBooks.push(group[0]);
      continue;
    }
    formatDuplicates += group.length - 1;
    const editions: ScanEdition[] = group.map((m) => ({
      path: m.filePath,
      format: m.format,
      year: m.year,
      isbn: m.isbn,
      score: getFormatPriority(m.format) + (m.year ? (m.year - 1900) * 0.01 : 0),
      sizeBytes: m.sizeBytes,
    }));
    editions.sort((a, b) => b.score - a.score);
    editionGroups.push({
      workKey: wk,
      title: group[0].title,
      author: group[0].author,
      editions,
      recommended: editions[0].path,
    });
  }

  // 3d. Fuzzy matching on remaining singles
  const fingerprints: BookFingerprint[] = singleBooks.map((m) => ({
    id: m.sha256.slice(0, 16),
    title: m.title,
    author: m.author,
    year: m.year,
    isbn: m.isbn,
    path: m.filePath,
    format: m.format,
  }));

  const fuzzyRaw: FuzzyMatchResult[] = findFuzzyDuplicates(fingerprints, 0.70);
  const fuzzyMatches: ScanFuzzyPair[] = fuzzyRaw.map((r) => ({
    confidence: Math.round(r.confidence * 100) / 100,
    bookA: { path: r.bookA.path ?? "", title: r.bookA.title, author: r.bookA.author },
    bookB: { path: r.bookB.path ?? "", title: r.bookB.title, author: r.bookB.author },
  }));

  const uniqueBooks = singleBooks.length + editionGroups.length - fuzzyMatches.filter((f) => f.confidence >= 0.85).length;
  const estimatedImportTimeMs = metas.length * 200;

  const report: ScanReport = {
    totalFiles,
    bookFiles: metas.length,
    nonBookFiles: totalFiles - metas.length,
    exactDuplicates,
    formatDuplicates,
    editionGroups,
    fuzzyMatches,
    uniqueBooks: Math.max(0, uniqueBooks),
    estimatedImportTimeMs,
  };

  emit("done", { scannedFiles: totalFiles, totalFiles, bookFilesFound: metas.length });
  return report;
}
