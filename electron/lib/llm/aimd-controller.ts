/**
 * AIMD Controller — Adaptive Batch / Concurrency Sizing.
 *
 * НАЗНАЧЕНИЕ: динамически подбирать concurrency limit для lane (light/medium/
 * heavy) на основе того, как реально работает LLM сейчас.
 *
 *   Если success-rate > 95% AND P95 latency в норме → увеличиваем (+step).
 *   Если task fail OR P95 взлетел → уменьшаем (× factor).
 *
 * АЛГОРИТМ — TCP-style AIMD (Additive Increase, Multiplicative Decrease),
 * с латентностной обратной связью (TCP Vegas):
 *
 *   record(success, latencyMs):
 *     window.push({ success, latencyMs })
 *     if cooldown not elapsed: return
 *     if any failure in lookback OR p95 > latencyP95Threshold:
 *       newLimit = max(min, floor(current * multiplicativeFactor))
 *     else if successRate ≥ successRateThreshold AND p95 < latencyP95Threshold * 0.7:
 *       newLimit = min(max, current + additiveStep)
 *     if newLimit !== current: emit + lastAdjustedAt = now
 *
 * РОЛЬ: советник. Сам не меняет limit; вызывает onLimitChange callback,
 * caller сам решает применять или нет (например, scheduler.setLimit).
 *
 * ИСТОЧНИКИ:
 *   - Netflix concurrency-limits (gradient algorithm).
 *   - TCP Vegas (latency-based congestion avoidance).
 *   - Resilience4j RateLimiter с adaptive permission limit.
 */

import * as telemetry from "../resilience/telemetry.js";

export interface AimdControllerOptions {
  name: string;
  /** Стартовый concurrency limit. */
  initialLimit: number;
  /** Минимум (никогда не опускаемся ниже). */
  minLimit?: number;
  /** Максимум (никогда не поднимаемся выше). */
  maxLimit?: number;
  /** Размер sliding window результатов. По умолчанию 30. */
  windowSize?: number;
  /** Минимум samples в window до того как делать adjustments. По умолчанию 10. */
  minSamples?: number;
  /** Шаг increase. По умолчанию 1. */
  additiveStep?: number;
  /** Множитель decrease (0..1). По умолчанию 0.5. */
  multiplicativeFactor?: number;
  /** Success rate в window для increase. По умолчанию 0.95. */
  successRateThreshold?: number;
  /** P95 latency cap (ms). При превышении — decrease. По умолчанию 60_000. */
  latencyP95Threshold?: number;
  /** Минимальный интервал между adjustments (ms). По умолчанию 10_000. */
  cooldownMs?: number;
  now?: () => number;
  /** Callback при изменении limit (для DI / интеграции с scheduler). */
  onLimitChange?: (newLimit: number, reason: AimdAdjustReason) => void;
  /** Кастомный emitter для telemetry (тесты). */
  emit?: (event: AimdAdjustedEvent) => void;
}

export type AimdAdjustReason = "increase" | "decrease_failure" | "decrease_latency";

export interface AimdAdjustedEvent {
  name: string;
  oldLimit: number;
  newLimit: number;
  reason: AimdAdjustReason;
  successRate: number;
  p95LatencyMs: number;
  windowSize: number;
}

interface Sample {
  success: boolean;
  latencyMs: number;
}

class SampleWindow {
  private readonly buffer: Sample[];
  private readonly capacity: number;
  private head = 0;
  private filled = 0;

  constructor(capacity: number) {
    this.capacity = Math.max(1, capacity);
    this.buffer = new Array<Sample>(this.capacity);
  }

  push(s: Sample): void {
    this.buffer[this.head] = s;
    this.head = (this.head + 1) % this.capacity;
    if (this.filled < this.capacity) this.filled += 1;
  }

  size(): number {
    return this.filled;
  }

  clear(): void {
    this.head = 0;
    this.filled = 0;
  }

  successRate(): number {
    if (this.filled === 0) return 1;
    let succ = 0;
    for (let i = 0; i < this.filled; i += 1) if (this.buffer[i].success) succ += 1;
    return succ / this.filled;
  }

  hasFailureInRecent(n: number): boolean {
    const take = Math.min(n, this.filled);
    for (let i = 0; i < take; i += 1) {
      const idx = (this.head - 1 - i + this.capacity) % this.capacity;
      if (!this.buffer[idx].success) return true;
    }
    return false;
  }

  p95Latency(): number {
    if (this.filled === 0) return 0;
    const arr: number[] = [];
    for (let i = 0; i < this.filled; i += 1) arr.push(this.buffer[i].latencyMs);
    arr.sort((a, b) => a - b);
    const idx = Math.min(arr.length - 1, Math.floor(arr.length * 0.95));
    return arr[idx];
  }
}

export class AimdController {
  private readonly opts: Required<Omit<AimdControllerOptions, "onLimitChange" | "emit">> & {
    onLimitChange?: AimdControllerOptions["onLimitChange"];
    emit: (event: AimdAdjustedEvent) => void;
  };
  private currentLimit: number;
  private window: SampleWindow;
  private lastAdjustedAt = 0;

  constructor(options: AimdControllerOptions) {
    const minLimit = Math.max(1, options.minLimit ?? 1);
    const maxLimit = Math.max(minLimit, options.maxLimit ?? options.initialLimit * 4);
    const initial = Math.min(maxLimit, Math.max(minLimit, options.initialLimit));
    this.opts = {
      name: options.name,
      initialLimit: initial,
      minLimit,
      maxLimit,
      windowSize: Math.max(5, options.windowSize ?? 30),
      minSamples: Math.max(3, options.minSamples ?? 10),
      additiveStep: Math.max(1, options.additiveStep ?? 1),
      multiplicativeFactor: clamp(options.multiplicativeFactor ?? 0.5, 0.1, 0.9),
      successRateThreshold: clamp(options.successRateThreshold ?? 0.95, 0.5, 1.0),
      latencyP95Threshold: Math.max(100, options.latencyP95Threshold ?? 60_000),
      cooldownMs: Math.max(0, options.cooldownMs ?? 10_000),
      now: options.now ?? (() => Date.now()),
      onLimitChange: options.onLimitChange,
      emit:
        options.emit ??
        ((e): void => {
          telemetry.logEvent({
            type: "aimd.adjusted",
            name: e.name,
            oldLimit: e.oldLimit,
            newLimit: e.newLimit,
            reason: e.reason,
            successRate: round3(e.successRate),
            p95LatencyMs: Math.round(e.p95LatencyMs),
            windowSize: e.windowSize,
          });
        }),
    };
    this.currentLimit = initial;
    this.window = new SampleWindow(this.opts.windowSize);
  }

  record(success: boolean, latencyMs: number): void {
    if (!Number.isFinite(latencyMs) || latencyMs < 0) return;
    this.window.push({ success, latencyMs });

    if (this.window.size() < this.opts.minSamples) return;
    const now = this.opts.now();
    if (now - this.lastAdjustedAt < this.opts.cooldownMs) return;

    /* Решение:
       - decrease_failure: были failure в недавнем lookback (50% window)
       - decrease_latency: P95 > threshold
       - increase: success rate ≥ threshold AND P95 < threshold * 0.7 (запас) */
    const successRate = this.window.successRate();
    const p95 = this.window.p95Latency();
    const lookback = Math.max(3, Math.floor(this.opts.windowSize / 2));
    const recentFail = this.window.hasFailureInRecent(lookback);

    let newLimit = this.currentLimit;
    let reason: AimdAdjustReason | null = null;

    if (recentFail) {
      newLimit = Math.max(this.opts.minLimit, Math.floor(this.currentLimit * this.opts.multiplicativeFactor));
      reason = "decrease_failure";
    } else if (p95 > this.opts.latencyP95Threshold) {
      newLimit = Math.max(this.opts.minLimit, Math.floor(this.currentLimit * this.opts.multiplicativeFactor));
      reason = "decrease_latency";
    } else if (
      successRate >= this.opts.successRateThreshold &&
      p95 < this.opts.latencyP95Threshold * 0.7
    ) {
      newLimit = Math.min(this.opts.maxLimit, this.currentLimit + this.opts.additiveStep);
      if (newLimit !== this.currentLimit) reason = "increase";
    }

    if (reason && newLimit !== this.currentLimit) {
      const oldLimit = this.currentLimit;
      this.currentLimit = newLimit;
      this.lastAdjustedAt = now;
      this.opts.emit({
        name: this.opts.name,
        oldLimit,
        newLimit,
        reason,
        successRate,
        p95LatencyMs: p95,
        windowSize: this.window.size(),
      });
      this.opts.onLimitChange?.(newLimit, reason);
      /* Сбрасываем sample window после adjustment чтобы не дёргать на старых
         данных снова. Это даёт системе время устаканиться при новом limit. */
      this.window.clear();
    }
  }

  getCurrentLimit(): number {
    return this.currentLimit;
  }

  getStats(): {
    name: string;
    currentLimit: number;
    minLimit: number;
    maxLimit: number;
    successRate: number;
    p95LatencyMs: number;
    samples: number;
  } {
    return {
      name: this.opts.name,
      currentLimit: this.currentLimit,
      minLimit: this.opts.minLimit,
      maxLimit: this.opts.maxLimit,
      successRate: this.window.size() === 0 ? 1 : this.window.successRate(),
      p95LatencyMs: this.window.size() === 0 ? 0 : this.window.p95Latency(),
      samples: this.window.size(),
    };
  }

  /** Принудительно вернуть в initial limit (для UI / диагностики). */
  reset(): void {
    this.currentLimit = this.opts.initialLimit;
    this.window.clear();
    this.lastAdjustedAt = 0;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
