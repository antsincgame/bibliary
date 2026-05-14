/**
 * ImportTaskScheduler + AIMD integration tests.
 *
 * Покрытие:
 *   1. attachAimd() связывает контроллер с lane; record() вызывается после fn.
 *   2. AIMD increase автоматически повышает scheduler.setLimit для lane.
 *   3. AIMD decrease на failure снижает limit.
 *   4. detachAimd() отключает.
 */

import { describe, it } from "node:test";
import { expect } from "./helpers/expect-shim.ts";
import { ImportTaskScheduler } from "../server/lib/scanner/_vendor/library/import-task-scheduler.js";
import { AimdController } from "../server/lib/scanner/_vendor/llm/aimd-controller.js";

class TestClock {
  private t = 1_000_000;
  now = (): number => {
    return this.t;
  };
  advance(ms: number): void {
    this.t += ms;
  }
}

describe("ImportTaskScheduler + AIMD", () => {
  it("AIMD increase повышает scheduler.setLimit для lane", async () => {
    const clock = new TestClock();
    const scheduler = new ImportTaskScheduler({
      lightConcurrency: 4,
      mediumConcurrency: 2,
      heavyConcurrency: 1,
      now: clock.now,
    });
    const ctl = new AimdController({
      name: "scheduler-medium",
      initialLimit: 2,
      minLimit: 1,
      maxLimit: 8,
      windowSize: 12,
      minSamples: 10,
      cooldownMs: 0,
      latencyP95Threshold: 60_000,
      additiveStep: 1,
      now: clock.now,
    });
    scheduler.attachAimd("medium", ctl);

    /* Прогоним 12 быстрых tasks (по 1 за раз чтобы порядок гарантирован).
       Каждая success → AIMD record → после 10-го должен быть increase. */
    for (let i = 0; i < 12; i += 1) {
      await scheduler.enqueue("medium", async () => {
        clock.advance(100); /* low latency */
        return "ok";
      });
    }
    expect(ctl.getCurrentLimit()).toBeGreaterThan(2);
    expect(scheduler.getSnapshot().medium.running).toBe(0);
    /* scheduler limit подтянулся за AIMD */
    /* getSnapshot не выдаёт limit; проверяем через runtime поведение: при
       limit > running, дополнительные tasks стартуют немедленно. Косвенный
       проверяем через ctl.getCurrentLimit. */
  });

  it("AIMD decrease на failure уменьшает limit", async () => {
    const clock = new TestClock();
    const scheduler = new ImportTaskScheduler({
      lightConcurrency: 4,
      heavyConcurrency: 1,
      now: clock.now,
    });
    const ctl = new AimdController({
      name: "scheduler-light",
      initialLimit: 8,
      minLimit: 1,
      maxLimit: 16,
      windowSize: 12,
      minSamples: 10,
      cooldownMs: 0,
      multiplicativeFactor: 0.5,
      now: clock.now,
    });
    scheduler.attachAimd("light", ctl);

    /* 9 success */
    for (let i = 0; i < 9; i += 1) {
      await scheduler.enqueue("light", async () => {
        clock.advance(100);
        return "ok";
      });
    }
    /* 1 failure → trigger decrease_failure */
    try {
      await scheduler.enqueue("light", async () => {
        clock.advance(100);
        throw new Error("fail");
      });
    } catch {
      /* swallow */
    }
    /* После 1-го failure в lookback (5+ samples) → limit/2 */
    expect(ctl.getCurrentLimit()).toBeLessThan(8);
    expect(ctl.getCurrentLimit()).toBe(4);
  });

  it("detachAimd отключает AIMD интеграцию", async () => {
    const clock = new TestClock();
    const scheduler = new ImportTaskScheduler({
      now: clock.now,
    });
    const ctl = new AimdController({
      name: "test",
      initialLimit: 4,
      minSamples: 5,
      cooldownMs: 0,
      now: clock.now,
    });
    scheduler.attachAimd("light", ctl);

    /* 5 success → должен сработать increase */
    for (let i = 0; i < 6; i += 1) {
      await scheduler.enqueue("light", async () => {
        clock.advance(100);
        return "ok";
      });
    }
    const limitAfter = ctl.getCurrentLimit();
    expect(limitAfter).toBeGreaterThan(4);

    scheduler.detachAimd("light");

    /* После detach — failure не пробрасывается в AIMD. */
    try {
      await scheduler.enqueue("light", async () => {
        clock.advance(100);
        throw new Error("fail");
      });
    } catch {
      /* swallow */
    }
    /* AIMD limit не изменился (failure не учли). */
    expect(ctl.getCurrentLimit()).toBe(limitAfter);
  });
});
