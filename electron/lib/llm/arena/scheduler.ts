/**
 * Arena scheduler — фоновый таймер запуска arena cycle.
 *
 * КОНТРАКТЫ:
 *   - Только один таймер на app (singleton). startScheduler() идемпотентна:
 *     повторный вызов с теми же параметрами — no-op; с другим интервалом —
 *     рестарт с новым.
 *   - Перед каждым тиком проверяет globalLlmLock.isBusy() — если занят,
 *     тик пропускается (защита от OOM при массовом импорте/evaluator queue).
 *   - При arenaEnabled=false таймер не стартует.
 *   - stopScheduler() корректно очищает таймер и должен вызываться в
 *     before-quit pipeline.
 *
 * РЕАКТИВНОСТЬ К ИЗМЕНЕНИЮ ПРЕДПОЧТЕНИЙ:
 *   restartScheduler() вызывается из preferences.ipc.ts когда юзер меняет
 *   arenaEnabled / arenaCycleIntervalMs из UI. Без этого изменения вступали
 *   бы в силу только после рестарта приложения.
 */

import { runArenaCycle, type CycleReport } from "./run-cycle.js";
import { getPreferencesStore, type Preferences } from "../../preferences/store.js";
import { globalLlmLock } from "../global-llm-lock.js";

/**
 * Injectable dependencies для unit-тестов scheduler'а.
 * В production используются реальные impl.
 */
interface SchedulerDeps {
  getPrefs: () => Promise<Pick<Preferences, "arenaEnabled" | "arenaCycleIntervalMs">>;
  runCycle: () => Promise<CycleReport>;
  setIntervalFn: typeof setInterval;
  clearIntervalFn: typeof clearInterval;
}

const defaultDeps: SchedulerDeps = {
  getPrefs: async () => {
    const p = await getPreferencesStore().getAll();
    return { arenaEnabled: p.arenaEnabled, arenaCycleIntervalMs: p.arenaCycleIntervalMs };
  },
  runCycle: runArenaCycle,
  setIntervalFn: setInterval,
  clearIntervalFn: clearInterval,
};

let _deps: SchedulerDeps = defaultDeps;

export function _setSchedulerDepsForTests(overrides: Partial<SchedulerDeps>): void {
  _deps = { ...defaultDeps, ...overrides };
}

export function _resetSchedulerForTests(): void {
  _deps = defaultDeps;
}

let timer: NodeJS.Timeout | null = null;
let currentIntervalMs = 0;

function logTickSkip(reasons: string[]): void {
  console.log(`[arena/scheduler] cycle skipped — LM Studio busy: ${reasons.join(", ")}`);
}

async function tick(): Promise<void> {
  /* runArenaCycle сам проверит lock внутри (через guard), но мы здесь дублируем
     проверку чтобы не делать дорогой ipcMain → preferences read впустую и не
     лезть к loaded models через listLoaded если LM Studio занят. */
  const lock = globalLlmLock.isBusy();
  if (lock.busy) {
    globalLlmLock.recordSkip(lock.reasons);
    logTickSkip(lock.reasons);
    return;
  }
  try {
    const report = await _deps.runCycle();
    if (report.skipped) {
      /* Гонка: между нашей проверкой и runArenaCycle что-то стартовало.
         runArenaCycle уже записал skip — просто логируем. */
      logTickSkip(report.skipReasons ?? ["unknown"]);
    } else if (!report.ok) {
      console.warn(`[arena/scheduler] cycle failed: ${report.message}`);
    } else {
      console.log(`[arena/scheduler] ${report.message}`);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[arena/scheduler] cycle threw:", msg);
  }
}

/**
 * Запустить scheduler. Если arena disabled или таймер уже идёт с тем же
 * интервалом — no-op.
 */
export async function startScheduler(): Promise<void> {
  let prefs;
  try {
    prefs = await _deps.getPrefs();
  } catch (e) {
    console.warn("[arena/scheduler] cannot read preferences, scheduler not started:", e);
    return;
  }
  if (!prefs.arenaEnabled) {
    if (timer) stopScheduler();
    return;
  }
  const intervalMs = prefs.arenaCycleIntervalMs;
  if (timer && currentIntervalMs === intervalMs) return;
  if (timer) stopScheduler();
  currentIntervalMs = intervalMs;
  timer = _deps.setIntervalFn(() => {
    void tick();
  }, intervalMs);
  /* unref чтобы таймер не держал event loop живым при app-quit. */
  if (typeof timer === "object" && timer !== null && typeof (timer as NodeJS.Timeout).unref === "function") {
    (timer as NodeJS.Timeout).unref();
  }
  console.log(`[arena/scheduler] started, interval=${intervalMs}ms`);
}

/**
 * Перезапустить scheduler с актуальными prefs. Вызывается когда юзер
 * меняет arenaEnabled / arenaCycleIntervalMs.
 */
export async function restartScheduler(): Promise<void> {
  stopScheduler();
  await startScheduler();
}

export function stopScheduler(): void {
  if (timer) {
    _deps.clearIntervalFn(timer as ReturnType<typeof setInterval>);
    timer = null;
    currentIntervalMs = 0;
    console.log("[arena/scheduler] stopped");
  }
}

export function isSchedulerRunning(): boolean {
  return timer !== null;
}
