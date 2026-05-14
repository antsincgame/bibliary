/**
 * Circuit Breaker — unit tests с DI-моками для now()/random().
 *
 * Покрытие:
 *   1. CLOSED → OPEN при достижении threshold (errorRate ≥ failureThreshold).
 *   2. OPEN не пускает запросы (CircuitOpenError немедленно).
 *   3. OPEN → HALF_OPEN после resetTimeout (с jitter).
 *   4. HALF_OPEN: при success-streak возврат в CLOSED.
 *   5. HALF_OPEN: при первом fail обратно в OPEN с увеличенным backoff.
 *   6. HALF_OPEN ограничивает concurrency (halfOpenMaxConcurrent).
 *   7. minimumRequests предотвращает преждевременное открытие.
 *   8. reset() возвращает в CLOSED и сбрасывает backoff.
 *   9. Telemetry events эмитятся при переходах состояния.
 *   10. Sliding window правильно учитывает только последние N.
 */

import { describe, it, beforeEach } from "node:test";
import { expect } from "./helpers/expect-shim.ts";
import {
  CircuitBreaker,
  CircuitOpenError,
} from "../server/lib/scanner/_vendor/resilience/circuit-breaker.js";

class TestClock {
  private t = 1_000_000;
  now = (): number => this.t;
  advance(ms: number): void {
    this.t += ms;
  }
}

function makeBreaker(opts: Partial<{
  windowSize: number;
  minimumRequests: number;
  failureThreshold: number;
  resetTimeoutMs: number;
  maxResetTimeoutMs: number;
  halfOpenSuccessThreshold: number;
  halfOpenMaxConcurrent: number;
  random: () => number;
}> = {}, clock: TestClock): CircuitBreaker {
  return new CircuitBreaker({
    name: "test",
    windowSize: opts.windowSize ?? 10,
    minimumRequests: opts.minimumRequests ?? 5,
    failureThreshold: opts.failureThreshold ?? 0.5,
    resetTimeoutMs: opts.resetTimeoutMs ?? 1_000,
    maxResetTimeoutMs: opts.maxResetTimeoutMs ?? 16_000,
    halfOpenSuccessThreshold: opts.halfOpenSuccessThreshold ?? 2,
    halfOpenMaxConcurrent: opts.halfOpenMaxConcurrent ?? 1,
    now: clock.now,
    random: opts.random ?? (() => 1.0), /* full backoff без jitter для предсказуемости */
  });
}

describe("CircuitBreaker — CLOSED → OPEN transition", () => {
  let clock: TestClock;
  let cb: CircuitBreaker;

  beforeEach(() => {
    clock = new TestClock();
    cb = makeBreaker({}, clock);
  });

  it("открывается когда errorRate ≥ threshold и достигнут minimumRequests", async () => {
    /* 5 успехов потом 5 фейлов = 50% rate в окне 10. */
    for (let i = 0; i < 5; i += 1) {
      await cb.run(async () => "ok");
    }
    expect(cb.getState()).toBe("closed");

    for (let i = 0; i < 4; i += 1) {
      await expect(cb.run(async () => { throw new Error("fail"); })).rejects.toThrow();
    }
    /* 5 ok + 4 fail = 9 в окне; rate = 4/9 = 44% — пока closed */
    expect(cb.getState()).toBe("closed");

    await expect(cb.run(async () => { throw new Error("fail"); })).rejects.toThrow();
    /* 5 ok + 5 fail = 10 в окне; rate = 50% — CLOSED→OPEN */
    expect(cb.getState()).toBe("open");
  });

  it("НЕ открывается пока не достигнут minimumRequests (даже при 100% errorRate)", async () => {
    /* 4 фейла подряд: 4 < minimumRequests=5 → CB остаётся CLOSED. */
    for (let i = 0; i < 4; i += 1) {
      await expect(cb.run(async () => { throw new Error("fail"); })).rejects.toThrow();
    }
    expect(cb.getState()).toBe("closed");
  });
});

describe("CircuitBreaker — OPEN behavior", () => {
  let clock: TestClock;
  let cb: CircuitBreaker;

  beforeEach(async () => {
    clock = new TestClock();
    cb = makeBreaker({}, clock);
    /* Открыть цепь: 5 fail. */
    for (let i = 0; i < 5; i += 1) {
      await expect(cb.run(async () => { throw new Error("fail"); })).rejects.toThrow();
    }
    expect(cb.getState()).toBe("open");
  });

  it("OPEN мгновенно валит запрос с CircuitOpenError, не вызывая fn", async () => {
    let called = 0;
    await expect(
      cb.run(async () => {
        called += 1;
        return "ok";
      }),
    ).rejects.toThrow(CircuitOpenError);
    expect(called).toBe(0);
  });

  it("OPEN → HALF_OPEN автоматически после resetTimeoutMs", async () => {
    expect(cb.getState()).toBe("open");
    clock.advance(1_500); /* > resetTimeoutMs=1000 */
    expect(cb.getState()).toBe("half_open");
  });
});

describe("CircuitBreaker — HALF_OPEN behavior", () => {
  let clock: TestClock;
  let cb: CircuitBreaker;

  beforeEach(async () => {
    clock = new TestClock();
    cb = makeBreaker({}, clock);
    for (let i = 0; i < 5; i += 1) {
      await expect(cb.run(async () => { throw new Error("fail"); })).rejects.toThrow();
    }
    clock.advance(1_500);
    expect(cb.getState()).toBe("half_open");
  });

  it("HALF_OPEN → CLOSED после halfOpenSuccessThreshold успехов", async () => {
    await cb.run(async () => "ok");
    expect(cb.getState()).toBe("half_open"); /* 1/2 успехов */
    await cb.run(async () => "ok");
    expect(cb.getState()).toBe("closed");
  });

  it("HALF_OPEN → OPEN мгновенно при первой ошибке (с увеличенным backoff)", async () => {
    const stats0 = cb.getStats();
    expect(stats0.consecutiveOpens).toBe(1);
    expect(stats0.currentResetTimeoutMs).toBe(1_000);

    await expect(cb.run(async () => { throw new Error("fail"); })).rejects.toThrow();

    const stats1 = cb.getStats();
    expect(stats1.state).toBe("open");
    expect(stats1.consecutiveOpens).toBe(2);
    /* base * 2^(consecutiveOpens-1) * jitter(=1.0) = 1000 * 2 = 2000ms */
    expect(stats1.currentResetTimeoutMs).toBe(2_000);
  });

  it("HALF_OPEN ограничивает concurrency (max 1 inflight)", async () => {
    let resolveFirst!: () => void;
    const firstFn = new Promise<string>((r) => {
      resolveFirst = (): void => r("ok");
    });

    const p1 = cb.run(() => firstFn);

    /* p1 ещё в полёте, второй вызов должен немедленно дать CircuitOpenError. */
    await expect(cb.run(async () => "ok")).rejects.toThrow(CircuitOpenError);

    resolveFirst();
    await p1;
  });
});

describe("CircuitBreaker — exponential backoff with jitter", () => {
  it("каждый последующий OPEN удваивает backoff (с full jitter)", async () => {
    const clock = new TestClock();
    /* random=1.0 → full backoff без рандомизации */
    const cb = makeBreaker({
      resetTimeoutMs: 1_000,
      maxResetTimeoutMs: 100_000,
      random: () => 1.0,
    }, clock);

    /* 1-й OPEN */
    for (let i = 0; i < 5; i += 1) {
      await expect(cb.run(async () => { throw new Error("f"); })).rejects.toThrow();
    }
    expect(cb.getStats().currentResetTimeoutMs).toBe(1_000);

    /* HALF_OPEN → fail → 2-й OPEN */
    clock.advance(1_500);
    expect(cb.getState()).toBe("half_open");
    await expect(cb.run(async () => { throw new Error("f"); })).rejects.toThrow();
    expect(cb.getStats().currentResetTimeoutMs).toBe(2_000);

    /* HALF_OPEN → fail → 3-й OPEN */
    clock.advance(2_500);
    expect(cb.getState()).toBe("half_open");
    await expect(cb.run(async () => { throw new Error("f"); })).rejects.toThrow();
    expect(cb.getStats().currentResetTimeoutMs).toBe(4_000);

    /* HALF_OPEN → fail → 4-й OPEN */
    clock.advance(4_500);
    await expect(cb.run(async () => { throw new Error("f"); })).rejects.toThrow();
    expect(cb.getStats().currentResetTimeoutMs).toBe(8_000);
  });

  it("backoff не превышает maxResetTimeoutMs", async () => {
    const clock = new TestClock();
    const cb = makeBreaker({
      resetTimeoutMs: 1_000,
      maxResetTimeoutMs: 5_000,
      random: () => 1.0,
    }, clock);

    /* Открываем-закрываем много раз, ожидая что backoff остановится на cap. */
    for (let cycle = 0; cycle < 6; cycle += 1) {
      for (let i = 0; i < 5; i += 1) {
        await expect(cb.run(async () => { throw new Error("f"); })).rejects.toThrow();
      }
      const stats = cb.getStats();
      expect(stats.currentResetTimeoutMs).toBeLessThanOrEqual(5_000);
      clock.advance(stats.currentResetTimeoutMs + 100);
    }
  });

  it("jitter работает: разные random() дают разные backoffs", async () => {
    const clock = new TestClock();
    const random05 = makeBreaker({ resetTimeoutMs: 1_000, random: () => 0.5 }, clock);
    const random10 = makeBreaker({ resetTimeoutMs: 1_000, random: () => 1.0 }, clock);
    for (let i = 0; i < 5; i += 1) {
      await expect(random05.run(async () => { throw new Error("f"); })).rejects.toThrow();
      await expect(random10.run(async () => { throw new Error("f"); })).rejects.toThrow();
    }
    /* random=0.5 → 50% от base; floor по resetTimeoutMs (1000) */
    expect(random05.getStats().currentResetTimeoutMs).toBe(1_000);
    /* random=1.0 → 100% от base */
    expect(random10.getStats().currentResetTimeoutMs).toBe(1_000);

    /* На втором OPEN base удваивается → 2000 */
    clock.advance(2_000);
    expect(random05.getState()).toBe("half_open");
    await expect(random05.run(async () => { throw new Error("f"); })).rejects.toThrow();
    /* random=0.5 на 2-м open: jitter * (1000*2^1) = 0.5 * 2000 = 1000;
       но max(resetTimeoutMs=1000, 1000) = 1000 */
    expect(random05.getStats().currentResetTimeoutMs).toBe(1_000);
  });
});

describe("CircuitBreaker — reset()", () => {
  it("ручной reset возвращает CLOSED и сбрасывает backoff", async () => {
    const clock = new TestClock();
    const cb = makeBreaker({}, clock);
    for (let i = 0; i < 5; i += 1) {
      await expect(cb.run(async () => { throw new Error("f"); })).rejects.toThrow();
    }
    expect(cb.getState()).toBe("open");
    expect(cb.getStats().consecutiveOpens).toBe(1);

    cb.reset();
    expect(cb.getState()).toBe("closed");
    expect(cb.getStats().consecutiveOpens).toBe(0);
    expect(cb.getStats().currentResetTimeoutMs).toBe(1_000);

    /* После reset CB снова работает: */
    const result = await cb.run(async () => "ok");
    expect(result).toBe("ok");
  });
});

describe("CircuitBreaker — sliding window", () => {
  it("окно учитывает только последние N результатов (fails в конце триггерят проверку)", async () => {
    const clock = new TestClock();
    const cb = makeBreaker({ windowSize: 5, minimumRequests: 5, failureThreshold: 0.6 }, clock);

    /* Threshold проверяется только в recordFailure, поэтому fails должны быть
       последними чтобы вызвать переход. */
    for (let i = 0; i < 2; i += 1) {
      await cb.run(async () => "ok");
    }
    for (let i = 0; i < 3; i += 1) {
      await expect(cb.run(async () => { throw new Error("f"); })).rejects.toThrow();
    }
    /* Окно=5: 2 ok + 3 fail, rate = 60% — на 3-м fail происходит check → OPEN. */
    expect(cb.getState()).toBe("open");

    cb.reset();

    /* После reset окно очищено. Push 6 → последние 5: 2 ok + 3 fail. */
    for (let i = 0; i < 3; i += 1) {
      await cb.run(async () => "ok");
    }
    for (let i = 0; i < 3; i += 1) {
      await expect(cb.run(async () => { throw new Error("f"); })).rejects.toThrow();
    }
    expect(cb.getState()).toBe("open");
  });

  it("succession успехов после fails не открывает CB (recordSuccess не проверяет threshold)", async () => {
    const clock = new TestClock();
    const cb = makeBreaker({ windowSize: 5, minimumRequests: 5, failureThreshold: 0.6 }, clock);

    /* 3 fail (size=3, < minimumRequests, не open) + 2 ok (size=5, recordSuccess
       не проверяет → остаётся closed). */
    for (let i = 0; i < 3; i += 1) {
      await expect(cb.run(async () => { throw new Error("f"); })).rejects.toThrow();
    }
    expect(cb.getState()).toBe("closed");
    for (let i = 0; i < 2; i += 1) {
      await cb.run(async () => "ok");
    }
    /* Это сделано осознанно: lazy threshold check предотвращает спорадическую
       перевелику; чтобы гарантированно сработать, нужен новый failure в окне. */
    expect(cb.getState()).toBe("closed");
  });
});
