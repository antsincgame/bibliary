/**
 * Full-corpus E2E import with per-book accountability.
 *
 * This script uses the production library import pipeline, but keeps a detailed
 * report for every discovered source file so large corpus runs are repeatable
 * and auditable.
 *
 * Example:
 *   npx tsx scripts/e2e-full-corpus-library-import.ts --root "%USERPROFILE%\\Downloads" --root "D:\\Bibliarifull" --ocr
 */

import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import { importFile, type ImportResult } from "../electron/lib/library/import.js";
import { closeCacheDb, getBookById, getCacheDbPath, getKnownSha256s, openCacheDb } from "../electron/lib/library/cache-db.js";
import { _resetLibraryRootCache, getLibraryRoot } from "../electron/lib/library/paths.js";
import { isArchive } from "../electron/lib/library/archive-extractor.js";
import { SUPPORTED_BOOK_EXTS, type BookCatalogMeta } from "../electron/lib/library/types.js";
import { detectExt } from "../electron/lib/scanner/parsers/index.js";
import { computeFileSha256 } from "../electron/lib/library/sha-stream.js";

interface Args {
  roots: string[];
  maxDepth: number;
  scanArchives: boolean;
  ocr: boolean;
  reportDir: string;
  forceAll: boolean;
  timeoutMs: number;
  maxNew: number | null;
  sinceMs: number | null;
  sinceField: "mtime" | "ctime" | "either";
  dryRun: boolean;
  recentLimitPerRoot: number | null;
}

interface SourceFile {
  root: string;
  absPath: string;
  relativePath: string;
  ext: string;
  sizeBytes: number;
  isArchive: boolean;
  mtimeMs: number;
  ctimeMs: number;
}

interface ImageStats {
  imageRefs: number;
  hasCover: boolean;
  coverBytes: number | null;
}

interface ReportRow {
  root: string;
  sourcePath: string;
  relativePath: string;
  ext: string;
  sizeBytes: number;
  sha256?: string;
  mtime?: string;
  ctime?: string;
  outcome: ImportResult["outcome"] | "error" | "existing-sha" | "duplicate-source-sha" | "not-imported-max-new" | "dry-run-new-unique";
  bookId?: string;
  title?: string;
  author?: string;
  year?: number;
  status?: BookCatalogMeta["status"];
  wordCount?: number;
  chapterCount?: number;
  originalFormat?: string;
  sourceArchive?: string;
  duplicateReason?: ImportResult["duplicateReason"];
  existingBookId?: string;
  existingBookTitle?: string;
  duplicateSourceOf?: string;
  filenameDuplicateCount?: number;
  error?: string;
  warnings: string[];
  imageRefs: number;
  hasCover: boolean;
  coverBytes: number | null;
}

interface InventoryItem extends SourceFile {
  sha256: string;
  existingBookId?: string;
}

interface ScanError {
  root: string;
  path: string;
  error: string;
}

function argValues(argv: string[], flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === flag && i + 1 < argv.length) out.push(argv[i + 1]!);
  }
  return out;
}

function parseArgs(argv: string[]): Args {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(`
e2e-full-corpus-library-import

  --root <dir>       Source root. Repeatable.
  --max-depth <n>    Recursive depth per root (default: 32).
  --ocr              Enable OCR for PDF/DJVU scans.
  --no-archives      Do not import archive files.
  --force-all         Import even when SHA already exists (default: false).
  --timeout-ms <n>    Per-file import timeout (default: 480000).
  --max-new <n>       Import at most N new unique SHA files.
  --since-hours <n>   Only import files modified/created within N hours.
  --since-date <iso>  Only import files modified/created since ISO date.
  --since-field <v>   mtime | ctime | either (default: mtime).
  --recent-limit-per-root <n>
                     After time filtering, keep only N newest files per root.
  --dry-run           Inventory and report only; do not import.
  --report-dir <dir> Report directory (default: release/e2e-full-corpus-report).

ENV: BIBLIARY_SOURCE_ROOTS can contain roots separated by ; or path delimiter.
ENV: BIBLIARY_DATA_DIR / BIBLIARY_LIBRARY_ROOT / BIBLIARY_LIBRARY_DB choose the permanent catalog.
`.trim());
    process.exit(0);
  }

  const envRoots = (process.env.BIBLIARY_SOURCE_ROOTS ?? "")
    .split(/[;|]/)
    .map((value) => value.trim())
    .filter(Boolean);
  const roots = [...argValues(argv, "--root"), ...envRoots]
    .map((value) => value.replace(/^~(?=$|[\\/])/, os.homedir()))
    .map((value) => path.resolve(value));
  const maxDepthRaw = argv.includes("--max-depth") ? argv[argv.indexOf("--max-depth") + 1] : undefined;
  const maxDepth = Math.max(0, Math.floor(Number(maxDepthRaw ?? "32")));
  const timeoutRaw = argv.includes("--timeout-ms") ? argv[argv.indexOf("--timeout-ms") + 1] : undefined;
  const timeoutMs = Math.max(1, Math.floor(Number(timeoutRaw ?? "480000")));
  const maxNewRaw = argv.includes("--max-new") ? argv[argv.indexOf("--max-new") + 1] : undefined;
  const maxNewNumber = maxNewRaw === undefined ? null : Math.max(0, Math.floor(Number(maxNewRaw)));
  const sinceHoursRaw = argv.includes("--since-hours") ? argv[argv.indexOf("--since-hours") + 1] : undefined;
  const sinceDateRaw = argv.includes("--since-date") ? argv[argv.indexOf("--since-date") + 1] : undefined;
  let sinceMs: number | null = null;
  if (sinceHoursRaw !== undefined) {
    const hours = Number(sinceHoursRaw);
    if (Number.isFinite(hours) && hours >= 0) sinceMs = Date.now() - hours * 60 * 60 * 1000;
  }
  if (sinceDateRaw !== undefined) {
    const parsed = Date.parse(sinceDateRaw);
    if (!Number.isFinite(parsed)) throw new Error(`Invalid --since-date: ${sinceDateRaw}`);
    sinceMs = parsed;
  }
  const sinceFieldRaw = argv.includes("--since-field") ? argv[argv.indexOf("--since-field") + 1] : undefined;
  const sinceField = sinceFieldRaw === "ctime" || sinceFieldRaw === "either" ? sinceFieldRaw : "mtime";
  const recentLimitRaw = argv.includes("--recent-limit-per-root") ? argv[argv.indexOf("--recent-limit-per-root") + 1] : undefined;
  const recentLimit = recentLimitRaw === undefined ? null : Math.max(0, Math.floor(Number(recentLimitRaw)));
  const reportDirArg = argv.includes("--report-dir") ? argv[argv.indexOf("--report-dir") + 1] : undefined;

  if (roots.length === 0) {
    throw new Error("No roots provided. Pass at least one --root <dir> or set BIBLIARY_SOURCE_ROOTS.");
  }

  return {
    roots,
    maxDepth: Number.isFinite(maxDepth) ? maxDepth : 32,
    scanArchives: !argv.includes("--no-archives"),
    ocr: argv.includes("--ocr"),
    reportDir: path.resolve(reportDirArg ?? path.join("release", "e2e-full-corpus-report")),
    forceAll: argv.includes("--force-all"),
    timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : 480000,
    maxNew: maxNewNumber !== null && Number.isFinite(maxNewNumber) ? maxNewNumber : null,
    sinceMs,
    sinceField,
    dryRun: argv.includes("--dry-run"),
    recentLimitPerRoot: recentLimit !== null && Number.isFinite(recentLimit) ? recentLimit : null,
  };
}

function isBookOrArchive(filePath: string, scanArchives: boolean): { ok: boolean; ext: string; archive: boolean } {
  const ext = detectExt(filePath);
  if (ext && SUPPORTED_BOOK_EXTS.has(ext)) return { ok: true, ext, archive: false };
  if (scanArchives && isArchive(filePath)) return { ok: true, ext: path.extname(filePath).toLowerCase().slice(1), archive: true };
  return { ok: false, ext: path.extname(filePath).toLowerCase().slice(1), archive: false };
}

async function scanRoot(root: string, maxDepth: number, scanArchives: boolean): Promise<{ files: SourceFile[]; errors: ScanError[] }> {
  const files: SourceFile[] = [];
  const errors: ScanError[] = [];

  async function walk(current: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    let entries: import("fs").Dirent[];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch (err) {
      errors.push({ root, path: current, error: err instanceof Error ? err.message : String(err) });
      return;
    }

    for (const entry of entries) {
      const absPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(absPath, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const kind = isBookOrArchive(absPath, scanArchives);
      if (!kind.ok) continue;
      try {
        const stat = await fs.stat(absPath);
        if (stat.size <= 0) continue;
        files.push({
          root,
          absPath,
          relativePath: path.relative(root, absPath),
          ext: kind.ext,
          sizeBytes: stat.size,
          isArchive: kind.archive,
          mtimeMs: stat.mtimeMs,
          ctimeMs: stat.ctimeMs,
        });
      } catch (err) {
        errors.push({ root, path: absPath, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  await walk(root, 0);
  files.sort((a, b) => a.absPath.localeCompare(b.absPath));
  return { files, errors };
}

function extractImageStats(markdown: string | null): ImageStats {
  if (!markdown) return { imageRefs: 0, hasCover: false, coverBytes: null };
  const refs = markdown.match(/^\[img-[^\]]+\]:\s*data:image\//gm) ?? [];
  const cover = markdown.match(/^\[img-cover\]:\s*data:image\/[a-zA-Z0-9.+-]+;base64,([A-Za-z0-9+/=]+)\s*$/m);
  return {
    imageRefs: refs.length,
    hasCover: Boolean(cover),
    coverBytes: cover ? Buffer.byteLength(cover[1]!, "base64") : null,
  };
}

async function readBookMarkdown(bookId: string | undefined): Promise<string | null> {
  if (!bookId) return null;
  const meta = getBookById(bookId);
  if (!meta?.mdPath) return null;
  try {
    return await fs.readFile(meta.mdPath, "utf8");
  } catch {
    return null;
  }
}

async function existingRow(source: InventoryItem, bookId: string, filenameDuplicateCount: number): Promise<ReportRow> {
  const meta = getBookById(bookId);
  const imageStats = extractImageStats(await readBookMarkdown(bookId));
  return {
    root: source.root,
    sourcePath: source.absPath,
    relativePath: source.relativePath,
    ext: source.ext,
    sizeBytes: source.sizeBytes,
    sha256: source.sha256,
    mtime: new Date(source.mtimeMs).toISOString(),
    ctime: new Date(source.ctimeMs).toISOString(),
    outcome: "existing-sha",
    bookId,
    title: meta?.title,
    author: meta?.author,
    year: meta?.year,
    status: meta?.status,
    wordCount: meta?.wordCount,
    chapterCount: meta?.chapterCount,
    originalFormat: meta?.originalFormat,
    existingBookId: bookId,
    existingBookTitle: meta?.title,
    filenameDuplicateCount,
    warnings: ["source SHA already exists in library; import skipped"],
    ...imageStats,
  };
}

function sourceDuplicateRow(
  source: InventoryItem,
  firstPath: string,
  filenameDuplicateCount: number,
): ReportRow {
  return {
    root: source.root,
    sourcePath: source.absPath,
    relativePath: source.relativePath,
    ext: source.ext,
    sizeBytes: source.sizeBytes,
    sha256: source.sha256,
    mtime: new Date(source.mtimeMs).toISOString(),
    ctime: new Date(source.ctimeMs).toISOString(),
    outcome: "duplicate-source-sha",
    duplicateSourceOf: firstPath,
    filenameDuplicateCount,
    warnings: [`same SHA already selected from ${firstPath}; import skipped`],
    imageRefs: 0,
    hasCover: false,
    coverBytes: null,
  };
}

async function runWithTimeout<T>(label: string, timeoutMs: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new Error(`timeout after ${timeoutMs}ms: ${label}`)), timeoutMs);
  try {
    return await Promise.race([
      fn(ctl.signal),
      new Promise<T>((_, reject) => {
        ctl.signal.addEventListener("abort", () => reject(new Error(`timeout after ${timeoutMs}ms: ${label}`)), { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function enrichResult(source: SourceFile, result: ImportResult): Promise<ReportRow> {
  const bookId = result.bookId ?? result.meta?.id ?? result.existingBookId;
  const meta = bookId ? getBookById(bookId) : null;
  const markdown = await readBookMarkdown(bookId);
  const imageStats = extractImageStats(markdown);
  return {
    root: source.root,
    sourcePath: source.absPath,
    relativePath: source.relativePath,
    ext: source.ext,
    sizeBytes: source.sizeBytes,
    sha256: "sha256" in source ? (source as InventoryItem).sha256 : undefined,
    mtime: "mtimeMs" in source ? new Date(source.mtimeMs).toISOString() : undefined,
    ctime: "ctimeMs" in source ? new Date(source.ctimeMs).toISOString() : undefined,
    outcome: result.outcome,
    bookId: bookId ?? undefined,
    title: meta?.title ?? result.meta?.title ?? result.existingBookTitle,
    author: meta?.author ?? result.meta?.author,
    year: meta?.year ?? result.meta?.year,
    status: meta?.status ?? result.meta?.status,
    wordCount: meta?.wordCount ?? result.meta?.wordCount,
    chapterCount: meta?.chapterCount ?? result.meta?.chapterCount,
    originalFormat: meta?.originalFormat ?? result.meta?.originalFormat,
    sourceArchive: result.sourceArchive,
    duplicateReason: result.duplicateReason,
    existingBookId: result.existingBookId,
    existingBookTitle: result.existingBookTitle,
    error: result.error,
    warnings: result.warnings,
    filenameDuplicateCount: "filenameDuplicateCount" in source ? Number((source as SourceFile & { filenameDuplicateCount?: number }).filenameDuplicateCount) : undefined,
    ...imageStats,
  };
}

function totals(rows: ReportRow[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) out[row.outcome] = (out[row.outcome] ?? 0) + 1;
  return out;
}

function groupByBasename(files: SourceFile[]): Map<string, SourceFile[]> {
  const out = new Map<string, SourceFile[]>();
  for (const file of files) {
    const key = path.basename(file.absPath).toLocaleLowerCase();
    const list = out.get(key) ?? [];
    list.push(file);
    out.set(key, list);
  }
  return out;
}

function filenameDuplicateCount(file: SourceFile, groups: Map<string, SourceFile[]>): number {
  return groups.get(path.basename(file.absPath).toLocaleLowerCase())?.length ?? 1;
}

function sourceFreshnessMs(source: SourceFile, field: Args["sinceField"]): number {
  if (field === "ctime") return source.ctimeMs;
  if (field === "either") return Math.max(source.mtimeMs, source.ctimeMs);
  return source.mtimeMs;
}

function applyRecentLimitPerRoot(
  sources: SourceFile[],
  field: Args["sinceField"],
  limit: number | null,
): SourceFile[] {
  if (limit === null) return sources;
  const groups = new Map<string, SourceFile[]>();
  for (const source of sources) {
    const list = groups.get(source.root) ?? [];
    list.push(source);
    groups.set(source.root, list);
  }
  const limited: SourceFile[] = [];
  for (const list of groups.values()) {
    list.sort((a, b) => sourceFreshnessMs(b, field) - sourceFreshnessMs(a, field) || a.absPath.localeCompare(b.absPath));
    limited.push(...list.slice(0, limit));
  }
  return limited.sort((a, b) => a.absPath.localeCompare(b.absPath));
}

async function writeMarkdownReport(reportPath: string, payload: {
  roots: string[];
  libraryRoot: string;
  dbPath: string;
  rows: ReportRow[];
  scanErrors: ScanError[];
  durationMs: number;
}): Promise<void> {
  const lines: string[] = [];
  lines.push("# Full Corpus Import Report", "");
  lines.push(`- Library: \`${payload.libraryRoot}\``);
  lines.push(`- SQLite: \`${payload.dbPath}\``);
  lines.push(`- Roots: ${payload.roots.map((root) => `\`${root}\``).join(", ")}`);
  lines.push(`- Duration: ${(payload.durationMs / 1000).toFixed(1)}s`);
  lines.push(`- Totals: \`${JSON.stringify(totals(payload.rows))}\``);
  lines.push(`- Existing SHA skipped: ${payload.rows.filter((row) => row.outcome === "existing-sha").length}`);
  lines.push(`- Source SHA duplicates skipped: ${payload.rows.filter((row) => row.outcome === "duplicate-source-sha").length}`);
  lines.push(`- Scan errors: ${payload.scanErrors.length}`, "");
  lines.push("## New Unique Imports", "");
  const imported = payload.rows.filter((row) => row.outcome === "added" || row.outcome === "duplicate" || row.outcome === "failed");
  if (imported.length === 0) lines.push("_No new unique source files were imported._");
  for (const row of imported) {
    lines.push(`- ${row.outcome}: ${row.title ?? row.relativePath} (${row.ext}) — \`${row.bookId ?? "no-id"}\`, cover=${row.hasCover ? "yes" : "no"}, images=${row.imageRefs}`);
  }
  lines.push("", "## Repeated File Names", "");
  const filenameDupes = payload.rows.filter((row) => (row.filenameDuplicateCount ?? 1) > 1);
  if (filenameDupes.length === 0) lines.push("_No repeated basenames in scanned roots._");
  for (const row of filenameDupes.slice(0, 200)) {
    lines.push(`- ${path.basename(row.sourcePath)} ×${row.filenameDuplicateCount}: ${row.relativePath} → ${row.outcome}`);
  }
  if (filenameDupes.length > 200) lines.push(`- ... ${filenameDupes.length - 200} more`);
  lines.push("");
  lines.push("## Added Books", "");
  const added = payload.rows.filter((row) => row.outcome === "added");
  if (added.length === 0) lines.push("_No new books added._");
  for (const row of added) {
    lines.push(`- ${row.title ?? path.basename(row.sourcePath)} (${row.ext}) — \`${row.bookId ?? "no-id"}\`, words=${row.wordCount ?? 0}, images=${row.imageRefs}, cover=${row.hasCover ? "yes" : "no"}`);
  }
  lines.push("", "## Failed Or Skipped", "");
  const bad = payload.rows.filter((row) => row.outcome === "failed" || row.outcome === "skipped" || row.outcome === "error");
  if (bad.length === 0) lines.push("_No failed/skipped source files._");
  for (const row of bad) {
    lines.push(`- ${row.relativePath} (${row.outcome}) — ${row.error ?? row.warnings[0] ?? "no details"}`);
  }
  await fs.writeFile(reportPath, lines.join("\n"), "utf8");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  _resetLibraryRootCache();
  const libraryRoot = await getLibraryRoot();
  const dbPath = getCacheDbPath();
  openCacheDb();

  console.log("=== Full Corpus Library Import ===");
  console.log(`roots       : ${args.roots.join(" | ")}`);
  console.log(`maxDepth    : ${args.maxDepth}`);
  console.log(`archives    : ${args.scanArchives}`);
  console.log(`ocr         : ${args.ocr}`);
  console.log(`mode        : ${args.forceAll ? "force-all" : "new-unique-sha-only"}`);
  console.log(`timeoutMs   : ${args.timeoutMs}`);
  console.log(`maxNew      : ${args.maxNew ?? "∞"}`);
  console.log(`since       : ${args.sinceMs === null ? "all time" : new Date(args.sinceMs).toISOString()}`);
  console.log(`sinceField  : ${args.sinceField}`);
  console.log(`recentLimit : ${args.recentLimitPerRoot ?? "none"}`);
  console.log(`dryRun      : ${args.dryRun}`);
  console.log(`library     : ${libraryRoot}`);
  console.log(`sqlite      : ${dbPath}`);

  const startedAt = Date.now();
  const allFiles: SourceFile[] = [];
  const scanErrors: ScanError[] = [];
  for (const root of args.roots) {
    const stat = await fs.stat(root);
    if (!stat.isDirectory()) throw new Error(`Not a directory: ${root}`);
    const scanned = await scanRoot(root, args.maxDepth, args.scanArchives);
    allFiles.push(...scanned.files);
    scanErrors.push(...scanned.errors);
  }

  const unique = new Map<string, SourceFile>();
  for (const file of allFiles) unique.set(path.normalize(file.absPath).toLowerCase(), file);
  const sources = [...unique.values()].sort((a, b) => a.absPath.localeCompare(b.absPath));
  console.log(`discovered  : ${sources.length}`);
  if (scanErrors.length > 0) console.log(`scan errors : ${scanErrors.length}`);

  const rows: ReportRow[] = [];
  const filenameGroups = groupByBasename(sources);
  const existingSha = getKnownSha256s();
  const selectedSha = new Map<string, string>();
  const inventory: InventoryItem[] = [];
  const timeFilteredSources = args.sinceMs === null
    ? sources
    : sources.filter((source) => sourceFreshnessMs(source, args.sinceField) >= args.sinceMs!);
  const candidateSources = applyRecentLimitPerRoot(timeFilteredSources, args.sinceField, args.recentLimitPerRoot);
  console.log(`candidates  : ${candidateSources.length}${args.sinceMs === null ? "" : " (time-filtered)"}`);
  console.log("inventory   : hashing source files...");
  for (let i = 0; i < candidateSources.length; i++) {
    const source = candidateSources[i]!;
    try {
      const sha256 = await computeFileSha256(source.absPath);
      const item: InventoryItem = { ...source, sha256, existingBookId: existingSha.get(sha256) };
      inventory.push(item);
      if ((i + 1) % 100 === 0 || i + 1 === candidateSources.length) {
        console.log(`  hashed ${i + 1}/${candidateSources.length}`);
      }
    } catch (err) {
      rows.push({
        root: source.root,
        sourcePath: source.absPath,
        relativePath: source.relativePath,
        ext: source.ext,
        sizeBytes: source.sizeBytes,
        mtime: new Date(source.mtimeMs).toISOString(),
        ctime: new Date(source.ctimeMs).toISOString(),
        outcome: "error",
        error: `sha-256 failed: ${err instanceof Error ? err.message : String(err)}`,
        warnings: [],
        filenameDuplicateCount: filenameDuplicateCount(source, filenameGroups),
        imageRefs: 0,
        hasCover: false,
        coverBytes: null,
      });
    }
  }

  const importQueue: InventoryItem[] = [];
  for (const source of inventory) {
    const filenameCount = filenameDuplicateCount(source, filenameGroups);
    if (!args.forceAll && source.existingBookId) {
      rows.push(await existingRow(source, source.existingBookId, filenameCount));
      continue;
    }
    const firstPath = selectedSha.get(source.sha256);
    if (!args.forceAll && firstPath) {
      rows.push(sourceDuplicateRow(source, firstPath, filenameCount));
      continue;
    }
    selectedSha.set(source.sha256, source.absPath);
    if (args.maxNew !== null && importQueue.length >= args.maxNew) {
      rows.push({
        root: source.root,
        sourcePath: source.absPath,
        relativePath: source.relativePath,
        ext: source.ext,
        sizeBytes: source.sizeBytes,
        sha256: source.sha256,
        mtime: new Date(source.mtimeMs).toISOString(),
        ctime: new Date(source.ctimeMs).toISOString(),
        outcome: "not-imported-max-new",
        warnings: [`max-new limit reached (${args.maxNew})`],
        filenameDuplicateCount: filenameCount,
        imageRefs: 0,
        hasCover: false,
        coverBytes: null,
      });
      continue;
    }
    importQueue.push(source);
  }

  console.log(`new queue   : ${importQueue.length}`);
  console.log(`known sha   : ${inventory.filter((item) => item.existingBookId).length}`);
  console.log(`source dup  : ${rows.filter((row) => row.outcome === "duplicate-source-sha").length}`);

  if (args.dryRun) {
    for (const source of importQueue) {
      rows.push({
        root: source.root,
        sourcePath: source.absPath,
        relativePath: source.relativePath,
        ext: source.ext,
        sizeBytes: source.sizeBytes,
        sha256: source.sha256,
        mtime: new Date(source.mtimeMs).toISOString(),
        ctime: new Date(source.ctimeMs).toISOString(),
        outcome: "dry-run-new-unique",
        warnings: ["dry-run: not imported"],
        filenameDuplicateCount: filenameDuplicateCount(source, filenameGroups),
        imageRefs: 0,
        hasCover: false,
        coverBytes: null,
      });
    }
  }

  for (let i = 0; !args.dryRun && i < importQueue.length; i++) {
    const source = importQueue[i]!;
    const label = `${i + 1}/${importQueue.length} ${source.relativePath}`;
    process.stdout.write(`[${label}] `);
    try {
      const results = await runWithTimeout(source.relativePath, args.timeoutMs, (signal) =>
        importFile(source.absPath, {
          scanArchives: args.scanArchives,
          ocrEnabled: args.ocr,
          signal,
        })
      );
      for (const result of results) {
        const row = await enrichResult(source, result);
        row.filenameDuplicateCount = filenameDuplicateCount(source, filenameGroups);
        rows.push(row);
        process.stdout.write(`${row.outcome}${row.hasCover ? "+cover" : ""} `);
      }
      process.stdout.write("\n");
    } catch (err) {
      const row: ReportRow = {
        root: source.root,
        sourcePath: source.absPath,
        relativePath: source.relativePath,
        ext: source.ext,
        sizeBytes: source.sizeBytes,
        sha256: source.sha256,
        mtime: new Date(source.mtimeMs).toISOString(),
        ctime: new Date(source.ctimeMs).toISOString(),
        outcome: "error",
        error: err instanceof Error ? err.message : String(err),
        warnings: [],
        filenameDuplicateCount: filenameDuplicateCount(source, filenameGroups),
        imageRefs: 0,
        hasCover: false,
        coverBytes: null,
      };
      rows.push(row);
      console.log(`error: ${row.error}`);
    }
  }

  const durationMs = Date.now() - startedAt;
  await fs.mkdir(args.reportDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const jsonPath = path.join(args.reportDir, `${stamp}.json`);
  const mdPath = path.join(args.reportDir, `${stamp}.md`);
  const payload = {
    roots: args.roots,
    maxDepth: args.maxDepth,
    scanArchives: args.scanArchives,
    ocr: args.ocr,
    forceAll: args.forceAll,
    timeoutMs: args.timeoutMs,
    maxNew: args.maxNew,
    since: args.sinceMs === null ? null : new Date(args.sinceMs).toISOString(),
    sinceField: args.sinceField,
    recentLimitPerRoot: args.recentLimitPerRoot,
    dryRun: args.dryRun,
    libraryRoot,
    dbPath,
    discovered: sources.length,
    timeFiltered: timeFilteredSources.length,
    candidates: candidateSources.length,
    inventoryTotal: inventory.length,
    importQueue: importQueue.length,
    duplicateFilenameGroups: [...filenameGroups.entries()]
      .filter(([, list]) => list.length > 1)
      .map(([basename, list]) => ({ basename, count: list.length, files: list.map((file) => file.absPath) })),
    durationMs,
    totals: totals(rows),
    scanErrors,
    rows,
  };
  await fs.writeFile(jsonPath, JSON.stringify(payload, null, 2), "utf8");
  await writeMarkdownReport(mdPath, { roots: args.roots, libraryRoot, dbPath, rows, scanErrors, durationMs });
  closeCacheDb();

  console.log("=== Done ===");
  console.log(`totals      : ${JSON.stringify(payload.totals)}`);
  console.log(`json report : ${jsonPath}`);
  console.log(`md report   : ${mdPath}`);
}

main().catch((err) => {
  console.error(err);
  closeCacheDb();
  process.exit(1);
});
