/**
 * Нагрузочный прогон Librarian на реальной библиотеке.
 *
 * Идёт по `--folder=PATH`, собирает все файлы поддерживаемых форматов
 * (pdf/epub/djvu/fb2/docx/rtf/odt/html/htm/txt), отдаёт в `findDuplicates`
 * без LLM tie-break (deterministic only).
 *
 * Замеряет:
 *   - время сбора файлов
 *   - время кластеризации
 *   - количество кластеров и кандидатов на удаление (runners-up)
 *   - топ-5 кластеров по размеру
 *   - сколько места можно освободить, удалив runners-up
 *
 * Запуск:
 *   npx tsx scripts/load-librarian.ts --folder=D:\Bibliarifull
 *   npx tsx scripts/load-librarian.ts --folder=D:\Bibliarifull --limit=5000
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { findDuplicates, type LibrarianFile } from "../electron/lib/library/librarian.ts";

const SUPPORTED = new Set(["pdf", "epub", "djvu", "fb2", "docx", "doc", "rtf", "odt", "html", "htm", "txt"]);

interface Args {
  folder: string;
  limit?: number;
  outFile: string;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { folder: "", outFile: path.resolve("release", "librarian-load-report.json") };
  for (const arg of argv.slice(2)) {
    const m = /^--([^=]+)=(.+)$/.exec(arg);
    if (!m) continue;
    if (m[1] === "folder") out.folder = m[2]!;
    else if (m[1] === "limit") out.limit = Number(m[2]);
    else if (m[1] === "out") out.outFile = m[2]!;
  }
  if (!out.folder) {
    console.error("Usage: --folder=PATH [--limit=N] [--out=PATH]");
    process.exit(2);
  }
  return out;
}

async function* walk(dir: string): AsyncGenerator<{ absPath: string; sizeBytes: number }> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      yield* walk(full);
    } else if (ent.isFile()) {
      const ext = path.extname(ent.name).toLowerCase().slice(1);
      if (!SUPPORTED.has(ext)) continue;
      try {
        const st = await fs.stat(full);
        yield { absPath: full, sizeBytes: st.size };
      } catch {
        /* ignore unreadable */
      }
    }
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  console.log(`▣ Нагрузочный прогон Librarian`);
  console.log(`   folder: ${args.folder}`);
  console.log(`   limit: ${args.limit ?? "none"}\n`);

  const t0 = Date.now();
  const files: LibrarianFile[] = [];
  let scanned = 0;
  for await (const f of walk(args.folder)) {
    files.push(f);
    scanned++;
    if (scanned % 500 === 0) process.stdout.write(`   …собрано ${scanned} файлов\r`);
    if (args.limit && scanned >= args.limit) break;
  }
  const tWalk = Date.now() - t0;
  console.log(`\n   Найдено ${files.length} файлов за ${(tWalk / 1000).toFixed(1)}s`);

  const totalSize = files.reduce((s, f) => s + (f.sizeBytes ?? 0), 0);
  console.log(`   Суммарный размер: ${(totalSize / 1024 / 1024 / 1024).toFixed(2)} GB`);

  const t1 = Date.now();
  const clusters = await findDuplicates(files, {
    enableLlmTieBreak: false,
    onProgress: (e) => {
      if (e.type === "librarian.start") {
        process.stdout.write(`   Кластеров для проверки: ${e.total}\n`);
      } else if (e.type === "librarian.done") {
        process.stdout.write(`   Дубликатов найдено: ${e.duplicates}\n`);
      }
    },
  });
  const tCluster = Date.now() - t1;
  console.log(`   Кластеризация: ${(tCluster / 1000).toFixed(2)}s`);

  const dupSize = clusters.reduce((s, c) => s + c.runnersUp.reduce((a, f) => a + (f.sizeBytes ?? 0), 0), 0);
  const totalDups = clusters.reduce((s, c) => s + c.runnersUp.length, 0);

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`📊 РЕЗУЛЬТАТЫ`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`Файлов проверено:     ${files.length}`);
  console.log(`Кластеров с дубл-ми:  ${clusters.length}`);
  console.log(`Лишних копий:         ${totalDups}`);
  console.log(`Можно освободить:     ${(dupSize / 1024 / 1024 / 1024).toFixed(2)} GB`);
  console.log(`Время walk:           ${(tWalk / 1000).toFixed(1)}s`);
  console.log(`Время cluster:        ${(tCluster / 1000).toFixed(2)}s`);

  /* TOP-5 крупнейших кластеров */
  const top = [...clusters].sort((a, b) => (b.runnersUp.length + 1) - (a.runnersUp.length + 1)).slice(0, 10);
  if (top.length > 0) {
    console.log(`\n▣ TOP-10 крупнейших кластеров:`);
    for (const c of top) {
      console.log(`  «${c.signature.slice(0, 70)}» × ${c.runnersUp.length + 1}`);
      console.log(`     winner:  ${path.basename(c.winner.absPath)}  (${((c.winner.sizeBytes ?? 0) / 1024 / 1024).toFixed(1)} MB)`);
      for (const r of c.runnersUp.slice(0, 3)) {
        console.log(`     dup:     ${path.basename(r.absPath)}  (${((r.sizeBytes ?? 0) / 1024 / 1024).toFixed(1)} MB)`);
      }
      if (c.runnersUp.length > 3) console.log(`     …+${c.runnersUp.length - 3} more`);
      console.log(`     reason:  ${c.reason}`);
    }
  }

  await fs.mkdir(path.dirname(args.outFile), { recursive: true });
  await fs.writeFile(args.outFile, JSON.stringify({
    folder: args.folder,
    scannedAt: new Date().toISOString(),
    stats: {
      filesScanned: files.length,
      totalSizeBytes: totalSize,
      clustersFound: clusters.length,
      duplicatesFound: totalDups,
      duplicateSizeBytes: dupSize,
      walkMs: tWalk,
      clusterMs: tCluster,
    },
    topClusters: top.map((c) => ({
      signature: c.signature,
      size: c.runnersUp.length + 1,
      winner: c.winner.absPath,
      runnersUp: c.runnersUp.map((r) => r.absPath),
      reason: c.reason,
    })),
  }, null, 2), "utf8");
  console.log(`\n📄 Отчёт: ${args.outFile}`);
}

main().catch((e) => {
  console.error("✗ Load-test failed:", e);
  process.exit(1);
});
