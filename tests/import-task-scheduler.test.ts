/**
 * Import Task Scheduler — light/medium/heavy lanes с лимитами concurrency.
 */

import { describe, it } from "node:test";
import { expect } from "./helpers/expect-shim.ts";
import { ImportTaskScheduler } from "../server/lib/scanner/_vendor/library/import-task-scheduler.js";

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("ImportTaskScheduler — basic enqueue", () => {
  it("задача стартует немедленно если есть свободный слот", async () => {
    const sched = new ImportTaskScheduler();
    const result = await sched.enqueue("light", async () => 42);
    expect(result).toBe(42);
  });

  it("результат promise соответствует возврату fn", async () => {
    const sched = new ImportTaskScheduler();
    const r = await sched.enqueue("medium", async () => ({ ok: true, value: "test" }));
    expect(r).toEqual({ ok: true, value: "test" });
  });

  it("ошибка fn пробрасывается через reject", async () => {
    const sched = new ImportTaskScheduler();
    await expect(sched.enqueue("light", async () => {
      throw new Error("boom");
    })).rejects.toThrow(/boom/);
  });
});

describe("ImportTaskScheduler — concurrency limits", () => {
  it("heavy lane строго 1 одновременно", async () => {
    const sched = new ImportTaskScheduler({ heavyConcurrency: 1 });
    const d1 = deferred<void>();
    const d2 = deferred<void>();
    let started = 0;

    const p1 = sched.enqueue("heavy", async () => {
      started += 1;
      await d1.promise;
    });
    const p2 = sched.enqueue("heavy", async () => {
      started += 1;
      await d2.promise;
    });

    /* Yield чтобы scheduler попытался стартовать. */
    await new Promise((r) => setTimeout(r, 10));
    expect(started).toBe(1); /* строго одна стартовала */

    d1.resolve();
    await p1;
    /* Теперь вторая стартовала. */
    await new Promise((r) => setTimeout(r, 10));
    expect(started).toBe(2);

    d2.resolve();
    await p2;
  });

  it("medium lane: 3 одновременно (default)", async () => {
    const sched = new ImportTaskScheduler();
    const deferreds = Array.from({ length: 5 }, () => deferred<void>());
    let started = 0;

    const promises = deferreds.map((d) =>
      sched.enqueue("medium", async () => {
        started += 1;
        await d.promise;
      }),
    );

    await new Promise((r) => setTimeout(r, 10));
    expect(started).toBe(3); /* 3 одновременно по дефолту */

    deferreds[0]!.resolve();
    await promises[0];
    await new Promise((r) => setTimeout(r, 10));
    expect(started).toBe(4); /* четвёртая стартовала после освобождения */

    /* Очистим хвост */
    deferreds.slice(1).forEach((d) => d.resolve());
    await Promise.all(promises);
  });

  it("light lane: 8 одновременно (default)", async () => {
    const sched = new ImportTaskScheduler();
    const deferreds = Array.from({ length: 12 }, () => deferred<void>());
    let started = 0;

    const promises = deferreds.map((d) =>
      sched.enqueue("light", async () => {
        started += 1;
        await d.promise;
      }),
    );

    await new Promise((r) => setTimeout(r, 10));
    expect(started).toBe(8);

    deferreds.forEach((d) => d.resolve());
    await Promise.all(promises);
  });

  it("разные lanes независимы: heavy=1 не блокирует light", async () => {
    const sched = new ImportTaskScheduler();
    const dHeavy = deferred<void>();
    let lightDone = false;

    const heavyP = sched.enqueue("heavy", async () => { await dHeavy.promise; });
    const lightP = sched.enqueue("light", async () => { lightDone = true; });

    await lightP;
    expect(lightDone).toBe(true);
    /* Heavy всё ещё висит — это нормально. */
    dHeavy.resolve();
    await heavyP;
  });
});

describe("ImportTaskScheduler — telemetry / control", () => {
  it("getSnapshot отражает текущее состояние lanes", async () => {
    const sched = new ImportTaskScheduler({ heavyConcurrency: 1 });
    const d = deferred<void>();
    const p = sched.enqueue("heavy", async () => { await d.promise; });
    sched.enqueue("heavy", async () => 1).catch(() => undefined);
    sched.enqueue("heavy", async () => 2).catch(() => undefined);

    await new Promise((r) => setTimeout(r, 10));
    const snap = sched.getSnapshot();
    expect(snap.heavy.running).toBe(1);
    expect(snap.heavy.queued).toBe(2);
    expect(snap.light.running).toBe(0);
    expect(snap.medium.running).toBe(0);

    d.resolve();
    await p;
  });

  it("setLimit изменяет лимит на лету; повышение запускает ожидающие задачи", async () => {
    const sched = new ImportTaskScheduler({ heavyConcurrency: 1 });
    const d1 = deferred<void>();
    const d2 = deferred<void>();
    let started = 0;

    const p1 = sched.enqueue("heavy", async () => { started += 1; await d1.promise; });
    const p2 = sched.enqueue("heavy", async () => { started += 1; await d2.promise; });

    await new Promise((r) => setTimeout(r, 10));
    expect(started).toBe(1);

    sched.setLimit("heavy", 2); /* теперь может крутить 2 параллельно */
    await new Promise((r) => setTimeout(r, 10));
    expect(started).toBe(2);

    d1.resolve();
    d2.resolve();
    await Promise.all([p1, p2]);
  });

  it("drainAndCancelPending отклоняет ожидающие, не трогает бегущие", async () => {
    const sched = new ImportTaskScheduler({ heavyConcurrency: 1 });
    const dRunning = deferred<void>();
    let runningResolved = false;

    const running = sched.enqueue("heavy", async () => {
      await dRunning.promise;
      runningResolved = true;
    });
    const pending1 = sched.enqueue("heavy", async () => 1);
    const pending2 = sched.enqueue("heavy", async () => 2);

    await new Promise((r) => setTimeout(r, 10));
    const cancelled = sched.drainAndCancelPending("test cancel");
    expect(cancelled).toBe(2);

    await expect(pending1).rejects.toThrow(/test cancel/);
    await expect(pending2).rejects.toThrow(/test cancel/);

    /* Бегущая всё ещё активна. */
    dRunning.resolve();
    await running;
    expect(runningResolved).toBe(true);
  });
});
