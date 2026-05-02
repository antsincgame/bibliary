/**
 * OCR Drift Monitor — unit tests с DI-emitter (без monkey-patch telemetry).
 *
 * Покрытие:
 *   1. До minSamples drift не эмитится.
 *   2. При drop в quality drift detected (правильный driftRatio).
 *   3. Cooldown подавляет повторные эмиты в окне cooldownMs.
 *   4. Per-engine isolation: drop в text-layer не триггерит system-ocr.
 *   5. Stable workload: при стабильном quality drift НЕ эмитится.
 *   6. getStats() / reset().
 *   7. Игнорирование invalid quality (NaN, Infinity, negative).
 */

import { describe, it } from "node:test";
import { expect } from "./helpers/expect-shim.ts";
import { OcrDriftMonitor, type OcrDriftEvent } from "../electron/lib/scanner/ocr-drift-monitor.js";

class TestClock {
  private t = 1_000_000;
  now = (): number => this.t;
  advance(ms: number): void {
    this.t += ms;
  }
}

function makeRecorder(): {
  events: OcrDriftEvent[];
  emit: (e: OcrDriftEvent) => void;
} {
  const events: OcrDriftEvent[] = [];
  return {
    events,
    emit: (e): void => {
      events.push(e);
    },
  };
}

describe("OcrDriftMonitor — basic detection", () => {
  it("до minSamples drift не эмитится", () => {
    const rec = makeRecorder();
    const clock = new TestClock();
    const monitor = new OcrDriftMonitor({
      minSamples: 20,
      now: clock.now,
      emit: rec.emit,
    });
    for (let i = 0; i < 10; i += 1) monitor.record("text-layer", 0.9);
    for (let i = 0; i < 5; i += 1) monitor.record("text-layer", 0.3);
    expect(rec.events.length).toBe(0);
  });

  it("при drop в quality эмитится drift с правильным ratio", () => {
    const rec = makeRecorder();
    const clock = new TestClock();
    const monitor = new OcrDriftMonitor({
      minSamples: 20,
      recentSize: 10,
      driftThreshold: 0.15,
      now: clock.now,
      emit: rec.emit,
    });
    for (let i = 0; i < 30; i += 1) monitor.record("text-layer", 0.9);
    rec.events.length = 0;
    for (let i = 0; i < 10; i += 1) monitor.record("text-layer", 0.5);

    expect(rec.events.length).toBeGreaterThanOrEqual(1);
    const e = rec.events[0];
    expect(e.engine).toBe("text-layer");
    /* baselineMean ≈ (30*0.9 + 10*0.5)/40 = 0.8.
       recentMean = mean(последние 10) = 0.5.
       drift = 0.3, ratio = 0.375. */
    expect(e.driftRatio).toBeGreaterThanOrEqual(0.15);
    expect(e.driftRatio).toBeLessThanOrEqual(0.5);
  });

  it("cooldown подавляет повторные эмиты, после прохождения окна — снова эмитится", () => {
    const rec = makeRecorder();
    const clock = new TestClock();
    const monitor = new OcrDriftMonitor({
      minSamples: 20,
      recentSize: 10,
      driftThreshold: 0.15,
      cooldownMs: 60_000,
      now: clock.now,
      emit: rec.emit,
    });
    for (let i = 0; i < 30; i += 1) monitor.record("text-layer", 0.9);
    for (let i = 0; i < 10; i += 1) monitor.record("text-layer", 0.5);
    const firstCount = rec.events.length;
    expect(firstCount).toBeGreaterThanOrEqual(1);

    /* Ещё низкие quality — cooldown подавляет. */
    for (let i = 0; i < 10; i += 1) monitor.record("text-layer", 0.5);
    expect(rec.events.length).toBe(firstCount);

    /* Прошло cooldown — снова эмитится. */
    clock.advance(70_000);
    for (let i = 0; i < 10; i += 1) monitor.record("text-layer", 0.5);
    expect(rec.events.length).toBeGreaterThan(firstCount);
  });

  it("per-engine isolation: drop в text-layer не триггерит system-ocr", () => {
    const rec = makeRecorder();
    const clock = new TestClock();
    const monitor = new OcrDriftMonitor({
      minSamples: 20,
      recentSize: 10,
      driftThreshold: 0.15,
      now: clock.now,
      emit: rec.emit,
    });
    for (let i = 0; i < 30; i += 1) monitor.record("text-layer", 0.9);
    for (let i = 0; i < 10; i += 1) monitor.record("text-layer", 0.5);
    for (let i = 0; i < 30; i += 1) monitor.record("system-ocr", 0.85);
    expect(rec.events.length).toBeGreaterThanOrEqual(1);
    expect(rec.events.every((e) => e.engine === "text-layer")).toBe(true);
  });

  it("стабильный workload (низкая дисперсия) не триггерит drift", () => {
    const rec = makeRecorder();
    const monitor = new OcrDriftMonitor({
      minSamples: 20,
      recentSize: 10,
      driftThreshold: 0.15,
      emit: rec.emit,
    });
    for (let i = 0; i < 50; i += 1) {
      const noise = (i % 5) * 0.01;
      monitor.record("vision-llm", 0.85 + noise);
    }
    expect(rec.events.length).toBe(0);
  });
});

describe("OcrDriftMonitor — getStats / reset / validation", () => {
  it("getStats возвращает корректные значения", () => {
    const monitor = new OcrDriftMonitor();
    for (let i = 0; i < 10; i += 1) monitor.record("text-layer", 0.8);
    const stats = monitor.getStats("text-layer");
    expect(stats).toBeDefined();
    expect(stats!.samples).toBe(10);
    expect(stats!.baselineMean).toBe(0.8);
    expect(stats!.recentMean).toBe(0.8);
  });

  it("reset() очищает все windows", () => {
    const monitor = new OcrDriftMonitor();
    for (let i = 0; i < 10; i += 1) monitor.record("text-layer", 0.8);
    monitor.reset();
    expect(monitor.getStats("text-layer")).toBe(null);
  });

  it("игнорирует non-finite/negative quality", () => {
    const monitor = new OcrDriftMonitor();
    monitor.record("text-layer", NaN);
    monitor.record("text-layer", -0.1);
    monitor.record("text-layer", Infinity);
    expect(monitor.getStats("text-layer")).toBe(null);
  });
});
