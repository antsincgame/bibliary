/**
 * Scheduler Snapshot Broadcaster — периодически шлёт снимок состояния
 * `ImportTaskScheduler` в renderer через `webContents.send`.
 *
 * НАЗНАЧЕНИЕ:
 *   UI-виджет (`pipeline-status-widget.js`) подписывается на `resilience:scheduler-snapshot`
 *   и показывает counters lanes (light/medium/heavy running+queued). Это даёт
 *   пользователю видимость что происходит в pipeline во время import — какие
 *   стадии активны, есть ли backlog.
 *
 * АРХИТЕКТУРНЫЙ КОНТРАКТ:
 *   - Read-only: НЕ влияет на работу scheduler'а, только наблюдает.
 *   - Periodic poll каждые `intervalMs` (default 2000) — компромисс между
 *     real-time UI и нагрузкой.
 *   - Только эмитит когда snapshot ИЗМЕНИЛСЯ (или раз в N циклов для liveness).
 *     Это снижает шум IPC при простаивающем pipeline.
 *   - Аналогично watchdog: принимает `windowGetter` callback для обращения к
 *     mainWindow, чтобы не зависеть от глобального state Electron.
 *
 * Когда scheduler в Итерациях 5+ начнёт реально использоваться (Calibre converters,
 * vision-meta, evaluator integration) — виджет автоматически покажет live данные
 * без изменения broadcaster'а.
 */

import type { BrowserWindow } from "electron";
import { getImportScheduler } from "../library/import-task-scheduler.js";
import type { SchedulerSnapshot } from "../library/import-task-scheduler.js";

const DEFAULT_POLL_INTERVAL_MS = 2_000;
/** Максимум тиков подряд без изменений до принудительного broadcast (liveness ping). */
const FORCE_BROADCAST_EVERY_N_TICKS = 30; /* ~60s при 2s интервале */

interface BroadcasterState {
  timer: NodeJS.Timeout | null;
  getWindow: (() => BrowserWindow | null) | null;
  intervalMs: number;
  lastSnapshotJson: string;
  ticksSinceBroadcast: number;
}

const state: BroadcasterState = {
  timer: null,
  getWindow: null,
  intervalMs: DEFAULT_POLL_INTERVAL_MS,
  lastSnapshotJson: "",
  ticksSinceBroadcast: 0,
};

/**
 * Запустить периодический broadcast snapshot'ов.
 *
 * Идемпотентна: повторный вызов — no-op.
 * Можно вызывать многократно с разными `windowGetter` — последний выигрывает.
 */
export function startSchedulerSnapshotBroadcaster(
  windowGetter: () => BrowserWindow | null,
  opts: { intervalMs?: number } = {},
): void {
  state.getWindow = windowGetter;
  if (typeof opts.intervalMs === "number" && opts.intervalMs > 0) {
    state.intervalMs = opts.intervalMs;
  }
  if (state.timer) return; /* уже запущен */

  scheduleNext();
}

/** Остановить broadcaster (для тестов / shutdown). */
export function stopSchedulerSnapshotBroadcaster(): void {
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  state.getWindow = null;
  state.lastSnapshotJson = "";
  state.ticksSinceBroadcast = 0;
}

/**
 * Принудительно отправить snapshot прямо сейчас (минуя интервал).
 * Используется при изменениях scheduler состояния которые хочется отразить
 * немедленно (например после `setLimit`).
 *
 * Обновляет внутренний cache (lastSnapshotJson + сбрасывает ticksSinceBroadcast)
 * чтобы следующий plановый tick не повторил тот же snapshot — change detection
 * корректно сработает.
 */
export function forceBroadcastSchedulerSnapshot(): void {
  if (!state.getWindow) return;
  const snapshot = getImportScheduler().getSnapshot();
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
  if (!state.getWindow) return;

  try {
    const snapshot = getImportScheduler().getSnapshot();
    const json = JSON.stringify(snapshot);
    state.ticksSinceBroadcast += 1;

    if (json !== state.lastSnapshotJson || state.ticksSinceBroadcast >= FORCE_BROADCAST_EVERY_N_TICKS) {
      emitSnapshot(snapshot);
      state.lastSnapshotJson = json;
      state.ticksSinceBroadcast = 0;
    }
  } catch (err) {
    console.warn("[scheduler-snapshot-broadcaster] tick failed:", err instanceof Error ? err.message : err);
  } finally {
    /* Перепланируем независимо от исхода — broadcaster должен быть устойчивым.
       После stopSchedulerSnapshotBroadcaster() getWindow=null, цикл прерывается. */
    if (state.getWindow !== null) scheduleNext();
  }
}

function emitSnapshot(snapshot: SchedulerSnapshot): void {
  const win = state.getWindow?.();
  if (!win || win.isDestroyed()) return;
  win.webContents.send("resilience:scheduler-snapshot", snapshot);
}

/* ─── Test helpers ─────────────────────────────────────────────────── */

/** Сбросить state — для тестов. */
export function _resetSchedulerSnapshotBroadcasterForTests(): void {
  stopSchedulerSnapshotBroadcaster();
}

/** Прочитать текущий cached JSON snapshot — для тестов и диагностики. */
export function _getLastSnapshotJsonForTests(): string {
  return state.lastSnapshotJson;
}
