/**
 * E2E stress: массовый импорт папки с книгами через тот же конвейер, что в приложении
 * (`importFolderToLibrary` — file-walker, дедуп SHA/ISBN/ревизия, копирование в
 * `data/library`, SQLite `bibliary-cache.db`).
 *
 * Пример (полный прогон с глубиной 16, архивы вкл.):
 *   npx tsx scripts/e2e-bibliarifull-library-import.ts --root "D:\\Bibliarifull" --max-depth 16
 *
 * Только 3 уровня вложенности папок (как в задании):
 *   --max-depth 3
 *
 * Ограничение числа книг-задач (smoke, не вся папка):
 *   --max-discovered 50
 *
 * Кастомные пути БД/библиотеки (см. paths.ts / cache-db):
 *   $env:BIBLIARY_DATA_DIR = "D:\bibliary-data"
 */

import { promises as fs } from "fs";
import * as path from "path";
import { importFolderToLibrary } from "../electron/lib/library/import.js";
import { getLibraryRoot, _resetLibraryRootCache } from "../electron/lib/library/paths.js";
import { openCacheDb, closeCacheDb, getCacheDbPath } from "../electron/lib/library/cache-db.js";

const COLOR = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
};

function parseArgs(argv: string[]) {
  const get = (f: string): string | null => {
    const i = argv.indexOf(f);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1]! : null;
  };
  const num = (f: string, d: number | null): number | null => {
    const v = get(f);
    if (v === null) return d;
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
  };
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(`
e2e-bibliarifull-library-import — массовый импорт в каталог Bibliary

  --root <dir>         Корень с книгами (default: D:\\\\Bibliarifull)
  --max-depth <n>      Глубина обхода file-walker (default: 16; «3 уровня» → 3)
  --max-discovered <n> Макс. число найденных книг-задач (для smoke; без флага — без лимита)
  --scan-archives      Распаковывать zip/cbr/… (default: on)
  --no-archives
  --ocr                Включить OCR для PDF (медленно)

ENV: BIBLIARY_DATA_DIR, BIBLIARY_LIBRARY_ROOT, BIBLIARY_LIBRARY_DB
`.trim());
    process.exit(0);
  }
  return {
    root: get("--root") ?? "D:\\Bibliarifull",
    maxDepth: num("--max-depth", 16) ?? 16,
    maxDiscovered: num("--max-discovered", null),
    scanArchives: !argv.includes("--no-archives"),
    ocr: argv.includes("--ocr"),
  };
}

function bookCount(): number {
  const db = openCacheDb();
  const r = db.prepare("SELECT COUNT(*) AS n FROM books").get() as { n: number };
  return r.n;
}

let currentFile: string | null = null;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  _resetLibraryRootCache();
  const root = path.resolve(args.root);
  let st: Awaited<ReturnType<typeof fs.stat>>;
  try {
    st = await fs.stat(root);
  } catch (e) {
    console.error(`${COLOR.red}Каталог не найден или нет доступа: ${root}${COLOR.reset}`);
    process.exit(2);
  }
  if (!st.isDirectory()) {
    console.error(`${COLOR.red}Не каталог: ${root}${COLOR.reset}`);
    process.exit(2);
  }

  const before = openCacheDb();
  const nBefore = (before.prepare("SELECT COUNT(*) AS n FROM books").get() as { n: number }).n;
  const libRoot = await getLibraryRoot();
  const dbPath = getCacheDbPath();

  console.log(`${COLOR.bold}=== E2E: массовый импорт (Bibliary library pipeline) ===${COLOR.reset}`);
  console.log(`Корень источника : ${root}`);
  console.log(`maxDepth         : ${args.maxDepth}`);
  console.log(`maxDiscovered    : ${args.maxDiscovered ?? "∞"}`);
  console.log(`scanArchives     : ${args.scanArchives}`);
  console.log(`ocr              : ${args.ocr}`);
  console.log(`Library FS       : ${libRoot}`);
  console.log(`SQLite           : ${dbPath}`);
  console.log(`Книг в БД до     : ${nBefore}\n`);

  const t0 = Date.now();
  let lastP = 0;
  const failedFiles: string[] = [];
  const result = await importFolderToLibrary(root, {
    scanArchives: args.scanArchives,
    ocrEnabled: args.ocr,
    maxDepth: args.maxDepth,
    maxDiscovered: args.maxDiscovered ?? undefined,
    onProgress: (ev) => {
      if (ev.currentFile) currentFile = ev.currentFile;
      if (ev.phase === "processed" && ev.outcome === "failed" && ev.currentFile) {
        failedFiles.push(ev.currentFile);
      }
      if (ev.phase === "processed" && ev.processed - lastP >= 10) {
        lastP = ev.processed;
        console.log(
          `${COLOR.dim}[${new Date().toISOString().slice(11, 19)}] processed ${ev.processed}/${ev.discovered} …${path.basename(ev.currentFile ?? "")}${COLOR.reset}`,
        );
      }
    },
  });

  const ms = Date.now() - t0;
  const nAfter = bookCount();
  const addedNet = nAfter - nBefore;

  closeCacheDb();

  console.log(`\n${COLOR.bold}=== Результат importFolderToLibrary ===${COLOR.reset}`);
  console.log(`total (обработано задач): ${result.total}`);
  console.log(`added: ${result.added} | duplicate: ${result.duplicate} | skipped: ${result.skipped} | failed: ${result.failed}`);
  console.log(`время: ${(ms / 1000).toFixed(1)}s`);
  console.log(`книг в БД: ${nBefore} → ${nAfter} (Δ ${addedNet >= 0 ? "+" : ""}${addedNet})`);
  if (result.warnings.length > 0) {
    const cap = 30;
    console.log(`\n${COLOR.yellow}warnings (показаны до ${cap}):${COLOR.reset}`);
    for (const w of result.warnings.slice(0, cap)) console.log(`  ${w}`);
    if (result.warnings.length > cap) console.log(`  … +${result.warnings.length - cap} ещё`);
  }
  if (result.failed > 0) {
    console.log(`\n${COLOR.red}Есть failed — см. логи/фронтматтер ошибок в предупреждениях выше.${COLOR.reset}`);
    for (const file of failedFiles.slice(0, 20)) {
      console.log(`  FAILED: ${file}`);
    }
    if (failedFiles.length > 20) console.log(`  … +${failedFiles.length - 20} ещё`);
  }
  const reportPath = path.join("release", "e2e-bibliarifull-report", `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  try {
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(
      reportPath,
      JSON.stringify(
        {
          root,
          maxDepth: args.maxDepth,
          maxDiscovered: args.maxDiscovered,
          durationMs: ms,
          nBefore,
          nAfter,
          result,
          failedFiles,
        },
        null,
        2,
      ),
      "utf8",
    );
    console.log(`\nОтчёт: ${reportPath}`);
  } catch {
    /* ignore */
  }
}

process.on("unhandledRejection", (reason) => {
  const msg = reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason);
  const file = currentFile ? ` while processing ${currentFile}` : "";
  console.error(`\n[unhandled-rejection swallowed${file}] ${msg.slice(0, 300)}\n`);
});

process.on("uncaughtException", (err) => {
  const file = currentFile ? ` while processing ${currentFile}` : "";
  console.error(`\n[uncaught-exception swallowed${file}] ${err.name}: ${err.message.slice(0, 300)}\n`);
});

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
