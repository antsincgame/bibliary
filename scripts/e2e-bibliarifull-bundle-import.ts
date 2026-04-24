/**
 * Clean E2E import for a torrent-like book dump.
 *
 * Contract:
 * - A top-level file or directory under --root is one source item ("torrent/book").
 * - For a top-level directory, scan only --max-depth levels and pick one best
 *   representative book file. This prevents README files, course steps, and
 *   auxiliary PDFs from inflating a ~500-book dump into thousands of catalog rows.
 * - Import uses the production library pipeline: SHA/ISBN/revision dedup,
 *   original copy, book.md, SQLite cache.
 */

import { promises as fs } from "fs";
import * as path from "path";

const DEFAULT_ROOT = "D:\\Bibliarifull";
const DEFAULT_DATA_DIR = path.resolve(process.cwd(), "release", "dist-portable", "data");

interface Args {
  root: string;
  dataDir: string;
  clean: boolean;
  maxDepth: number;
  scanArchives: boolean;
}

interface Candidate {
  path: string;
  ext: string;
  sizeBytes: number;
  score: number;
}

const BOOK_EXTS = new Set([".pdf", ".epub", ".fb2", ".docx", ".txt", ".djvu"]);
const ARCHIVE_EXTS = new Set([".zip", ".cbz", ".rar", ".cbr", ".7z"]);
const MIN_BYTES = 10_240;
const BAD_BASENAME = new Set([
  "readme", "readme.txt", "license", "license.txt", "changelog", "changes",
  "cover", "front", "back", "index", "contents",
]);

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | null => {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1]! : null;
  };
  const n = Number(get("--max-depth") ?? "3");
  return {
    root: get("--root") ?? DEFAULT_ROOT,
    dataDir: get("--data-dir") ?? DEFAULT_DATA_DIR,
    clean: argv.includes("--clean"),
    maxDepth: Number.isFinite(n) && n >= 0 ? Math.floor(n) : 3,
    scanArchives: !argv.includes("--no-archives"),
  };
}

function isSupportedFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return BOOK_EXTS.has(ext) || ARCHIVE_EXTS.has(ext);
}

function extensionPriority(ext: string): number {
  switch (ext) {
    case ".epub": return 90;
    case ".fb2": return 85;
    case ".pdf": return 80;
    case ".djvu": return 75;
    case ".docx": return 55;
    case ".zip":
    case ".cbz":
    case ".rar":
    case ".cbr":
    case ".7z": return 50;
    case ".txt": return 20;
    default: return 0;
  }
}

function tokenize(s: string): Set<string> {
  return new Set(s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").split(/\s+/).filter((x) => x.length >= 3));
}

function similarity(a: string, b: string): number {
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let hit = 0;
  for (const x of ta) if (tb.has(x)) hit++;
  return hit / Math.max(ta.size, tb.size);
}

function scoreCandidate(filePath: string, sizeBytes: number, topName: string): Candidate {
  const ext = path.extname(filePath).toLowerCase();
  const base = path.basename(filePath, ext);
  const lowerBase = path.basename(filePath).toLowerCase();
  let score = extensionPriority(ext);
  score += Math.min(25, Math.log2(Math.max(1, sizeBytes / 1024)));
  score += similarity(base, topName) * 40;
  if (BAD_BASENAME.has(lowerBase) || BAD_BASENAME.has(base.toLowerCase())) score -= 100;
  if (/readme|license|cover|scan|sample|part\s*\d+|stepik|шаг\s*\d+/i.test(base)) score -= 25;
  return { path: filePath, ext, sizeBytes, score };
}

async function collectCandidates(dir: string, topName: string, maxDepth: number): Promise<Candidate[]> {
  const out: Candidate[] = [];
  async function walk(cur: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    let entries: import("fs").Dirent[];
    try {
      entries = await fs.readdir(cur, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(cur, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
        await walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile() || !isSupportedFile(full)) continue;
      let st;
      try {
        st = await fs.stat(full);
      } catch {
        continue;
      }
      if (st.size < MIN_BYTES) continue;
      out.push(scoreCandidate(full, st.size, topName));
    }
  }
  await walk(dir, 0);
  out.sort((a, b) => b.score - a.score || b.sizeBytes - a.sizeBytes);
  return out;
}

async function backupIfExists(p: string, backupDir: string): Promise<void> {
  try {
    await fs.access(p);
  } catch {
    return;
  }
  await fs.mkdir(backupDir, { recursive: true });
  await fs.rename(p, path.join(backupDir, path.basename(p)));
}

async function cleanDataDir(dataDir: string): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = path.join(dataDir, "_backup-before-bibliarifull", stamp);
  await backupIfExists(path.join(dataDir, "library"), backupDir);
  await backupIfExists(path.join(dataDir, "bibliary-cache.db"), backupDir);
  await backupIfExists(path.join(dataDir, "bibliary-cache.db-wal"), backupDir);
  await backupIfExists(path.join(dataDir, "bibliary-cache.db-shm"), backupDir);
  return backupDir;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const root = path.resolve(args.root);
  const dataDir = path.resolve(args.dataDir);
  process.env.BIBLIARY_DATA_DIR = dataDir;
  process.env.BIBLIARY_PARSE_WORKERS = process.env.BIBLIARY_PARSE_WORKERS ?? "1";

  const { importFile } = await import("../electron/lib/library/import.js");
  const { _resetLibraryRootCache, getLibraryRoot } = await import("../electron/lib/library/paths.js");
  const { closeCacheDb, openCacheDb, getCacheDbPath } = await import("../electron/lib/library/cache-db.js");
  _resetLibraryRootCache();
  closeCacheDb();

  if (args.clean) {
    const backupDir = await cleanDataDir(dataDir);
    console.log(`[clean] previous catalog moved to ${backupDir}`);
  }

  await fs.mkdir(dataDir, { recursive: true });
  const libraryRoot = await getLibraryRoot();
  console.log(`Root       : ${root}`);
  console.log(`Data dir   : ${dataDir}`);
  console.log(`Library    : ${libraryRoot}`);
  console.log(`SQLite     : ${getCacheDbPath()}`);
  console.log(`maxDepth   : ${args.maxDepth}`);
  console.log(`archives   : ${args.scanArchives}`);

  const top = await fs.readdir(root, { withFileTypes: true });
  const selected: Array<{ source: string; candidate: Candidate }> = [];
  const noCandidate: string[] = [];
  for (const entry of top) {
    const full = path.join(root, entry.name);
    if (entry.isFile()) {
      if (!isSupportedFile(full)) {
        noCandidate.push(full);
        continue;
      }
      const st = await fs.stat(full);
      if (st.size < MIN_BYTES) {
        noCandidate.push(full);
        continue;
      }
      selected.push({ source: full, candidate: scoreCandidate(full, st.size, entry.name) });
      continue;
    }
    if (!entry.isDirectory()) continue;
    const candidates = await collectCandidates(full, entry.name, args.maxDepth);
    const best = candidates[0];
    if (best) selected.push({ source: full, candidate: best });
    else noCandidate.push(full);
  }

  console.log(`Top items  : ${top.length}`);
  console.log(`Selected   : ${selected.length}`);
  console.log(`No book    : ${noCandidate.length}`);

  const totals = { added: 0, duplicate: 0, skipped: 0, failed: 0 };
  const failed: Array<{ source: string; file: string; error?: string }> = [];
  const picked = selected.map((x) => ({ source: x.source, file: x.candidate.path, score: x.candidate.score, sizeBytes: x.candidate.sizeBytes }));

  for (let i = 0; i < selected.length; i++) {
    const item = selected[i]!;
    const rel = path.relative(root, item.candidate.path);
    process.stdout.write(`[${i + 1}/${selected.length}] ${rel} ... `);
    try {
      const results = await importFile(item.candidate.path, { scanArchives: args.scanArchives });
      for (const r of results) {
        totals[r.outcome] += 1;
        if (r.outcome === "failed") failed.push({ source: item.source, file: item.candidate.path, error: r.error });
      }
      console.log(results.map((r) => r.outcome).join(","));
    } catch (e) {
      totals.failed += 1;
      const error = e instanceof Error ? e.message : String(e);
      failed.push({ source: item.source, file: item.candidate.path, error });
      console.log(`failed: ${error}`);
    }
  }

  const db = openCacheDb();
  const dbTotal = (db.prepare("SELECT COUNT(*) AS n FROM books").get() as { n: number }).n;
  const statusRows = db.prepare("SELECT status, COUNT(*) AS n FROM books GROUP BY status ORDER BY n DESC").all();
  const reportDir = path.join(process.cwd(), "release", "e2e-bibliarifull-report");
  await fs.mkdir(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, `${new Date().toISOString().replace(/[:.]/g, "-")}-bundle.json`);
  await fs.writeFile(reportPath, JSON.stringify({
    root,
    dataDir,
    libraryRoot,
    maxDepth: args.maxDepth,
    topItems: top.length,
    selected: selected.length,
    noCandidate,
    picked,
    totals,
    failed,
    dbTotal,
    statusRows,
  }, null, 2), "utf8");

  console.log(`Totals     : ${JSON.stringify(totals)}`);
  console.log(`DB total   : ${dbTotal}`);
  console.log(`Statuses   : ${JSON.stringify(statusRows)}`);
  console.log(`Report     : ${reportPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
