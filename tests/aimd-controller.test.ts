/**
 * AIMD Controller — unit tests.
 *
 * Покрытие:
 *   1. До minSamples нет adjustments.
 *   2. Все успехи + low latency → +1 (increase).
 *   3. Failure в недавнем lookback → /2 (decrease_failure).
 *   4. P95 latency > threshold → /2 (decrease_latency).
 *   5. Cooldown подавляет adjustment.
 *   6. min/max bounds соблюдаются.
 *   7. onLimitChange callback вызывается.
 *   8. Reset() возвращает в initialLimit.
 */

import { describe, it } from "node:test";
import { expect } from "./helpers/expect-shim.ts";
import {
  AimdController,
  type AimdAdjustedEvent,
} from "../server/lib/scanner/_vendor/llm/aimd-controller.js";

class TestClock {
  private t = 1_000_000;
  now = (): number => this.t;
  advance(ms: number): void {
    this.t += ms;
  }
}

function makeRecorder(): { events: AimdAdjustedEvent[]; emit: (e: AimdAdjustedEvent) => void } {
  const events: AimdAdjustedEvent[] = [];
  return { events, emit: (e): void => { events.push(e); } };
}

describe("AimdController — basic adjustments", () => {
  it("до minSamples нет adjustments", () => {
    const rec = makeRecorder();
    const clock = new TestClock();
    const ctl = new AimdController({
      name: "test",
      initialLimit: 4,
      minLimit: 1,
      maxLimit: 16,
      windowSize: 30,
      minSamples: 10,
      cooldownMs: 0,
      latencyP95Threshold: 60_000,
      now: clock.now,
      emit: rec.emit,
    });
    for (let i = 0; i < 9; i += 1) ctl.record(true, 100);
    expect(rec.events.length).toBe(0);
    expect(ctl.getCurrentLimit()).toBe(4);
  });

  it("все успехи + low latency → +1 (increase)", () => {
    const rec = makeRecorder();
    const clock = new TestClock();
    const ctl = new AimdController({
      name: "test",
      initialLimit: 4,
      minLimit: 1,
      maxLimit: 16,
      windowSize: 30,
      minSamples: 10,
      cooldownMs: 0,
      latencyP95Threshold: 60_000,
      additiveStep: 1,
      now: clock.now,
      emit: rec.emit,
    });
    for (let i = 0; i < 12; i += 1) ctl.record(true, 1_000);
    expect(ctl.getCurrentLimit()).toBe(5);
    expect(rec.events.length).toBe(1);
    expect(rec.events[0].reason).toBe("increase");
  });

  it("failure в недавнем lookback → /2 (decrease_failure)", () => {
    const rec = makeRecorder();
    const clock = new TestClock();
    const ctl = new AimdController({
      name: "test",
      initialLimit: 8,
      minLimit: 1,
      maxLimit: 16,
      windowSize: 20,
      minSamples: 10,
      cooldownMs: 0,
      multiplicativeFactor: 0.5,
      now: clock.now,
      emit: rec.emit,
    });
    /* 9 success + 1 failure (recent) */
    for (let i = 0; i < 9; i += 1) ctl.record(true, 1_000);
    ctl.record(false, 5_000);
    expect(ctl.getCurrentLimit()).toBe(4); /* 8 * 0.5 = 4 */
    expect(rec.events[0].reason).toBe("decrease_failure");
  });

  it("P95 latency > threshold → /2 (decrease_latency)", () => {
    const rec = makeRecorder();
    const clock = new TestClock();
    const ctl = new AimdController({
      name: "test",
      initialLimit: 8,
      minLimit: 1,
      maxLimit: 16,
      windowSize: 10,
      minSamples: 10,
      cooldownMs: 0,
      latencyP95Threshold: 5_000,
      multiplicativeFactor: 0.5,
      now: clock.now,
      emit: rec.emit,
    });
    /* 9 success @ 1s + 1 success @ 20s. P95 из 10 (idx=9) = 20000 > 5000.
       Никаких failures → не decrease_failure; P95 > threshold → decrease_latency. */
    for (let i = 0; i < 9; i += 1) ctl.record(true, 1_000);
    ctl.record(true, 20_000);
    expect(ctl.getCurrentLimit()).toBe(4);
    expect(rec.events[0].reason).toBe("decrease_latency");
  });
});

describe("AimdController — cooldown & bounds", () => {
  it("cooldown подавляет adjustment в окне", () => {
    const rec = makeRecorder();
    const clock = new TestClock();
    const ctl = new AimdController({
      name: "test",
      initialLimit: 4,
      minSamples: 10,
      cooldownMs: 5_000,
      now: clock.now,
      emit: rec.emit,
    });
    for (let i = 0; i < 12; i += 1) ctl.record(true, 100);
    expect(ctl.getCurrentLimit()).toBe(5);
    expect(rec.events.length).toBe(1);

    /* Ещё 12 success — но cooldown не прошёл. (Window очищается после adj,
       поэтому нужно снова накопить minSamples; но cooldown лимитирует время.) */
    clock.advance(2_000);
    for (let i = 0; i < 12; i += 1) ctl.record(true, 100);
    expect(rec.events.length).toBe(1);

    /* После прохода cooldown — снова можно adjust. */
    clock.advance(4_000);
    for (let i = 0; i < 12; i += 1) ctl.record(true, 100);
    expect(rec.events.length).toBeGreaterThan(1);
  });

  it("min/max bounds соблюдаются: не опускаемся ниже min", () => {
    const rec = makeRecorder();
    const clock = new TestClock();
    const ctl = new AimdController({
      name: "test",
      initialLimit: 2,
      minLimit: 1,
      maxLimit: 16,
      minSamples: 10,
      cooldownMs: 0,
      multiplicativeFactor: 0.5,
      now: clock.now,
      emit: rec.emit,
    });
    /* 9 success + 1 fail → 2 * 0.5 = 1 (= minLimit) */
    for (let i = 0; i < 9; i += 1) ctl.record(true, 100);
    ctl.record(false, 100);
    expect(ctl.getCurrentLimit()).toBe(1);

    /* Ещё одна серия с fail — limit уже на min, decrease невозможен. */
    for (let i = 0; i < 9; i += 1) ctl.record(true, 100);
    ctl.record(false, 100);
    expect(ctl.getCurrentLimit()).toBe(1); /* остался 1 */
  });

  it("max bound: не поднимаемся выше max", () => {
    const rec = makeRecorder();
    const clock = new TestClock();
    const ctl = new AimdController({
      name: "test",
      initialLimit: 4,
      minLimit: 1,
      maxLimit: 5,
      minSamples: 10,
      cooldownMs: 0,
      additiveStep: 1,
      now: clock.now,
      emit: rec.emit,
    });
    for (let i = 0; i < 12; i += 1) ctl.record(true, 100);
    expect(ctl.getCurrentLimit()).toBe(5); /* 4 → 5 */

    for (let i = 0; i < 12; i += 1) ctl.record(true, 100);
    expect(ctl.getCurrentLimit()).toBe(5); /* остался на max */
  });
});

describe("AimdController — onLimitChange callback / reset", () => {
  it("onLimitChange вызывается при adjustment", () => {
    const observed: Array<{ limit: number; reason: string }> = [];
    const clock = new TestClock();
    const ctl = new AimdController({
      name: "test",
      initialLimit: 4,
      minSamples: 10,
      cooldownMs: 0,
      now: clock.now,
      onLimitChange: (newLimit, reason): void => {
        observed.push({ limit: newLimit, reason });
      },
    });
    for (let i = 0; i < 12; i += 1) ctl.record(true, 100);
    expect(observed.length).toBe(1);
    expect(observed[0].limit).toBe(5);
    expect(observed[0].reason).toBe("increase");
  });

  it("reset() возвращает limit в initial и очищает window", () => {
    const clock = new TestClock();
    const ctl = new AimdController({
      name: "test",
      initialLimit: 4,
      minSamples: 10,
      cooldownMs: 0,
      now: clock.now,
    });
    for (let i = 0; i < 12; i += 1) ctl.record(true, 100);
    expect(ctl.getCurrentLimit()).toBe(5);

    ctl.reset();
    expect(ctl.getCurrentLimit()).toBe(4);
    expect(ctl.getStats().samples).toBe(0);
  });
});
