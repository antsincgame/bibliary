/**
 * Phase 2.5R.6 — Platform unit tests.
 * Run: `npx tsx scripts/test-platform.ts`
 * Exit code 0 on success, 1 on any failure.
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { z } from "zod";
import {
  writeJsonAtomic,
  withFileLock,
  createCheckpointStore,
  telemetry,
} from "../electron/lib/resilience/index.js";
import { configureTelemetry } from "../electron/lib/resilience/telemetry.js";

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

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "bibliary-platform-"));
}

async function testAtomicWrite(): Promise<void> {
  console.log("\n[atomic-write]");
  const dir = await makeTempDir();
  const file = path.join(dir, "data.json");

  await step("write + read roundtrip", async () => {
    await writeJsonAtomic(file, { ok: true, n: 42 });
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw);
    assert(parsed.ok === true && parsed.n === 42, "roundtrip mismatch");
  });

  await step("no leftover .tmp on success", async () => {
    const entries = await fs.readdir(dir);
    const tmps = entries.filter((e) => e.endsWith(".tmp"));
    assert(tmps.length === 0, `leftover tmp files: ${tmps.join(",")}`);
  });

  await step("creates parent directories", async () => {
    const nested = path.join(dir, "a", "b", "c", "deep.json");
    await writeJsonAtomic(nested, { deep: true });
    const raw = await fs.readFile(nested, "utf8");
    assert(JSON.parse(raw).deep === true, "deep file unreadable");
  });

  await fs.rm(dir, { recursive: true, force: true });
}

async function testFileLock(): Promise<void> {
  console.log("\n[file-lock]");
  const dir = await makeTempDir();
  const file = path.join(dir, "locked.json");
  await fs.writeFile(file, "{}", "utf8");

  await step("sequential locks succeed", async () => {
    const order: string[] = [];
    await withFileLock(file, async () => {
      order.push("first");
    });
    await withFileLock(file, async () => {
      order.push("second");
    });
    assert(order.join(",") === "first,second", "order mismatch");
  });

  await step("concurrent locks serialize", async () => {
    const order: string[] = [];
    const a = withFileLock(file, async () => {
      order.push("A-start");
      await new Promise((r) => setTimeout(r, 80));
      order.push("A-end");
    });
    // small delay to ensure A acquires first
    await new Promise((r) => setTimeout(r, 10));
    const b = withFileLock(file, async () => {
      order.push("B-start");
      await new Promise((r) => setTimeout(r, 20));
      order.push("B-end");
    });
    await Promise.all([a, b]);
    assert(
      order.join(",") === "A-start,A-end,B-start,B-end",
      `unexpected order: ${order.join(",")}`
    );
  });

  await fs.rm(dir, { recursive: true, force: true });
}

async function testCheckpointStore(): Promise<void> {
  console.log("\n[checkpoint-store]");
  const dir = await makeTempDir();
  const checkpointsDir = path.join(dir, "ck");

  const Schema = z.object({ id: z.string(), value: z.number(), savedAt: z.string() });
  const store = createCheckpointStore<{ id: string; value: number; savedAt: string }>({
    dir: checkpointsDir,
    schema: Schema,
  });

  await step("save + load equality", async () => {
    const snap = { id: "alpha", value: 7, savedAt: new Date().toISOString() };
    await store.save("alpha", snap);
    const loaded = await store.load("alpha");
    assert(loaded !== null, "load returned null");
    assert(loaded!.value === 7, "value mismatch");
  });

  await step("scan returns saved items", async () => {
    await store.save("beta", { id: "beta", value: 11, savedAt: new Date().toISOString() });
    const items = await store.scan();
    const ids = items.map((i) => i.id).sort();
    assert(ids.includes("alpha") && ids.includes("beta"), `scan missing: ${ids.join(",")}`);
  });

  await step("remove drops from list", async () => {
    await store.remove("alpha");
    const items = await store.list();
    assert(!items.find((i) => i.id === "alpha"), "alpha still present");
  });

  await step("invalid JSON rejected", async () => {
    const file = store.getPath("corrupt");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "not-json{", "utf8");
    let threw = false;
    try {
      await store.load("corrupt");
    } catch {
      threw = true;
    }
    assert(threw, "invalid JSON did not throw");
  });

  await step("schema mismatch rejected", async () => {
    const file = store.getPath("badshape");
    await fs.writeFile(file, JSON.stringify({ id: "x", value: "not-a-number", savedAt: "ok" }), "utf8");
    let threw = false;
    try {
      await store.load("badshape");
    } catch {
      threw = true;
    }
    assert(threw, "schema mismatch did not throw");
  });

  await fs.rm(dir, { recursive: true, force: true });
}

async function testTelemetry(): Promise<void> {
  console.log("\n[telemetry]");
  const dir = await makeTempDir();
  const file = path.join(dir, "telemetry.jsonl");
  configureTelemetry({ filePath: file, maxBytes: 1024 });

  await step("append + tail roundtrip", async () => {
    telemetry.logEvent({ type: "batch.start", batchId: "t1", pipeline: "dataset", config: {} });
    telemetry.logEvent({
      type: "batch.chunk.ok",
      batchId: "t1",
      chunkId: "c1",
      latencyMs: 100,
    });
    telemetry.logEvent({ type: "batch.end", batchId: "t1", ok: 1, failed: 0, durationMs: 200 });
    await telemetry.flush();
    const events = await telemetry.tail(10);
    assert(events.length >= 3, `expected ≥3 events, got ${events.length}`);
    assert(events.every((e) => typeof e.ts === "string"), "ts missing on some event");
  });

  await step("rotation on size threshold", async () => {
    const big = "x".repeat(200);
    for (let i = 0; i < 20; i++) {
      telemetry.logEvent({ type: "batch.chunk.ok", batchId: "huge", chunkId: `c${i}-${big}`, latencyMs: i });
    }
    await telemetry.flush();
    const entries = await fs.readdir(dir);
    const rotated = entries.filter((e) => /^telemetry-.*\.jsonl$/.test(e));
    assert(rotated.length >= 1, `expected at least 1 rotated file, got: ${entries.join(",")}`);
  });

  await fs.rm(dir, { recursive: true, force: true });
}

async function main(): Promise<void> {
  console.log("Phase 2.5R.6 — Platform tests");
  await testAtomicWrite();
  await testFileLock();
  await testCheckpointStore();
  await testTelemetry();

  console.log(`\n--- Summary ---\nPassed: ${passed}\nFailed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
