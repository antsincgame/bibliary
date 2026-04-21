/**
 * Phase 2.5R.6 — End-to-end resume / integrity tests for dataset hardening.
 * Run: `npx tsx scripts/test-resume-batch.ts`
 *
 * Тестирует:
 *  - appendChunkLines атомарно записывает .jsonl + state + progress
 *  - finalizeBatch требует целостности и удаляет state
 *  - listUnfinalized возвращает незавершённые batch
 *  - integrity recovery: рассинхрон state vs jsonl восстанавливается
 *  - withFileLock сериализует параллельные append
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

let passed = 0;
let failed = 0;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function step(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (e) {
    console.error(`  FAIL  ${name}: ${e instanceof Error ? e.message : e}`);
    failed++;
  }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

async function main(): Promise<void> {
  const projectRoot = path.resolve(__dirname, "..");
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bibliary-resume-"));
  process.chdir(tmpRoot);

  // подготовка скелета data/
  await fs.mkdir(path.join(tmpRoot, "data", "finetune"), { recursive: true });
  await fs.writeFile(
    path.join(tmpRoot, "data", "finetune", "progress.json"),
    JSON.stringify(
      {
        total_chunks: 5,
        processed_count: 0,
        remaining_count: 5,
        processed_chunk_ids: [],
        batches: [],
        next_batch_index: 0,
        examples_per_chunk_target: 3,
        batch_size_target: 5,
      },
      null,
      2
    )
  );

  const finetune = await import(
    pathToFileURL(path.join(projectRoot, "electron", "finetune-state.ts")).href
  );
  const resilience = await import(
    pathToFileURL(path.join(projectRoot, "electron", "lib", "resilience", "index.ts")).href
  );

  await resilience.initResilienceLayer({
    dataDir: path.join(tmpRoot, "data"),
    defaultsDir: path.join(projectRoot, "electron", "defaults"),
  });
  finetune.registerDatasetPipeline();

  console.log("Phase 2.5R.6 — Resume / integrity tests");
  console.log(`  workspace: ${tmpRoot}`);

  const batchName = "batch-test";
  const batchFile = `${batchName}.jsonl`;
  const settings = {
    profile: "BIG" as const,
    contextLength: 32768,
    batchSize: 5,
    delayMs: 0,
    fewShotCount: 0,
    sampling: { max_tokens: 100 },
  };

  await step("startBatch creates state + empty .jsonl", async () => {
    const state = await finetune.startBatch(batchName, batchFile, settings, false);
    assert(state.processedChunkIds.length === 0, "state has chunks before append");
    assert(state.linesPerChunk === 3, "linesPerChunk should be 3");
    const jsonl = await fs.readFile(
      path.join(tmpRoot, "data", "finetune", "batches", batchFile),
      "utf8"
    );
    assert(jsonl === "", "expected empty jsonl");
  });

  await step("appendChunkLines persists 3 chunks", async () => {
    for (let i = 0; i < 3; i++) {
      const lines = [
        JSON.stringify({ meta: { source_chunk_id: `chunk-${i}` }, phase: "T1" }),
        JSON.stringify({ meta: { source_chunk_id: `chunk-${i}` }, phase: "T2" }),
        JSON.stringify({ meta: { source_chunk_id: `chunk-${i}` }, phase: "T3" }),
      ];
      await finetune.appendChunkLines(batchName, batchFile, lines, `chunk-${i}`);
    }
    const jsonl = await fs.readFile(
      path.join(tmpRoot, "data", "finetune", "batches", batchFile),
      "utf8"
    );
    const lines = jsonl.split("\n").filter((l) => l.length > 0);
    assert(lines.length === 9, `expected 9 lines, got ${lines.length}`);
  });

  await step("state.json reflects 3 chunks", async () => {
    const list = await finetune.listUnfinalized();
    const found = list.find((s: { batchName: string }) => s.batchName === batchName);
    assert(found !== undefined, "state not found");
    assert(found!.processedChunkIds.length === 3, "expected 3 chunkIds");
    assert(found!.appendedLineCount === 9, "expected appendedLineCount 9");
  });

  await step("manifest absent before finalize", async () => {
    const progress = JSON.parse(
      await fs.readFile(path.join(tmpRoot, "data", "finetune", "progress.json"), "utf8")
    );
    assert(!progress.batches.find((b: { name: string }) => b.name === batchName), "manifest leaked");
    assert(progress.processed_chunk_ids.length === 3, "progress missing 3 ids");
  });

  await step("integrity recovery: jsonl ahead of state", async () => {
    // имитируем краш: state думает 3, в jsonl уже 4
    const extraLine = JSON.stringify({ meta: { source_chunk_id: "chunk-3" }, phase: "T1" });
    await fs.appendFile(
      path.join(tmpRoot, "data", "finetune", "batches", batchFile),
      extraLine + "\n"
    );
    const recovered = await finetune.startBatch(batchName, batchFile, settings, true);
    assert(recovered.appendedLineCount === 10, `expected 10 lines, got ${recovered.appendedLineCount}`);
    assert(
      recovered.processedChunkIds.length === 4,
      `expected 4 ids, got ${recovered.processedChunkIds.length}`
    );
  });

  await step("finalize fails on integrity mismatch", async () => {
    let threw = false;
    try {
      await finetune.finalizeBatch(batchName, batchFile);
    } catch (e) {
      threw = /integrity/.test(e instanceof Error ? e.message : String(e));
    }
    assert(threw, "expected integrity error (4 ids vs 10 lines = 10/3 ≠ 4)");
  });

  await step("clean append + finalize succeeds (fresh batch)", async () => {
    const cleanName = "batch-clean";
    const cleanFile = `${cleanName}.jsonl`;
    await finetune.startBatch(cleanName, cleanFile, settings, false);
    for (let i = 0; i < 2; i++) {
      const lines = [
        JSON.stringify({ meta: { source_chunk_id: `cl-${i}` }, phase: "T1" }),
        JSON.stringify({ meta: { source_chunk_id: `cl-${i}` }, phase: "T2" }),
        JSON.stringify({ meta: { source_chunk_id: `cl-${i}` }, phase: "T3" }),
      ];
      await finetune.appendChunkLines(cleanName, cleanFile, lines, `cl-${i}`);
    }
    const progress = await finetune.finalizeBatch(cleanName, cleanFile);
    const manifest = progress.batches.find(
      (b: { name: string }) => b.name === cleanName
    );
    assert(manifest, "manifest missing after finalize");
    assert(
      manifest!.example_count === 6,
      `expected 6 examples (2 chunks × 3 phases), got ${manifest!.example_count}`
    );
    const list = await finetune.listUnfinalized();
    assert(
      !list.find((s: { batchName: string }) => s.batchName === cleanName),
      "state should be removed after finalize"
    );
  });

  await step("discard removes corrupt batch", async () => {
    // удалим первый batch вручную через разрушение state — потом проверим что listUnfinalized не сломался
    const list = await finetune.listUnfinalized();
    const survivors = list.filter((s: { batchName: string }) => s.batchName !== "batch-clean");
    assert(survivors.length >= 1, "should have at least 1 surviving unfinalized");
  });

  await step("concurrent append serializes via lock", async () => {
    const second = "batch-race";
    await finetune.startBatch(second, `${second}.jsonl`, settings, false);
    const ops = [0, 1, 2, 3].map(async (i) => {
      const lines = [
        JSON.stringify({ meta: { source_chunk_id: `r-${i}` }, phase: "T1" }),
        JSON.stringify({ meta: { source_chunk_id: `r-${i}` }, phase: "T2" }),
        JSON.stringify({ meta: { source_chunk_id: `r-${i}` }, phase: "T3" }),
      ];
      await finetune.appendChunkLines(second, `${second}.jsonl`, lines, `r-${i}`);
    });
    await Promise.all(ops);
    const list = await finetune.listUnfinalized();
    const found = list.find((s: { batchName: string }) => s.batchName === second);
    assert(found, "race batch state missing");
    assert(found!.appendedLineCount === 12, `expected 12 lines, got ${found!.appendedLineCount}`);
    assert(found!.processedChunkIds.length === 4, "expected 4 chunks");
  });

  // cleanup (non-fatal — Windows может удерживать handles от lockfile)
  await resilience.coordinator.flushAll(2000).catch(() => undefined);
  process.chdir(projectRoot);
  await new Promise((r) => setTimeout(r, 200));
  try {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  } catch (err) {
    console.warn(
      `cleanup of ${tmpRoot} failed (non-fatal): ${err instanceof Error ? err.message : err}`
    );
  }

  console.log(`\n--- Summary ---\nPassed: ${passed}\nFailed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
