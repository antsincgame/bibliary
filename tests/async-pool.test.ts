/* runWithConcurrency contract: bounded inflight, no source ordering, robust to errors. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { runWithConcurrency } from "../electron/lib/library/async-pool.ts";

async function* range(n: number): AsyncGenerator<number> {
  for (let i = 0; i < n; i++) yield i;
}

test("runWithConcurrency: throws on invalid concurrency", async () => {
  await assert.rejects(async () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ of runWithConcurrency(range(0), 0, async () => 1)) {
      /* never */
    }
  });
});

test("runWithConcurrency: empty source yields nothing", async () => {
  const out: number[] = [];
  for await (const r of runWithConcurrency(range(0), 4, async (x) => x)) {
    out.push(r.input);
  }
  assert.deepEqual(out, []);
});

test("runWithConcurrency: concurrency=1 preserves source order", async () => {
  const out: number[] = [];
  for await (const r of runWithConcurrency(range(5), 1, async (x) => x * 10)) {
    assert.equal(r.ok, true);
    if (r.ok) out.push(r.value);
  }
  assert.deepEqual(out, [0, 10, 20, 30, 40]);
});

test("runWithConcurrency: concurrency=N never exceeds N inflight", async () => {
  const concurrency = 3;
  let active = 0;
  let peak = 0;
  const out: number[] = [];
  const worker = async (x: number): Promise<number> => {
    active++;
    if (active > peak) peak = active;
    await new Promise((r) => setTimeout(r, 5));
    active--;
    return x;
  };
  for await (const r of runWithConcurrency(range(20), concurrency, worker)) {
    if (r.ok) out.push(r.value);
  }
  assert.equal(out.length, 20);
  assert.ok(peak <= concurrency, `peak=${peak} must be <= ${concurrency}`);
  assert.ok(peak >= concurrency - 1, `peak=${peak} should approach concurrency=${concurrency}`);
});

test("runWithConcurrency: error in one worker does not stop the pool", async () => {
  const oks: number[] = [];
  const errs: number[] = [];
  for await (const r of runWithConcurrency(range(5), 2, async (x) => {
    if (x === 2) throw new Error(`boom-${x}`);
    return x;
  })) {
    if (r.ok) oks.push(r.value);
    else errs.push(r.input);
  }
  assert.deepEqual(oks.sort((a, b) => a - b), [0, 1, 3, 4]);
  assert.deepEqual(errs, [2]);
});

test("runWithConcurrency: items are completed (concurrency=4 yields all 10)", async () => {
  /* Делаем разные задержки, чтобы форсировать "не-source order" в какой-то форме.
     Не утверждаем строгий порядок — контракт не гарантирует. Просто убеждаемся,
     что все 10 элементов обработаны и счёт корректен. */
  const inputs: number[] = [];
  for await (const r of runWithConcurrency(range(10), 4, async (x) => {
    await new Promise((resolve) => setTimeout(resolve, (10 - x) * 2));
    return x;
  })) {
    inputs.push(r.input);
  }
  assert.equal(inputs.length, 10);
  assert.deepEqual(inputs.slice().sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
});
