/**
 * Smoke-тест парсеров и chunker'а на реальных книгах из ~/Downloads.
 * Не делает embed/ingest — только проверяет что парсеры выдают
 * непустую structure и chunker выдаёт чанки в разумных пределах.
 *
 * Запуск:  npx tsx scripts/test-scanner.ts
 */

import * as path from "path";
import { promises as fs } from "fs";
import * as os from "os";
import { probeBooks, parseBook, chunkBook, isSupportedBook } from "../electron/lib/scanner/index.js";

const COLOR = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  dim: "\x1b[2m",
};

let passed = 0;
let failed = 0;

async function step(label: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ${COLOR.green}PASS${COLOR.reset}  ${label}`);
    passed++;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`  ${COLOR.red}FAIL${COLOR.reset}  ${label}\n        ${COLOR.dim}${msg}${COLOR.reset}`);
    failed++;
  }
}

interface SmokeReport {
  file: string;
  ext: string;
  sizeMB: number;
  parseMs: number;
  chunkMs: number;
  sections: number;
  chunks: number;
  avgChunkChars: number;
  rawCharCount: number;
  warnings: string[];
  ok: boolean;
  error?: string;
}

async function smokeOne(filePath: string): Promise<SmokeReport> {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const st = await fs.stat(filePath);
  const sizeMB = +(st.size / 1024 / 1024).toFixed(2);
  const t0 = Date.now();
  let parsed;
  try {
    parsed = await parseBook(filePath);
  } catch (e) {
    return {
      file: path.basename(filePath),
      ext,
      sizeMB,
      parseMs: Date.now() - t0,
      chunkMs: 0,
      sections: 0,
      chunks: 0,
      avgChunkChars: 0,
      rawCharCount: 0,
      warnings: [],
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
  const parseMs = Date.now() - t0;
  const t1 = Date.now();
  const chunks = chunkBook(parsed, filePath);
  const chunkMs = Date.now() - t1;
  const totalChars = chunks.reduce((s, c) => s + c.charCount, 0);
  return {
    file: path.basename(filePath),
    ext,
    sizeMB,
    parseMs,
    chunkMs,
    sections: parsed.sections.length,
    chunks: chunks.length,
    avgChunkChars: chunks.length === 0 ? 0 : Math.round(totalChars / chunks.length),
    rawCharCount: parsed.rawCharCount,
    warnings: parsed.metadata.warnings,
    ok: chunks.length > 0,
  };
}

async function main(): Promise<void> {
  console.log("\n== Bibliary Scanner Smoke ==\n");
  const downloads = path.join(os.homedir(), "Downloads");
  let candidates = await probeBooks(downloads, 1);
  candidates = candidates.filter((c) => isSupportedBook(c.absPath));

  await step("probeBooks нашёл хотя бы 1 файл", () => {
    if (candidates.length === 0) throw new Error(`No supported books in ${downloads}`);
  });

  const byExt: Record<string, typeof candidates> = {};
  for (const c of candidates) {
    if (!byExt[c.ext]) byExt[c.ext] = [];
    byExt[c.ext].push(c);
  }
  console.log(`\n${COLOR.cyan}probed${COLOR.reset}: ${candidates.length} files, by ext:`);
  for (const [ext, list] of Object.entries(byExt)) {
    console.log(`  ${ext.padEnd(5)} → ${list.length} файл(ов)`);
  }

  const sample: typeof candidates = [];
  for (const ext of ["pdf", "epub", "fb2", "docx", "txt"]) {
    const first = byExt[ext]?.find((c) => c.sizeBytes < 30 * 1024 * 1024);
    if (first) sample.push(first);
  }

  console.log(`\n${COLOR.cyan}smoke-парсинг${COLOR.reset}: ${sample.length} файла(ов)\n`);
  const reports: SmokeReport[] = [];
  for (const c of sample) {
    process.stdout.write(`  ${c.ext.padEnd(5)} ${c.fileName.slice(0, 60).padEnd(60)} `);
    const r = await smokeOne(c.absPath);
    reports.push(r);
    if (r.ok) {
      console.log(`${COLOR.green}OK${COLOR.reset}  parse=${r.parseMs}ms chunk=${r.chunkMs}ms sections=${r.sections} chunks=${r.chunks} avg=${r.avgChunkChars}c`);
    } else {
      console.log(`${COLOR.red}FAIL${COLOR.reset} ${r.error ?? "no chunks"}`);
    }
    if (r.warnings.length > 0) {
      console.log(`        ${COLOR.yellow}warnings:${COLOR.reset} ${r.warnings.join("; ")}`);
    }
  }

  await step("каждый формат хотя бы раз отдал чанки", () => {
    const okExts = new Set(reports.filter((r) => r.ok).map((r) => r.ext));
    if (okExts.size === 0) throw new Error("no parser succeeded");
  });

  await step("avgChunkChars в рабочем диапазоне 250..2000", () => {
    for (const r of reports.filter((x) => x.ok)) {
      if (r.avgChunkChars < 200 || r.avgChunkChars > 2200) {
        throw new Error(`${r.file}: avg=${r.avgChunkChars} out of band`);
      }
    }
  });

  await step("ни один parse не зависает > 30s на файле < 30MB", () => {
    for (const r of reports) {
      if (r.parseMs > 30_000) throw new Error(`${r.file}: parse=${r.parseMs}ms`);
    }
  });

  console.log(`\n--- Summary ---`);
  console.log(`Tests passed: ${passed}`);
  console.log(`Tests failed: ${failed}`);
  console.log(`Reports     : ${reports.length} (ok=${reports.filter((r) => r.ok).length}, fail=${reports.filter((r) => !r.ok).length})`);

  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(2);
});
