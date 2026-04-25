/**
 * E2E для Phase 2.7 — Library UX.
 *
 * Тестируется в "headless" режиме: вызовы scanner-функций напрямую (минуя IPC),
 * чтобы не поднимать Electron BrowserWindow для unit-проверок.
 * IPC-обвязка в `electron/ipc/scanner.ipc.ts` тонкая и тестируется отдельно
 * через ручной smoke в полном Electron-режиме.
 *
 * Запуск:  npx tsx scripts/e2e-library-ux.ts
 */

import * as os from "os";
import * as path from "path";
import { promises as fs } from "fs";
import { tmpdir } from "os";
import { QdrantClient } from "@qdrant/js-client-rest";
import {
  probeBooks,
  parseBook,
  chunkBook,
  ingestBook,
  ScannerStateStore,
  detectExt,
  isSupportedBook,
} from "../electron/lib/scanner/index.js";

const QDRANT_URL = process.env.QDRANT_URL ?? "http://localhost:6333";
const COLLECTION = process.env.BIBLIARY_E2E_LIBUX_COLLECTION ?? "bibliary-e2e-libux";
const MAX_PER_FORMAT_BYTES = 5 * 1024 * 1024;

const COLOR = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  cyan: "\x1b[36m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
};

let passed = 0;
let failed = 0;
const failures: string[] = [];

async function step(label: string, fn: () => Promise<void> | void): Promise<void> {
  process.stdout.write(`  ${label.padEnd(72, ".")} `);
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
  console.log(`\n${COLOR.bold}== Bibliary E2E Library UX ==${COLOR.reset}\n`);
  console.log(`Qdrant     : ${QDRANT_URL}`);
  console.log(`Collection : ${COLLECTION}\n`);

  const downloads = path.join(os.homedir(), "Downloads");
  const all = await probeBooks(downloads, 1);
  const sample = all
    .filter((b) => isSupportedBook(b.absPath) && b.sizeBytes < MAX_PER_FORMAT_BYTES)
    .slice(0, 3);

  await step("E2E-1 — probeBooks нашёл хотя бы 2 книги для теста", () => {
    if (sample.length < 2) throw new Error(`only ${sample.length} books usable`);
  });

  const qdrant = new QdrantClient({ url: QDRANT_URL });
  await qdrant.deleteCollection(COLLECTION).catch((err) => console.error("[e2e-library-ux/setup] deleteCollection Error:", err));

  const stateFile = path.join(tmpdir(), `bibliary-libux-${Date.now()}.json`);
  const store = new ScannerStateStore(stateFile);

  /* === Preview (parsePreview эквивалент) === */
  await step("E2E-2 — parseBook + chunkBook не падает на образце для preview", async () => {
    const parsed = await parseBook(sample[0].absPath);
    const chunks = chunkBook(parsed, sample[0].absPath);
    if (parsed.sections.length === 0 && chunks.length === 0) throw new Error("empty parse");
  });

  /* === Ingest 2 книги последовательно через очередь (имитация QUEUE_PARALLELISM) === */
  for (const b of sample) {
    await step(`E2E-3.${detectExt(b.absPath)} — ingest «${b.fileName.slice(0, 30)}»`, async () => {
      const res = await ingestBook(b.absPath, {
        collection: COLLECTION,
        qdrantUrl: QDRANT_URL,
        state: store,
      });
      if (res.totalChunks === 0 && res.warnings.length === 0) throw new Error("zero chunks no warning");
    });
  }

  /* === History grouping (имитация scanner:list-history) === */
  await step("E2E-4 — state-store группирует по коллекции и содержит все книги", async () => {
    const state = await store.read();
    const recorded = Object.values(state.books);
    if (recorded.length !== sample.length) {
      throw new Error(`state has ${recorded.length} books, expected ${sample.length}`);
    }
    const collections = new Set(recorded.map((b) => b.collection));
    if (collections.size !== 1) throw new Error(`unexpected collections: ${[...collections].join(",")}`);
    if (![...collections][0] || ![...collections].includes(COLLECTION)) {
      throw new Error("collection mismatch");
    }
  });

  await step("E2E-5 — каждая книга в истории имеет status=done", async () => {
    const state = await store.read();
    const not = Object.values(state.books).filter((b) => b.status !== "done");
    if (not.length > 0) throw new Error(`${not.length} books not done`);
  });

  /* === Smart resume detection (knownPaths Set в UI) === */
  await step("E2E-6 — knownPaths поведение: повторный probe возвращает уже-известные пути", async () => {
    const state = await store.read();
    const known = new Set(Object.keys(state.books));
    const probed = await probeBooks(downloads, 1);
    const overlap = probed.filter((p) => known.has(p.absPath));
    if (overlap.length === 0) throw new Error("no overlap, smart resume не покажет 'already in Qdrant'");
  });

  /* === Delete from collection (имитация scanner:delete-from-collection) === */
  await step("E2E-7 — удаление точек книги по filter bookSourcePath", async () => {
    const target = sample[0].absPath;
    const before = await qdrant.scroll(COLLECTION, {
      limit: 100,
      filter: { must: [{ key: "bookSourcePath", match: { value: target } }] },
      with_payload: false,
    });
    if (before.points.length === 0) throw new Error("no points before delete");
    await qdrant.delete(COLLECTION, {
      wait: true,
      filter: { must: [{ key: "bookSourcePath", match: { value: target } }] },
    });
    const after = await qdrant.scroll(COLLECTION, {
      limit: 100,
      filter: { must: [{ key: "bookSourcePath", match: { value: target } }] },
      with_payload: false,
    });
    if (after.points.length !== 0) throw new Error(`points remaining=${after.points.length}`);

    const cur = await store.read();
    delete cur.books[target];
    await store.write(cur);
    const reread = await store.read();
    if (reread.books[target]) throw new Error("state still has the book after delete");
  });

  /* === Cancel сценарий проверяется через ingestBook signal aborted ===
   * Полный test для cancel в середине дорогой (нужен живой LLM).
   * Здесь проверяем, что AbortController попадает в signal flow. */
  await step("E2E-8 — pre-aborted signal обрывает ingest без upsert в Qdrant", async () => {
    const ctrl = new AbortController();
    ctrl.abort(new DOMException("test", "AbortError"));
    const abortedCol = COLLECTION + "-aborted";
    await qdrant.deleteCollection(abortedCol).catch((err) => console.error("[e2e-library-ux/E2E-8] deleteCollection Error:", err));
    let didThrow = false;
    try {
      await ingestBook(sample[1].absPath, {
        collection: abortedCol,
        qdrantUrl: QDRANT_URL,
        state: new ScannerStateStore(path.join(tmpdir(), `bibliary-aborted-${Date.now()}.json`)),
        signal: ctrl.signal,
      });
    } catch {
      didThrow = true;
    }
    if (!didThrow) throw new Error("ingest with pre-aborted signal must throw");
    /* После abort коллекция либо не создана, либо пустая. Оба варианта корректны. */
    let pointsCount = 0;
    try {
      const info = await qdrant.getCollection(abortedCol);
      pointsCount = info.points_count ?? 0;
    } catch {
      pointsCount = 0;
    }
    if (pointsCount > 0) throw new Error(`expected 0 points after abort, got ${pointsCount}`);
    await qdrant.deleteCollection(abortedCol).catch((err) => console.error("[e2e-library-ux/E2E-8] deleteCollection cleanup Error:", err));
  });

  /* === Cleanup === */
  await step("E2E-9 — cleanup: удалить тестовую коллекцию + state file", async () => {
    await qdrant.deleteCollection(COLLECTION);
    await fs.unlink(stateFile).catch((err) => console.error("[e2e-library-ux/cleanup] unlink Error:", err));
  });

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
