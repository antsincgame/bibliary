/**
 * Phase 2.5R.6 — Graceful shutdown / flushAll test.
 * Run: `npx tsx scripts/test-graceful-shutdown.ts`
 *
 * Тестирует:
 *  - flushAll возвращает { ok: true } если pipeline закончил вовремя
 *  - flushAll возвращает { ok: false, pending } при истечении timeout
 *  - flushAll === { ok: true, pending: [] } если active = 0
 *  - shutdown.flush.start/ok/timeout события записываются в telemetry
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import {
  initResilienceLayer,
  coordinator,
  telemetry,
  type PipelineHandle,
} from "../electron/lib/resilience/index.js";

let passed = 0;
let failed = 0;

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
  console.log("Phase 2.5R.6 — Graceful shutdown tests");

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "bibliary-shutdown-"));
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  await initResilienceLayer({
    dataDir: path.join(tmp, "data"),
    defaultsDir: path.join(projectRoot, "electron", "defaults"),
  });

  const dummyStore = {
    save: async () => undefined,
    load: async () => null,
    list: async () => [],
    remove: async () => undefined,
    scan: async () => [],
    getPath: () => "",
  };

  let flushDelayMs = 100;
  const handle: PipelineHandle = {
    name: "dataset",
    store: dummyStore,
    pause: async () => undefined,
    resume: async () => undefined,
    cancel: async () => undefined,
    discard: async () => undefined,
    flushPending: async () => {
      await new Promise((r) => setTimeout(r, flushDelayMs));
    },
  };
  coordinator.registerPipeline(handle);

  await step("flushAll fast: ok=true with no pending", async () => {
    coordinator.reportBatchStart({
      batchId: "fast-batch",
      pipeline: "dataset",
      startedAt: new Date().toISOString(),
      config: {},
    });
    flushDelayMs = 50;
    const result = await coordinator.flushAll(2000);
    coordinator.reportBatchEnd("fast-batch");
    assert(result.ok === true, "should be ok");
  });

  await step("flushAll timeout: ok=false with pending", async () => {
    coordinator.reportBatchStart({
      batchId: "slow-batch",
      pipeline: "dataset",
      startedAt: new Date().toISOString(),
      config: {},
    });
    flushDelayMs = 5000;
    const result = await coordinator.flushAll(500);
    assert(result.ok === false, "should not be ok");
    assert(result.pending.includes("slow-batch"), `pending missing slow-batch: ${result.pending.join(",")}`);
    coordinator.reportBatchEnd("slow-batch");
  });

  await step("flushAll empty: ok=true pending=[]", async () => {
    const result = await coordinator.flushAll(1000);
    assert(result.ok === true, "ok");
    assert(result.pending.length === 0, "no pending");
  });

  await step("telemetry shutdown events recorded", async () => {
    telemetry.logEvent({ type: "shutdown.flush.start", pendingBatches: ["x"] });
    telemetry.logEvent({ type: "shutdown.flush.ok", durationMs: 123 });
    telemetry.logEvent({ type: "shutdown.flush.timeout", pendingBatches: ["y"] });
    await telemetry.flush();
    const events = await telemetry.tail(10);
    const types = events.map((e) => e.type);
    assert(types.includes("shutdown.flush.start"), "missing start");
    assert(types.includes("shutdown.flush.ok"), "missing ok");
    assert(types.includes("shutdown.flush.timeout"), "missing timeout");
  });

  await new Promise((r) => setTimeout(r, 200));
  try {
    await fs.rm(tmp, { recursive: true, force: true });
  } catch (err) {
    console.warn(`cleanup failed (non-fatal): ${err instanceof Error ? err.message : err}`);
  }

  console.log(`\n--- Summary ---\nPassed: ${passed}\nFailed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
