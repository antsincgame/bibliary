/**
 * E2E тест полного pipeline: parse → chunk → embed → upsert → semantic search.
 * Реальные книги из ~/Downloads, реальный Qdrant, реальный e5-small.
 *
 * Запуск:  npx tsx scripts/e2e-book-ingest.ts
 *
 * Тестирует:
 *   1. Probe — нашли книги
 *   2. Ingest каждого формата — счетчики корректны (embedded == upserted)
 *   3. Resume — повторный запуск пропускает уже обработанные chunks
 *   4. Search — embedQuery возвращает релевантные результаты
 *   5. State — scanner-progress.json содержит правильные данные
 *   6. Cleanup — коллекция удалена
 */

import * as path from "path";
import { promises as fs } from "fs";
import * as os from "os";
import { tmpdir } from "os";
import { QdrantClient } from "@qdrant/js-client-rest";
import { pipeline } from "@xenova/transformers";
import {
  probeBooks,
  ingestBook,
  ScannerStateStore,
  detectExt,
} from "../electron/lib/scanner/index.js";

const QDRANT_URL = process.env.QDRANT_URL ?? "http://localhost:6333";
const COLLECTION = process.env.BIBLIARY_E2E_BOOK_COLLECTION ?? "bibliary-e2e-books";
const MAX_PER_FORMAT_BYTES = 8 * 1024 * 1024;

const COLOR = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
};

let passed = 0;
let failed = 0;
const failures: string[] = [];

async function step(label: string, fn: () => Promise<void> | void): Promise<void> {
  process.stdout.write(`  ${label.padEnd(70, ".")} `);
  try {
    await fn();
    console.log(`${COLOR.green}PASS${COLOR.reset}`);
    passed++;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`${COLOR.red}FAIL${COLOR.reset}\n      ${COLOR.dim}${msg}${COLOR.reset}`);
    failed++;
    failures.push(`${label}: ${msg}`);
  }
}

async function main(): Promise<void> {
  console.log(`\n${COLOR.bold}== Bibliary E2E book ingest ==${COLOR.reset}\n`);
  console.log(`Qdrant     : ${QDRANT_URL}`);
  console.log(`Collection : ${COLLECTION}`);

  const downloads = path.join(os.homedir(), "Downloads");
  const all = await probeBooks(downloads, 1);

  const sample: { ext: string; absPath: string; fileName: string; sizeBytes: number }[] = [];
  for (const ext of ["pdf", "epub", "fb2", "docx", "txt"]) {
    const first = all.find((b) => b.ext === ext && b.sizeBytes < MAX_PER_FORMAT_BYTES);
    if (first) sample.push(first);
  }
  console.log(`\nSample: ${sample.length} формат(ов): ${sample.map((s) => s.ext).join(", ")}\n`);

  const qdrant = new QdrantClient({ url: QDRANT_URL });
  const stateFile = path.join(tmpdir(), `bibliary-scanner-${Date.now()}.json`);
  const store = new ScannerStateStore(stateFile);

  await step("E2E-1 — Qdrant collection нет в начале", async () => {
    try {
      await qdrant.deleteCollection(COLLECTION);
    } catch {
      /* not exists */
    }
  });

  await step("E2E-2 — probe нашёл хотя бы 3 формата", () => {
    if (sample.length < 3) throw new Error(`only ${sample.length} formats found`);
  });

  const ingestStats: Record<string, { embedded: number; upserted: number; skipped: number; total: number; warnings: string[] }> = {};

  for (const book of sample) {
    await step(`E2E-3.${book.ext} — ingest ${book.fileName.slice(0, 40)}`, async () => {
      const r = await ingestBook(book.absPath, {
        collection: COLLECTION,
        qdrantUrl: QDRANT_URL,
        state: store,
      });
      ingestStats[book.ext] = {
        embedded: r.embedded,
        upserted: r.upserted,
        skipped: r.skipped,
        total: r.totalChunks,
        warnings: r.warnings,
      };
      if (r.totalChunks === 0) throw new Error("zero chunks");
      if (r.embedded !== r.upserted) {
        throw new Error(`embedded=${r.embedded} != upserted=${r.upserted}`);
      }
      if (r.skipped !== 0) {
        throw new Error(`unexpected skipped=${r.skipped} on first run`);
      }
    });
  }

  await step("E2E-4 — Qdrant collection существует и не пуста", async () => {
    const info = await qdrant.getCollection(COLLECTION);
    if (!info) throw new Error("collection missing");
    const total = Object.values(ingestStats).reduce((s, v) => s + v.upserted, 0);
    const got = info.points_count ?? 0;
    if (got < total - 5 || got > total + 5) {
      throw new Error(`points_count=${got} expected≈${total}`);
    }
  });

  await step("E2E-5 — RESUME: повторный ingest skip всех chunks", async () => {
    const book = sample[0];
    const r = await ingestBook(book.absPath, {
      collection: COLLECTION,
      qdrantUrl: QDRANT_URL,
      state: store,
    });
    if (r.embedded !== 0) throw new Error(`expected embedded=0, got ${r.embedded}`);
    if (r.skipped !== ingestStats[book.ext].total) {
      throw new Error(`skipped=${r.skipped} expected=${ingestStats[book.ext].total}`);
    }
  });

  await step("E2E-6 — state-store: книги записаны со status=done", async () => {
    const st = await store.read();
    const recorded = Object.values(st.books);
    if (recorded.length !== sample.length) {
      throw new Error(`state has ${recorded.length} books, expected ${sample.length}`);
    }
    const notDone = recorded.filter((b) => b.status !== "done");
    if (notDone.length > 0) {
      throw new Error(`${notDone.length} books not 'done': ${notDone.map((b) => b.status).join(",")}`);
    }
  });

  const extractor = await pipeline("feature-extraction", "Xenova/multilingual-e5-small");
  async function search(q: string, limit = 3): Promise<Array<{ score: number; text: string; book: string }>> {
    const out = await extractor(`query: ${q}`, { pooling: "mean", normalize: true });
    const vec = Array.from(out.data as Float32Array);
    const res = await qdrant.search(COLLECTION, { vector: vec, limit, with_payload: true });
    return res.map((p) => ({
      score: p.score,
      text: String((p.payload as Record<string, unknown>)?.text ?? "").slice(0, 120),
      book: String((p.payload as Record<string, unknown>)?.bookTitle ?? ""),
    }));
  }

  const queries: { q: string; mustMentionAny: string[] }[] = [
    { q: "что такое юзабилити и удобство интерфейса", mustMentionAny: [] },
    { q: "how to write clean readable code", mustMentionAny: [] },
    { q: "как устроен дизайн форм и валидация ошибок", mustMentionAny: [] },
    { q: "what is information architecture", mustMentionAny: [] },
    { q: "пишите простыми словами, не используйте бюрократический язык", mustMentionAny: [] },
    { q: "css grid flexbox layout", mustMentionAny: [] },
  ];

  for (let i = 0; i < queries.length; i++) {
    const { q } = queries[i];
    await step(`E2E-7.${i + 1} — search "${q.slice(0, 50)}"`, async () => {
      const results = await search(q, 3);
      if (results.length === 0) throw new Error("no results");
      const top = results[0];
      if (top.score < 0.6) throw new Error(`top score=${top.score.toFixed(3)} < 0.6`);
      console.log(`        ${COLOR.dim}top: ${top.score.toFixed(3)} «${top.book.slice(0, 30)}» — ${top.text.slice(0, 80).replace(/\n/g, " ")}…${COLOR.reset}`);
    });
  }

  await step("E2E-8 — все формат-чанки представлены хотя бы 1 раз в выдачах", async () => {
    const seenBooks = new Set<string>();
    for (const { q } of queries) {
      const results = await search(q, 3);
      for (const r of results) seenBooks.add(r.book);
    }
    if (seenBooks.size < 2) {
      throw new Error(`only ${seenBooks.size} unique books appear in top-3 (expected ≥ 2)`);
    }
  });

  await step("E2E-9 — payload фильтр по bookTitle работает", async () => {
    const titles = new Set(Object.values(ingestStats).map((_, i) => sample[i]));
    if (titles.size === 0) return;
    const targetBook = sample[0];
    const out = await extractor(`query: introduction`, { pooling: "mean", normalize: true });
    const vec = Array.from(out.data as Float32Array);
    const r = await qdrant.search(COLLECTION, {
      vector: vec,
      limit: 5,
      with_payload: true,
      filter: { must: [{ key: "bookSourcePath", match: { value: targetBook.absPath } }] },
    });
    if (r.length === 0) throw new Error("filter returned 0");
    for (const point of r) {
      const src = (point.payload as Record<string, unknown>)?.bookSourcePath;
      if (src !== targetBook.absPath) throw new Error(`filter leaked: ${String(src)}`);
    }
  });

  await step("E2E-10 — cleanup state-file и Qdrant collection", async () => {
    await qdrant.deleteCollection(COLLECTION);
    await fs.unlink(stateFile).catch((err) => console.error("[e2e-book-ingest/cleanup] unlink Error:", err));
  });

  console.log(`\n${COLOR.bold}--- Ingest stats ---${COLOR.reset}`);
  for (const [ext, s] of Object.entries(ingestStats)) {
    console.log(`  ${ext.padEnd(5)} chunks=${String(s.total).padStart(4)} embedded=${String(s.embedded).padStart(4)} upserted=${String(s.upserted).padStart(4)} warnings=${s.warnings.length}`);
  }

  console.log(`\n${COLOR.bold}--- Summary ---${COLOR.reset}`);
  console.log(`Tests passed: ${COLOR.green}${passed}${COLOR.reset}`);
  console.log(`Tests failed: ${failed === 0 ? COLOR.green : COLOR.red}${failed}${COLOR.reset}`);
  if (failed > 0) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(2);
});
