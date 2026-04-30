/**
 * E2E import тест: случайная выборка 1000 книг из папки + детальный отчёт о багах.
 *
 * Цель — симулировать действия пользователя через UI:
 *   1. Пользователь жмёт «Импортировать папку»
 *   2. Bibliary сканирует и импортирует пачку книг
 *   3. Скрипт собирает все warnings/errors в JSONL отчёт
 *   4. Подсчитывает баги по категориям, сохраняет топ-N для исправления
 *
 * Отличия от существующего `e2e-full-corpus-library-import.ts`:
 *   - Случайная выборка (не все файлы) — быстрее, репрезентативнее
 *   - Краткий, человеко-читаемый отчёт + JSONL для grep
 *   - Группирует ошибки по типу (timeout, parse-error, OCR fail, vision fail, ...)
 *   - НЕ исправляет баги (это задача отдельной /fix или /mahakala сессии)
 *
 * Использование (production-like, Electron ABI for better-sqlite3):
 *   $ npm run test:e2e:1000-electron -- --root D:\Bibliarifull --sample 1000
 *   $ npm run test:e2e:1000-electron -- --root <path> --sample 100 --seed 42
 *
 * Plain Node/tsx note:
 *   `npx tsx scripts/e2e-1000-random-sample.ts ...` требует better-sqlite3,
 *   собранный под Node ABI. Реальное приложение работает под Electron ABI,
 *   поэтому рекомендуемый запуск выше идёт через `ELECTRON_RUN_AS_NODE=1`.
 *
 * Требования:
 *   - LM Studio запущен (для vision-meta + evaluator если включены)
 *   - Qdrant запущен (если illustration-worker / dataset-v2 индексируют)
 *   - Папка с книгами по указанному --root
 *
 * Производительность:
 *   - parser pool 4 (BIBLIARY_PARSER_POOL_SIZE)
 *   - illustration semaphore 2 (BIBLIARY_ILLUSTRATION_PARALLEL_BOOKS)
 *   - evaluator auto-paused при > 100 книг (см. library.ipc.ts)
 *
 * Для 1000 книг ожидаемое время: 30-90 минут зависит от средней длины книги
 * и хардвера. Это намеренно — мы тестируем production pipeline, не игрушку.
 */

import { promises as fs } from "fs";
import * as path from "path";
import { randomUUID } from "crypto";

import { importFolderToLibrary, type ImportFolderOptions } from "../electron/lib/library/import.js";
import { openCacheDb, closeCacheDb } from "../electron/lib/library/cache-db.js";
import { _resetLibraryRootCache, getLibraryRoot } from "../electron/lib/library/paths.js";
import { SUPPORTED_BOOK_EXTS } from "../electron/lib/library/types.js";

/* ─── CLI args ──────────────────────────────────────────────────────── */

interface Args {
  root: string;
  sample: number;
  seed: number;
  reportDir: string;
  scanArchives: boolean;
  ocrEnabled: boolean;
  visionMetaEnabled: boolean;
  maxDepth: number;
  /** Останавливаться после первого error чтобы не наполнять лог. */
  stopOnError: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    root: "",
    sample: 1000,
    seed: 42,
    reportDir: "data/e2e-reports",
    scanArchives: false,
    ocrEnabled: false,
    visionMetaEnabled: false,
    maxDepth: 16,
    stopOnError: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--root" && i + 1 < argv.length) out.root = argv[++i]!;
    else if (a.startsWith("--root=")) out.root = a.slice("--root=".length);
    else if (a === "--sample" && i + 1 < argv.length) {
      const n = Number(argv[++i]);
      if (Number.isFinite(n) && n > 0) out.sample = n;
    } else if (a.startsWith("--sample=")) {
      const n = Number(a.slice("--sample=".length));
      if (Number.isFinite(n) && n > 0) out.sample = n;
    } else if (a === "--seed" && i + 1 < argv.length) {
      const n = Number(argv[++i]);
      if (Number.isFinite(n)) out.seed = n;
    } else if (a === "--archives") out.scanArchives = true;
    else if (a === "--ocr") out.ocrEnabled = true;
    else if (a === "--vision-meta") out.visionMetaEnabled = true;
    else if (a === "--stop-on-error") out.stopOnError = true;
    else if (a.startsWith("--max-depth=")) {
      const n = Number(a.slice("--max-depth=".length));
      if (Number.isFinite(n) && n >= 0) out.maxDepth = n;
    }
  }
  return out;
}

/* ─── Discovery: рекурсивно найти все поддерживаемые файлы ──────────── */

async function* discoverFiles(root: string, maxDepth: number, depth = 0): AsyncGenerator<string> {
  if (depth > maxDepth) return;
  let entries: import("fs").Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const abs = path.join(root, e.name);
    if (e.isDirectory()) {
      yield* discoverFiles(abs, maxDepth, depth + 1);
    } else if (e.isFile()) {
      const ext = path.extname(e.name).slice(1).toLowerCase();
      if (SUPPORTED_BOOK_EXTS.has(ext)) {
        yield abs;
      }
    }
  }
}

/* ─── Seedable PRNG (mulberry32) — детерминированная случайная выборка ─ */

function mulberry32(seed: number): () => number {
  let t = seed | 0;
  return function () {
    t = (t + 0x6d2b79f5) | 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/** Reservoir sampling: берёт N случайных из бесконечного потока за один проход. */
async function reservoirSample<T>(stream: AsyncGenerator<T>, n: number, rng: () => number): Promise<T[]> {
  const out: T[] = [];
  let i = 0;
  for await (const item of stream) {
    if (out.length < n) {
      out.push(item);
    } else {
      const j = Math.floor(rng() * (i + 1));
      if (j < n) out[j] = item;
    }
    i += 1;
    if (i % 500 === 0) process.stdout.write(`  scanned ${i} files\r`);
  }
  process.stdout.write(`  scanned ${i} files (total)\n`);
  return out;
}

/* ─── Bug categorization ────────────────────────────────────────────── */

interface BugCategory {
  pattern: RegExp;
  category: string;
}

const BUG_CATEGORIES: BugCategory[] = [
  { pattern: /timeout|timed out/i, category: "timeout" },
  { pattern: /parse(?:r)?\s*(?:fail|error)/i, category: "parser-error" },
  { pattern: /pdf(?:js)?/i, category: "pdf-error" },
  { pattern: /epub/i, category: "epub-error" },
  { pattern: /djvu/i, category: "djvu-error" },
  { pattern: /fb2|fictionbook/i, category: "fb2-error" },
  { pattern: /ocr/i, category: "ocr-error" },
  { pattern: /vision[- ]meta/i, category: "vision-meta-error" },
  { pattern: /illustration/i, category: "illustration-error" },
  { pattern: /isbn/i, category: "isbn-lookup-error" },
  { pattern: /sha-?256|hash/i, category: "hash-error" },
  { pattern: /CAS|blob/i, category: "blob-storage-error" },
  { pattern: /enoent|not found/i, category: "file-not-found" },
  { pattern: /enospc|disk space/i, category: "disk-space" },
  { pattern: /memory|oom|heap/i, category: "memory-error" },
  { pattern: /database|sqlite/i, category: "db-error" },
  { pattern: /qdrant/i, category: "qdrant-error" },
  { pattern: /lm[- ]?studio|llm/i, category: "llm-error" },
  { pattern: /aborted|signal/i, category: "abort" },
  { pattern: /encoding|charset|invalid/i, category: "encoding-error" },
];

function categorizeBug(message: string): string {
  if (/duplicate|SHA-?256 match/i.test(message)) return "duplicate";
  for (const c of BUG_CATEGORIES) {
    if (c.pattern.test(message)) return c.category;
  }
  return "uncategorized";
}

/* ─── Main ──────────────────────────────────────────────────────────── */

interface BookReport {
  sourcePath: string;
  outcome: string;
  bookId?: string;
  title?: string;
  errorMessage?: string;
  warnings: string[];
  durationMs: number;
}

interface AggregateReport {
  ranAt: string;
  args: Args;
  totalDiscovered: number;
  sampled: number;
  imported: { added: number; duplicate: number; skipped: number; failed: number };
  totalDurationMs: number;
  meanDurationMsPerBook: number;
  byBugCategory: Record<string, { count: number; samples: string[] }>;
  failedBooks: BookReport[]; /* только failed/error для быстрого debug */
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!args.root) {
    console.error("ERROR: --root <path> is required");
    console.error("Usage: npx tsx scripts/e2e-1000-random-sample.ts --root D:\\Bibliarifull --sample 1000");
    process.exit(1);
  }

  const rootStat = await fs.stat(args.root).catch(() => null);
  if (!rootStat || !rootStat.isDirectory()) {
    console.error(`ERROR: --root "${args.root}" is not a directory`);
    process.exit(1);
  }

  console.log("🧪 Bibliary E2E — Random sample import test");
  console.log(`   root: ${args.root}`);
  console.log(`   sample: ${args.sample}`);
  console.log(`   seed: ${args.seed}`);
  console.log(`   archives: ${args.scanArchives}, ocr: ${args.ocrEnabled}, vision-meta: ${args.visionMetaEnabled}`);
  console.log("");

  /* Discovery + sampling. */
  console.log("📁 Discovering files...");
  const rng = mulberry32(args.seed);
  const sampled = await reservoirSample(discoverFiles(args.root, args.maxDepth), args.sample, rng);
  console.log(`✓ Sampled ${sampled.length} files`);

  if (sampled.length === 0) {
    console.error(`ERROR: No supported files found in ${args.root}`);
    process.exit(1);
  }

  /* Init library. */
  _resetLibraryRootCache();
  const libRoot = await getLibraryRoot();
  console.log(`📚 Library root: ${libRoot}`);
  openCacheDb();

  const books: BookReport[] = [];
  const startedAt = Date.now();
  let aggregateAdded = 0, aggregateDup = 0, aggregateSkipped = 0, aggregateFailed = 0;
  const aggregateWarnings: string[] = [];

  /* Сохраняем sampled пути в tmp папку и импортируем её через
     importFolderToLibrary — это тот же путь что вызывает UI кнопка
     «Импортировать папку». Симулируем production pipeline. */
  const tmpRoot = path.join(libRoot, ".e2e-tmp", randomUUID().slice(0, 8));
  await fs.mkdir(tmpRoot, { recursive: true });

  /* Создаём симлинки/копии. На Windows симлинки требуют admin прав, поэтому
     копируем (медленнее, но надёжно). На Linux/Mac — симлинки. */
  console.log(`🔗 Linking ${sampled.length} files to ${tmpRoot}...`);
  for (let i = 0; i < sampled.length; i++) {
    const src = sampled[i]!;
    /* Preserve original relative path and filename. Earlier versions prefixed
       files with "0001_", which polluted parser metadata (author/title from
       filename) and made the E2E less like the UI import of the real folder. */
    const rel = path.relative(args.root, src);
    const safeRel = rel
      .split(/[\\/]+/)
      .map((segment) => segment.replace(/[\x00-\x1f<>:"/\\|?*]+/g, "_"))
      .join(path.sep);
    const dest = path.join(tmpRoot, safeRel);
    try {
      await fs.mkdir(path.dirname(dest), { recursive: true });
      if (process.platform === "win32") {
        await fs.copyFile(src, dest);
      } else {
        await fs.symlink(src, dest);
      }
    } catch (e) {
      console.warn(`  skip ${src}: ${e instanceof Error ? e.message : String(e)}`);
    }
    if ((i + 1) % 100 === 0) {
      process.stdout.write(`  prepared ${i + 1}/${sampled.length}\r`);
    }
  }
  process.stdout.write(`  prepared ${sampled.length}/${sampled.length} ✓\n`);

  /* Запускаем production import. */
  console.log("\n🚀 Starting import (this calls the SAME pipeline as the UI button)...\n");
  const opts: ImportFolderOptions = {
    scanArchives: args.scanArchives,
    ocrEnabled: args.ocrEnabled,
    maxDepth: 1, /* tmpRoot плоский */
    visionMetaEnabled: args.visionMetaEnabled,
    onProgress: (evt) => {
      if (evt.phase === "discovered" && evt.discovered % 50 === 0) {
        process.stdout.write(`  discovered ${evt.discovered}\r`);
      } else if (evt.phase === "file-start") {
        const file = path.basename(evt.currentFile ?? "?");
        process.stdout.write(`  [${evt.processed}/${evt.discovered}] ${file.slice(0, 60)}\r`);
      } else if (evt.phase === "processed") {
        const outcome = evt.outcome ?? "?";
        const file = path.basename(evt.currentFile ?? "?");
        if (evt.outcome === "failed") {
          console.log(`\n  ❌ FAIL ${file}: ${evt.errorMessage ?? "unknown"}`);
          aggregateFailed += 1;
        } else if (evt.outcome === "duplicate") {
          aggregateDup += 1;
        } else if (evt.outcome === "skipped") {
          aggregateSkipped += 1;
        } else if (evt.outcome === "added") {
          aggregateAdded += 1;
        }
        if (evt.fileWarnings) aggregateWarnings.push(...evt.fileWarnings);
        books.push({
          sourcePath: evt.currentFile ?? "?",
          outcome: String(outcome),
          errorMessage: evt.errorMessage,
          warnings: evt.fileWarnings ?? [],
          durationMs: 0, /* per-file timing не доступно в этом hook */
        });
        if (args.stopOnError && evt.outcome === "failed") {
          throw new Error(`stop-on-error: ${evt.currentFile}: ${evt.errorMessage}`);
        }
      }
    },
  };

  try {
    const result = await importFolderToLibrary(tmpRoot, opts);
    console.log(`\n✓ Import done: +${result.added} added, ${result.duplicate} dup, ${result.skipped} skip, ${result.failed} fail`);
    aggregateAdded = result.added;
    aggregateDup = result.duplicate;
    aggregateSkipped = result.skipped;
    aggregateFailed = result.failed;
    aggregateWarnings.push(...(result.warnings ?? []));
  } catch (e) {
    console.error(`\n❌ Import threw: ${e instanceof Error ? e.message : String(e)}`);
  }

  const totalDurationMs = Date.now() - startedAt;

  /* Категоризация багов. */
  const byBugCategory: Record<string, { count: number; samples: string[] }> = {};
  for (const w of aggregateWarnings) {
    const cat = categorizeBug(w);
    if (cat === "duplicate") continue; /* duplicates are expected outcomes, not bugs */
    if (!byBugCategory[cat]) byBugCategory[cat] = { count: 0, samples: [] };
    byBugCategory[cat]!.count += 1;
    if (byBugCategory[cat]!.samples.length < 3) {
      byBugCategory[cat]!.samples.push(w.slice(0, 200));
    }
  }
  for (const b of books) {
    if (b.errorMessage) {
      const cat = categorizeBug(b.errorMessage);
      if (cat === "duplicate") continue;
      if (!byBugCategory[cat]) byBugCategory[cat] = { count: 0, samples: [] };
      byBugCategory[cat]!.count += 1;
      if (byBugCategory[cat]!.samples.length < 3) {
        byBugCategory[cat]!.samples.push(`${path.basename(b.sourcePath)}: ${b.errorMessage.slice(0, 200)}`);
      }
    }
  }

  /* Aggregate report. */
  const aggregate: AggregateReport = {
    ranAt: new Date(startedAt).toISOString(),
    args,
    totalDiscovered: sampled.length,
    sampled: sampled.length,
    imported: { added: aggregateAdded, duplicate: aggregateDup, skipped: aggregateSkipped, failed: aggregateFailed },
    totalDurationMs,
    meanDurationMsPerBook: sampled.length > 0 ? totalDurationMs / sampled.length : 0,
    byBugCategory,
    failedBooks: books.filter((b) => b.outcome === "failed" || b.errorMessage).slice(0, 50),
  };

  /* Сохраняем отчёты. */
  await fs.mkdir(args.reportDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const reportPath = path.join(args.reportDir, `e2e-1000-${ts}.json`);
  const jsonlPath = path.join(args.reportDir, `e2e-1000-${ts}.jsonl`);
  await fs.writeFile(reportPath, JSON.stringify(aggregate, null, 2));
  const jsonlLines = books.map((b) => JSON.stringify(b)).join("\n");
  await fs.writeFile(jsonlPath, jsonlLines + "\n");

  /* Печатаем суммарный отчёт. */
  console.log("\n══════════════════════════════════════════════════════════════════");
  console.log("📊 E2E REPORT");
  console.log("══════════════════════════════════════════════════════════════════");
  console.log(`Total time:     ${(totalDurationMs / 1000).toFixed(1)}s (${(totalDurationMs / 60000).toFixed(1)} min)`);
  console.log(`Mean per book:  ${(aggregate.meanDurationMsPerBook / 1000).toFixed(2)}s`);
  console.log(`\nOutcomes:`);
  console.log(`  ✓ Added:      ${aggregateAdded}`);
  console.log(`  ⚠ Duplicate:  ${aggregateDup}`);
  console.log(`  ⊘ Skipped:    ${aggregateSkipped}`);
  console.log(`  ✗ Failed:     ${aggregateFailed}`);
  console.log(`  Total:        ${aggregateAdded + aggregateDup + aggregateSkipped + aggregateFailed}`);

  if (Object.keys(byBugCategory).length > 0) {
    console.log(`\n🐛 Bugs by category:`);
    const sorted = Object.entries(byBugCategory).sort((a, b) => b[1].count - a[1].count);
    for (const [cat, info] of sorted) {
      console.log(`  ${cat.padEnd(24)} ${String(info.count).padStart(4)}  e.g. "${info.samples[0] ?? "?"}"`);
    }
  }

  console.log(`\n📁 Reports:`);
  console.log(`   summary:  ${reportPath}`);
  console.log(`   per-book: ${jsonlPath}`);
  console.log(`\n🗑  Cleanup tmp: ${tmpRoot}`);
  await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
  closeCacheDb();
  console.log("\n══════════════════════════════════════════════════════════════════\n");
}

void main().catch((e) => {
  console.error("E2E test failed:", e);
  process.exit(1);
});
