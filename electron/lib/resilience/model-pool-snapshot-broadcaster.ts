/**
 * Model Pool Snapshot Broadcaster (Иt 8В MAIN.4) — периодически шлёт
 * снимок состояния `ModelPool` в renderer через `webContents.send`.
 *
 * НАЗНАЧЕНИЕ:
 *   UI-виджет (`pipeline-status-widget.js`) подписывается на
 *   `resilience:model-pool-snapshot` и показывает таблицу
 *   «роль → модель → состояние (busy / idle, VRAM, weight)». Это даёт
 *   пользователю понимание ЧТО именно делает pipeline на уровне моделей,
 *   а не только lanes scheduler.
 *
 * ОТЛИЧИЕ ОТ scheduler-snapshot:
 *   Scheduler показывает «light/medium/heavy queue counters».
 *   Model-pool показывает «какие конкретно модели сейчас в VRAM и кто их держит».
 *   Это **дополнение**, не замена — оба snapshot'а нужны UI одновременно:
 *     - scheduler: «5 задач в heavy queue»
 *     - model-pool: «загружены qwen-vl-7b (vision_ocr, busy=1) и llama-8b (crystallizer, idle)»
 *
 * АРХИТЕКТУРНЫЙ КОНТРАКТ:
 *   - Read-only: НЕ влияет на работу пула, только наблюдает через getStats().
 *   - Periodic poll каждые `intervalMs` (default 3000) — модели меняются
 *     медленнее scheduler lanes, нет смысла молотить чаще.
 *   - Только эмитит когда snapshot ИЗМЕНИЛСЯ (или раз в N циклов для liveness).
 *   - Структурно идентичен `scheduler-snapshot-broadcaster` — единый паттерн.
 */

import type { BrowserWindow } from "electron";
import { type EventSink, noopEventSink } from "./event-sink.js";
import { getModelPool } from "../llm/model-pool.js";
import type { ModelWeight } from "../llm/model-size-classifier.js";

const DEFAULT_POLL_INTERVAL_MS = 3_000;
/** Максимум тиков подряд без изменений до принудительного broadcast (liveness ping). */
const FORCE_BROADCAST_EVERY_N_TICKS = 20; /* ~60s при 3s интервале */

/** Публичный payload для IPC (renderer-friendly, без internal Map). */
export interface ModelPoolSnapshotPayload {
  capacityMB: number;
  totalLoadedMB: number;
  loadedCount: number;
  models: ReadonlyArray<{
    modelKey: string;
    role?: string;
    weight: ModelWeight;
    refCount: number;
    vramMB: number;
    source: "pool" | "external";
  }>;
}

interface BroadcasterState {
  timer: NodeJS.Timeout | null;
  sink: EventSink;
  active: boolean;
  intervalMs: number;
  lastSnapshotJson: string;
  ticksSinceBroadcast: number;
}

const state: BroadcasterState = {
  timer: null,
  sink: noopEventSink,
  active: false,
  intervalMs: DEFAULT_POLL_INTERVAL_MS,
  lastSnapshotJson: "",
  ticksSinceBroadcast: 0,
};

function normalizeSink(
  sink: EventSink | (() => BrowserWindow | null),
): EventSink {
  if (sink.length === 2) return sink as EventSink;
  const getter = sink as () => BrowserWindow | null;
  return (channel, payload) => {
    const win = getter();
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };
}

/**
 * Запустить периодический broadcast snapshot'ов.
 *
 * Идемпотентна: повторный вызов — no-op (только обновляет sink).
 */
export function startModelPoolSnapshotBroadcaster(
  sink: EventSink | (() => BrowserWindow | null),
  opts: { intervalMs?: number } = {},
): void {
  state.sink = normalizeSink(sink);
  state.active = true;
  if (typeof opts.intervalMs === "number" && opts.intervalMs > 0) {
    state.intervalMs = opts.intervalMs;
  }
  if (state.timer) return;
  scheduleNext();
}

/** Остановить broadcaster (для тестов / shutdown). */
export function stopModelPoolSnapshotBroadcaster(): void {
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  state.sink = noopEventSink;
  state.active = false;
  state.lastSnapshotJson = "";
  state.ticksSinceBroadcast = 0;
}

/**
 * Принудительно отправить snapshot прямо сейчас (минуя интервал).
 * Используется при изменениях состояния пула которые хочется отразить
 * немедленно (например после успешного withModel в большом import-batch).
 */
export function forceBroadcastModelPoolSnapshot(): void {
  if (!state.active) return;
  const snapshot = buildPayload();
  emitSnapshot(snapshot);
  state.lastSnapshotJson = JSON.stringify(snapshot);
  state.ticksSinceBroadcast = 0;
}

function scheduleNext(): void {
  if (state.timer) clearTimeout(state.timer);
  state.timer = setTimeout(tick, state.intervalMs);
}

function tick(): void {
  state.timer = null;
  if (!state.active) return;

  try {
    const snapshot = buildPayload();
    const json = JSON.stringify(snapshot);
    state.ticksSinceBroadcast += 1;

    if (json !== state.lastSnapshotJson || state.ticksSinceBroadcast >= FORCE_BROADCAST_EVERY_N_TICKS) {
      emitSnapshot(snapshot);
      state.lastSnapshotJson = json;
      state.ticksSinceBroadcast = 0;
    }
  } catch (err) {
    console.warn("[model-pool-snapshot-broadcaster] tick failed:", err instanceof Error ? err.message : err);
  } finally {
    if (state.active) scheduleNext();
  }
}

function buildPayload(): ModelPoolSnapshotPayload {
  const stats = getModelPool().getStats();
  return {
    capacityMB: stats.capacityMB,
    totalLoadedMB: stats.totalLoadedMB,
    loadedCount: stats.loadedCount,
    models: stats.models.map((m) => ({
      modelKey: m.modelKey,
      role: m.role,
      weight: m.weight,
      refCount: m.refCount,
      vramMB: m.vramMB,
      source: m.source,
    })),
  };
}

function emitSnapshot(snapshot: ModelPoolSnapshotPayload): void {
  try {
    state.sink("resilience:model-pool-snapshot", snapshot);
  } catch (err) {
    console.warn(
      "[model-pool-snapshot-broadcaster] sink threw:",
      err instanceof Error ? err.message : err,
    );
  }
}

/* ─── Test helpers ─────────────────────────────────────────────────── */

/** Сбросить state — для тестов. */
export function _resetModelPoolSnapshotBroadcasterForTests(): void {
  stopModelPoolSnapshotBroadcaster();
}

/** Прочитать текущий cached JSON snapshot — для тестов и диагностики. */
export function _getLastModelPoolSnapshotJsonForTests(): string {
  return state.lastSnapshotJson;
}
