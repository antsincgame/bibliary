/**
 * Integration test для Iter 7 — scheduler observability в evaluator-queue.
 * (illustration-worker удалён вместе с refactor 9 ролей → 3 задач 2026-05.)
 *
 * Проверяем что getSnapshot() корректно отражает состояние lanes — это то,
 * что pipeline-status-widget показывает в UI.
 */

import { describe, it, beforeEach } from "node:test";
import { expect } from "./helpers/expect-shim.ts";
import {
  ImportTaskScheduler,
  _resetImportSchedulerForTests,
  getImportScheduler,
} from "../electron/lib/library/import-task-scheduler.js";

beforeEach(() => {
  _resetImportSchedulerForTests();
});

/** Helper: создаёт promise который резолвится явно через возвращённую функцию. */
function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe("Iter 7: scheduler observability semantics", () => {
  it("getSnapshot отражает running counter во время выполнения", async () => {
    const scheduler = new ImportTaskScheduler();
    const d = deferred();
    let inFlight = false;

    const task = scheduler.enqueue("medium", async () => {
      inFlight = true;
      await d.promise;
    });

    await new Promise((r) => setImmediate(r));
    expect(inFlight).toBe(true);

    const snap = scheduler.getSnapshot();
    expect(snap.medium.running).toBe(1);
    expect(snap.medium.queued).toBe(0);

    d.resolve();
    await task;
    const snap2 = scheduler.getSnapshot();
    expect(snap2.medium.running).toBe(0);
  });

  it("medium lane параллелит до 3 задач, 4-я ждёт в queue", async () => {
    const scheduler = new ImportTaskScheduler({ mediumConcurrency: 3 });
    const deferreds = Array.from({ length: 4 }, () => deferred());
    const tasks = deferreds.map((d) => scheduler.enqueue("medium", () => d.promise));

    await new Promise((r) => setImmediate(r));
    const snap = scheduler.getSnapshot();
    expect(snap.medium.running).toBe(3);
    expect(snap.medium.queued).toBe(1);

    /* Завершить ВСЕ — ждать все tasks. */
    for (const d of deferreds) d.resolve();
    await Promise.all(tasks);

    const final = scheduler.getSnapshot();
    expect(final.medium.running).toBe(0);
    expect(final.medium.queued).toBe(0);
  });

  it("heavy lane строго сериализует (concurrency=1, 3 task в queue)", async () => {
    const scheduler = new ImportTaskScheduler();
    const deferreds = Array.from({ length: 3 }, () => deferred());
    const tasks = deferreds.map((d) => scheduler.enqueue("heavy", () => d.promise));

    await new Promise((r) => setImmediate(r));
    const snap = scheduler.getSnapshot();
    expect(snap.heavy.running).toBe(1);
    expect(snap.heavy.queued).toBe(2);

    /* Завершить ВСЕ. */
    for (const d of deferreds) d.resolve();
    await Promise.all(tasks);

    const final = scheduler.getSnapshot();
    expect(final.heavy.running).toBe(0);
  });

  it("singleton getImportScheduler возвращает один экземпляр", () => {
    const a = getImportScheduler();
    const b = getImportScheduler();
    expect(a).toBe(b);
  });

  it("snapshot после reset = пустой", () => {
    const scheduler = new ImportTaskScheduler();
    const snap = scheduler.getSnapshot();
    /* Иt 8В.MAIN.1.5: io lane удалена — проверяем только 3 lane'а. */
    expect(snap.light.running).toBe(0);
    expect(snap.medium.running).toBe(0);
    expect(snap.heavy.running).toBe(0);
  });
});

describe("Iter 7: error handling в scheduler — counter не leakит", () => {
  it("после rejected task counter возвращается в 0", async () => {
    const scheduler = new ImportTaskScheduler();
    const task = scheduler.enqueue("heavy", async () => {
      throw new Error("simulated failure");
    });

    await expect(task).rejects.toThrow(/simulated failure/);

    const snap = scheduler.getSnapshot();
    expect(snap.heavy.running).toBe(0);
    expect(snap.heavy.queued).toBe(0);
  });

  it("после throw в heavy lane следующая task стартует", async () => {
    const scheduler = new ImportTaskScheduler();
    const t1 = scheduler.enqueue("heavy", async () => {
      throw new Error("boom");
    });
    const t2 = scheduler.enqueue("heavy", async () => "ok");

    await expect(t1).rejects.toThrow();
    const result = await t2;
    expect(result).toBe("ok");

    const snap = scheduler.getSnapshot();
    expect(snap.heavy.running).toBe(0);
  });
});
