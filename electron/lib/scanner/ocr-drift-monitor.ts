/**
 * OCR Quality Drift Monitor — telemetry-only.
 *
 * НАЗНАЧЕНИЕ: ловить деградацию качества OCR во времени (например, после
 * обновления Tesseract, смены драйвера GPU, накопления ошибок vision-LLM).
 * Никаких блокировок и автокорректировок — только сигнал в telemetry для
 * пост-морт анализа.
 *
 * АЛГОРИТМ:
 *   1. Per-engine sliding window последних N quality-scores (text-layer /
 *      system-ocr / vision-llm — каждый свой; они несопоставимы).
 *   2. После накопления minSamples — на каждой записи считаем:
 *        baseline = mean(window)
 *        recent   = mean(последние recentSize)
 *        drift    = baseline - recent
 *   3. Если drift ≥ driftThreshold — эмитим `ocr.quality_drift` (не чаще
 *      cooldownMs чтобы не флудить лог при систематической деградации).
 *
 * ПОЧЕМУ telemetry-only: автоматический ремедиатор сложен (понизить
 * acceptableQuality? переключить engine? выгрузить vision-LLM?), и любое
 * решение зависит от того, является ли деградация транзитной или настоящей.
 * Делать решения без человека — рискованно. Сигнал в telemetry даёт нам
 * наблюдаемость без рисков.
 */

import * as telemetry from "../resilience/telemetry.js";
import type { OcrEngine } from "./extractors/ocr-cache.js";

export interface OcrDriftEvent {
  engine: OcrEngine;
  baselineMean: number;
  recentMean: number;
  driftRatio: number;
  recentSamples: number;
  windowSize: number;
}

export interface OcrDriftMonitorOptions {
  windowSize?: number;
  minSamples?: number;
  recentSize?: number;
  /** Минимальный drift (доля 0..1) для эмита события. По умолчанию 0.15 (15% падение). */
  driftThreshold?: number;
  /** Минимальный интервал между эмитами per-engine (ms). По умолчанию 60_000. */
  cooldownMs?: number;
  now?: () => number;
  /** Кастомный emit (для тестов). По умолчанию пишет в telemetry.logEvent. */
  emit?: (event: OcrDriftEvent) => void;
}

class NumberWindow {
  private readonly buffer: number[];
  private readonly capacity: number;
  private head = 0;
  private filled = 0;

  constructor(capacity: number) {
    this.capacity = Math.max(1, capacity);
    this.buffer = new Array<number>(this.capacity).fill(0);
  }

  push(v: number): void {
    this.buffer[this.head] = v;
    this.head = (this.head + 1) % this.capacity;
    if (this.filled < this.capacity) this.filled += 1;
  }

  size(): number {
    return this.filled;
  }

  mean(): number {
    if (this.filled === 0) return 0;
    let sum = 0;
    for (let i = 0; i < this.filled; i += 1) sum += this.buffer[i];
    return sum / this.filled;
  }

  /** Mean последних N (если N > size — берём всё что есть). */
  recentMean(n: number): number {
    if (this.filled === 0) return 0;
    const take = Math.min(n, this.filled);
    let sum = 0;
    for (let i = 0; i < take; i += 1) {
      const idx = (this.head - 1 - i + this.capacity) % this.capacity;
      sum += this.buffer[idx];
    }
    return sum / take;
  }

  clear(): void {
    this.head = 0;
    this.filled = 0;
  }
}

export class OcrDriftMonitor {
  private readonly windows = new Map<OcrEngine, NumberWindow>();
  private readonly lastEmittedAt = new Map<OcrEngine, number>();
  private readonly opts: Required<Omit<OcrDriftMonitorOptions, "emit">> & {
    emit: (event: OcrDriftEvent) => void;
  };

  constructor(options: OcrDriftMonitorOptions = {}) {
    this.opts = {
      windowSize: options.windowSize ?? 50,
      minSamples: options.minSamples ?? 20,
      recentSize: options.recentSize ?? 10,
      driftThreshold: options.driftThreshold ?? 0.15,
      cooldownMs: options.cooldownMs ?? 60_000,
      now: options.now ?? (() => Date.now()),
      emit:
        options.emit ??
        ((event): void => {
          telemetry.logEvent({
            type: "ocr.quality_drift",
            engine: event.engine,
            baselineMean: event.baselineMean,
            recentMean: event.recentMean,
            driftRatio: event.driftRatio,
            recentSamples: event.recentSamples,
            windowSize: event.windowSize,
          });
        }),
    };
  }

  /**
   * Записать результат успешной попытки. Telemetry эмитится автоматически
   * если обнаружен drift. Вызывать ПОСЛЕ успешного OCR с реальным quality > 0.
   */
  record(engine: OcrEngine, quality: number): void {
    if (!Number.isFinite(quality) || quality < 0) return;
    const w = this.getWindow(engine);
    w.push(quality);

    if (w.size() < this.opts.minSamples) return;

    const baseline = w.mean();
    const recent = w.recentMean(this.opts.recentSize);
    if (baseline <= 0) return;

    const drift = baseline - recent;
    const driftRatio = drift / baseline;

    if (driftRatio >= this.opts.driftThreshold) {
      const lastTs = this.lastEmittedAt.get(engine) ?? 0;
      const now = this.opts.now();
      if (now - lastTs >= this.opts.cooldownMs) {
        this.lastEmittedAt.set(engine, now);
        this.opts.emit({
          engine,
          baselineMean: round3(baseline),
          recentMean: round3(recent),
          driftRatio: round3(driftRatio),
          recentSamples: Math.min(this.opts.recentSize, w.size()),
          windowSize: w.size(),
        });
      }
    }
  }

  /** Снимок состояния (для UI / диагностики). */
  getStats(engine: OcrEngine): {
    samples: number;
    baselineMean: number;
    recentMean: number;
  } | null {
    const w = this.windows.get(engine);
    if (!w || w.size() === 0) return null;
    return {
      samples: w.size(),
      baselineMean: round3(w.mean()),
      recentMean: round3(w.recentMean(this.opts.recentSize)),
    };
  }

  reset(): void {
    this.windows.clear();
    this.lastEmittedAt.clear();
  }

  private getWindow(engine: OcrEngine): NumberWindow {
    let w = this.windows.get(engine);
    if (!w) {
      w = new NumberWindow(this.opts.windowSize);
      this.windows.set(engine, w);
    }
    return w;
  }
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

let monitor: OcrDriftMonitor | null = null;

export function getOcrDriftMonitor(): OcrDriftMonitor {
  if (!monitor) monitor = new OcrDriftMonitor();
  return monitor;
}

export function _resetOcrDriftMonitorForTests(): void {
  monitor = null;
}
