/**
 * Прогон discoverBundle на реальных подпапках, чтобы убедиться, что
 * classifier не падает на «грязном мире» и видит правильные комплекты.
 *
 * Запуск:
 *   npx tsx scripts/load-bundle-classifier.ts --folder=D:\Bibliarifull --depth=2
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { discoverBundle } from "../electron/lib/scanner/folder-bundle/classifier.ts";

interface Args { folder: string; depth: number; outFile: string }
function parseArgs(argv: string[]): Args {
  const out: Args = { folder: "", depth: 2, outFile: path.resolve("release", "bundle-classifier-report.json") };
  for (const a of argv.slice(2)) {
    const m = /^--([^=]+)=(.+)$/.exec(a);
    if (!m) continue;
    if (m[1] === "folder") out.folder = m[2]!;
    else if (m[1] === "depth") out.depth = Number(m[2]);
    else if (m[1] === "out") out.outFile = m[2]!;
  }
  if (!out.folder) { console.error("--folder=PATH required"); process.exit(2); }
  return out;
}

async function listSubdirs(root: string, maxDepth: number, currentDepth = 0): Promise<string[]> {
  if (currentDepth >= maxDepth) return [];
  const out: string[] = [];
  let entries: import("node:fs").Dirent[];
  try { entries = await fs.readdir(root, { withFileTypes: true }); } catch { return []; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const full = path.join(root, e.name);
    out.push(full);
    if (currentDepth + 1 < maxDepth) {
      const nested = await listSubdirs(full, maxDepth, currentDepth + 1);
      out.push(...nested);
    }
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  console.log(`▣ Folder-bundle classifier load test`);
  console.log(`   folder: ${args.folder}, depth: ${args.depth}\n`);

  const dirs = [args.folder, ...(await listSubdirs(args.folder, args.depth))];
  console.log(`   Папок к проверке: ${dirs.length}`);

  const reports: Array<{
    dir: string;
    book: string | null;
    sidecars: { kind: string; count: number }[];
    skipped: number;
    warnings: string[];
    durationMs: number;
  }> = [];

  let total = 0;
  let withBook = 0;
  let totalSidecars = 0;
  let totalSkipped = 0;
  const warningsCount = new Map<string, number>();
  const sidecarKindCount = new Map<string, number>();

  for (const dir of dirs) {
    const t0 = Date.now();
    try {
      const bundle = await discoverBundle(dir);
      const dur = Date.now() - t0;
      total++;
      if (bundle.book) withBook++;
      totalSidecars += bundle.sidecars.length;
      totalSkipped += bundle.skipped.length;
      const sidecarKinds = new Map<string, number>();
      for (const s of bundle.sidecars) {
        sidecarKinds.set(s.kind, (sidecarKinds.get(s.kind) ?? 0) + 1);
        sidecarKindCount.set(s.kind, (sidecarKindCount.get(s.kind) ?? 0) + 1);
      }
      for (const w of bundle.warnings) {
        const key = w.replace(/[\d]+/g, "N").slice(0, 80);
        warningsCount.set(key, (warningsCount.get(key) ?? 0) + 1);
      }
      reports.push({
        dir,
        book: bundle.book?.relPath ?? null,
        sidecars: [...sidecarKinds.entries()].map(([kind, count]) => ({ kind, count })),
        skipped: bundle.skipped.length,
        warnings: bundle.warnings,
        durationMs: dur,
      });
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      reports.push({
        dir, book: null, sidecars: [], skipped: 0,
        warnings: [`CLASSIFIER FAILED: ${reason}`],
        durationMs: Date.now() - t0,
      });
      warningsCount.set(`CLASSIFIER FAILED`, (warningsCount.get(`CLASSIFIER FAILED`) ?? 0) + 1);
    }
  }

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`📊 СТАТИСТИКА КЛАССИФИКАЦИИ`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`Папок:                  ${total}`);
  console.log(`С главной книгой:       ${withBook} (${Math.round(withBook / total * 100)}%)`);
  console.log(`Всего sidecars:         ${totalSidecars}`);
  console.log(`Skipped:                ${totalSkipped}`);
  console.log(`\nSidecar по типам:`);
  for (const [kind, count] of [...sidecarKindCount.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${kind.padEnd(12)} ${count}`);
  }
  if (warningsCount.size > 0) {
    console.log(`\nЧастые warnings (top-10):`);
    for (const [w, c] of [...warningsCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
      console.log(`  [×${c}] ${w}`);
    }
  }

  /* TOP-5 папок с наибольшим числом sidecars (лучшие кандидаты для bundle import) */
  const topBundles = [...reports]
    .filter((r) => r.book && r.sidecars.length > 0)
    .sort((a, b) => b.sidecars.reduce((s, x) => s + x.count, 0) - a.sidecars.reduce((s, x) => s + x.count, 0))
    .slice(0, 10);
  if (topBundles.length > 0) {
    console.log(`\n▣ TOP-10 кандидатов на bundle-import:`);
    for (const r of topBundles) {
      const total = r.sidecars.reduce((s, x) => s + x.count, 0);
      console.log(`  ${path.basename(r.dir)} (${total} sidecars)`);
      console.log(`     book: ${r.book}`);
      for (const s of r.sidecars) console.log(`     ${s.kind}: ${s.count}`);
    }
  }

  await fs.mkdir(path.dirname(args.outFile), { recursive: true });
  await fs.writeFile(args.outFile, JSON.stringify({
    folder: args.folder, depth: args.depth, generatedAt: new Date().toISOString(),
    totals: {
      foldersChecked: total, withBook, totalSidecars, totalSkipped,
      sidecarKindCount: Object.fromEntries(sidecarKindCount),
      warningsCount: Object.fromEntries(warningsCount),
    },
    topBundles: topBundles.map((r) => ({
      dir: r.dir, book: r.book,
      sidecarsTotal: r.sidecars.reduce((s, x) => s + x.count, 0),
      sidecarsByKind: r.sidecars,
    })),
    failures: reports.filter((r) => r.warnings.some((w) => w.startsWith("CLASSIFIER FAILED"))).map((r) => ({
      dir: r.dir, error: r.warnings[0],
    })),
  }, null, 2), "utf8");
  console.log(`\n📄 Отчёт: ${args.outFile}`);
}

main().catch((e) => { console.error("✗ failed:", e); process.exit(1); });
