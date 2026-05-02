/**
 * Bulkhead — unit tests.
 *
 * Покрытие:
 *   1. maxConcurrent=1: вторая задача ждёт первую (FIFO).
 *   2. Параллельные слоты: maxConcurrent=N запускают N параллельно.
 *   3. Queue full → BulkheadFullError (синхронно/немедленно).
 *   4. acquireTimeout: задача в очереди отваливается через таймаут.
 *   5. drain() отменяет всех в очереди.
 *   6. Ошибка в fn освобождает слот.
 *   7. release() пускает следующую задачу из очереди.
 */

import { describe, it } from "node:test";
import { expect } from "./helpers/expect-shim.ts";
import { Bulkhead, BulkheadFullError } from "../electron/lib/resilience/bulkhead.js";

describe("Bulkhead — basic concurrency", () => {
  it("maxConcurrent=1 сериализует задачи в FIFO", async () => {
    const bh = new Bulkhead({ name: "test", maxConcurrent: 1, maxQueue: 5 });
    const events: string[] = [];
    const tasks: Array<Promise<void>> = [];
    for (let i = 0; i < 3; i += 1) {
      tasks.push(
        bh.run(async () => {
          events.push(`enter-${i}`);
          await new Promise((r) => setTimeout(r, 10));
          events.push(`exit-${i}`);
        }),
      );
    }
    await Promise.all(tasks);
    expect(events).toEqual([
      "enter-0", "exit-0",
      "enter-1", "exit-1",
      "enter-2", "exit-2",
    ]);
  });

  it("maxConcurrent=3: три задачи запускаются параллельно", async () => {
    const bh = new Bulkhead({ name: "test", maxConcurrent: 3, maxQueue: 5 });
    let active = 0;
    let peak = 0;
    const tasks: Array<Promise<void>> = [];
    for (let i = 0; i < 3; i += 1) {
      tasks.push(
        bh.run(async () => {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 20));
          active -= 1;
        }),
      );
    }
    await Promise.all(tasks);
    expect(peak).toBe(3);
  });
});

describe("Bulkhead — queue overflow", () => {
  it("Queue full → BulkheadFullError", async () => {
    const bh = new Bulkhead({ name: "test", maxConcurrent: 1, maxQueue: 1 });

    /* Слот занят. */
    let resolveFirst!: () => void;
    const first = bh.run(async () => {
      await new Promise<void>((r) => {
        resolveFirst = r;
      });
    });

    /* Очередь = 1, занята. */
    const second = bh.run(async () => "second");

    /* Третья — overflow. */
    await expect(bh.run(async () => "third")).rejects.toThrow(BulkheadFullError);

    resolveFirst();
    await first;
    expect(await second).toBe("second");
  });

  it("BulkheadFullError содержит детали состояния", async () => {
    const bh = new Bulkhead({ name: "extraction", maxConcurrent: 1, maxQueue: 0 });
    let resolveFirst!: () => void;
    const first = bh.run(async () => {
      await new Promise<void>((r) => { resolveFirst = r; });
    });

    try {
      await bh.run(async () => "x");
      throw new Error("should not reach");
    } catch (e) {
      expect(e instanceof BulkheadFullError).toBe(true);
      const err = e as BulkheadFullError;
      expect(err.bulkheadName).toBe("extraction");
      expect(err.maxConcurrent).toBe(1);
      expect(err.maxQueue).toBe(0);
      expect(err.inflight).toBe(1);
    }

    resolveFirst();
    await first;
  });
});

describe("Bulkhead — acquireTimeout", () => {
  it("task в очереди отваливается через timeout", async () => {
    const bh = new Bulkhead({
      name: "test",
      maxConcurrent: 1,
      maxQueue: 5,
      acquireTimeoutMs: 30,
    });

    let resolveFirst!: () => void;
    const first = bh.run(async () => {
      await new Promise<void>((r) => { resolveFirst = r; });
    });

    const queued = bh.run(async () => "queued");

    await expect(queued).rejects.toThrow(/acquire timeout/);

    resolveFirst();
    await first;

    /* После timeout слот свободен — новые задачи работают. */
    expect(await bh.run(async () => "ok")).toBe("ok");
  });
});

describe("Bulkhead — error handling", () => {
  it("ошибка в fn освобождает слот для следующей задачи", async () => {
    const bh = new Bulkhead({ name: "test", maxConcurrent: 1, maxQueue: 5 });

    await expect(
      bh.run(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow(/boom/);

    /* Слот освобождён → следующая работает мгновенно. */
    const result = await bh.run(async () => "ok");
    expect(result).toBe("ok");

    expect(bh.getStats().inflight).toBe(0);
  });
});

describe("Bulkhead — drain()", () => {
  it("drain() отменяет всех в очереди", async () => {
    const bh = new Bulkhead({ name: "test", maxConcurrent: 1, maxQueue: 5 });

    let resolveFirst!: () => void;
    const first = bh.run(async () => {
      await new Promise<void>((r) => { resolveFirst = r; });
    });

    const q1 = bh.run(async () => "q1");
    const q2 = bh.run(async () => "q2");

    bh.drain();

    await expect(q1).rejects.toThrow(/drained/);
    await expect(q2).rejects.toThrow(/drained/);

    resolveFirst();
    await first;
  });
});

describe("Bulkhead — stats", () => {
  it("корректно учитывает acquired/rejected/timeouts", async () => {
    const bh = new Bulkhead({
      name: "test",
      maxConcurrent: 1,
      maxQueue: 1,
      acquireTimeoutMs: 20,
    });

    let resolveFirst!: () => void;
    const first = bh.run(async () => {
      await new Promise<void>((r) => { resolveFirst = r; });
    });

    /* В очереди — отвалится по timeout */
    const queued = bh.run(async () => "q");

    /* Третья — overflow → reject */
    await expect(bh.run(async () => "r")).rejects.toThrow(BulkheadFullError);

    /* Дождёмся timeout queued */
    await expect(queued).rejects.toThrow(/acquire timeout/);

    resolveFirst();
    await first;

    const stats = bh.getStats();
    expect(stats.totalAcquired).toBe(1); /* только first успешно acquired */
    expect(stats.totalRejected).toBe(1);
    expect(stats.totalTimeouts).toBe(1);
  });
});
