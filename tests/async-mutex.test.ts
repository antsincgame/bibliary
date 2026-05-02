import test from "node:test";
import assert from "node:assert/strict";
import { AsyncMutex, KeyedAsyncMutex } from "../electron/lib/llm/async-mutex.js";

test("AsyncMutex: serializes concurrent calls in FIFO order", async () => {
  const m = new AsyncMutex();
  const order: number[] = [];
  const slow = (i: number, ms: number): Promise<void> =>
    m.runExclusive(async () => {
      await new Promise((r) => setTimeout(r, ms));
      order.push(i);
    });

  await Promise.all([slow(1, 30), slow(2, 5), slow(3, 1)]);
  assert.deepEqual(order, [1, 2, 3]);
});

test("AsyncMutex: error in fn does not poison the chain", async () => {
  const m = new AsyncMutex();
  await assert.rejects(
    m.runExclusive(async () => {
      throw new Error("boom");
    }),
    /boom/,
  );
  const result = await m.runExclusive(async () => 42);
  assert.equal(result, 42);
});

test("AsyncMutex: nested call enters only after outer releases (no re-entrancy)", async () => {
  const m = new AsyncMutex();
  const events: string[] = [];
  await m.runExclusive(async () => {
    events.push("outer-enter");
    void m.runExclusive(async () => {
      events.push("inner-enter");
    });
    await new Promise((r) => setTimeout(r, 10));
    events.push("outer-still-holding");
  });
  await new Promise((r) => setTimeout(r, 10));
  events.push("after-outer");
  assert.deepEqual(events, [
    "outer-enter",
    "outer-still-holding",
    "inner-enter",
    "after-outer",
  ]);
});

test("KeyedAsyncMutex: different keys run in parallel, same key serializes", async () => {
  const km = new KeyedAsyncMutex(16);
  const log: string[] = [];
  const slow = (key: string, label: string, ms: number): Promise<void> =>
    km.runExclusive(key, async () => {
      log.push(`${label}-start`);
      await new Promise((r) => setTimeout(r, ms));
      log.push(`${label}-end`);
    });

  await Promise.all([
    slow("A", "a1", 20),
    slow("A", "a2", 5),
    slow("B", "b1", 10),
  ]);

  /* Same key (A) serializes: a1 fully completes before a2 starts. */
  const a1End = log.indexOf("a1-end");
  const a2Start = log.indexOf("a2-start");
  assert.ok(a1End >= 0 && a2Start > a1End, "a2 must start after a1 ends");

  /* Different keys (A vs B) run in parallel: b1 starts before a1 ends. */
  const a1Start = log.indexOf("a1-start");
  const b1Start = log.indexOf("b1-start");
  assert.ok(b1Start <= a1End, "b1 must start before or right after a1 starts (parallel keys)");
  assert.ok(a1Start <= b1Start || a1Start <= b1Start + 1);
});

test("KeyedAsyncMutex: size grows then compacts past maxKeys", async () => {
  const km = new KeyedAsyncMutex(8);
  for (let i = 0; i < 10; i++) {
    await km.runExclusive(`k${i}`, async () => undefined);
  }
  assert.ok(km.size() <= 8, `expected size ≤ 8 after compaction, got ${km.size()}`);
});
