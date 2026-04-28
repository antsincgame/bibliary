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

import { runArenaCycle, type CycleReport, type CycleOptions } from "./run-cycle.js";
import { getPreferencesStore, type Preferences } from "../../preferences/store.js";
import { globalLlmLock } from "../global-llm-lock.js";

/**
 * Injectable dependencies для unit-тестов scheduler'а.
 * В production используются реальные impl.
 */
interface SchedulerDeps {
  getPrefs: () => Promise<Pick<Preferences, "arenaEnabled" | "arenaCycleIntervalMs">>;
  runCycle: (opts?: CycleOptions) => Promise<CycleReport>;
  setIntervalFn: typeof setInterval;
  clearIntervalFn: typeof clearInterval;
}

const defaultDeps: SchedulerDeps = {
  getPrefs: async () => {
    const p = await getPreferencesStore().getAll();
    return { arenaEnabled: p.arenaEnabled, arenaCycleIntervalMs: p.arenaCycleIntervalMs };
  },
  runCycle: (opts) => runArenaCycle(opts),
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

/* Re-entrancy guard. Полный cycle может занимать минуты (6 ролей × до 10
   pairs × N токенов). Если interval короче чем cycle — без этого флага
   стартанёт второй cycle поверх первого и две пары одновременно стучат
   в LM Studio. globalLlmLock тут не спасает: arena сама себя в lock не
   регистрирует (на тик cycle её probe вернул бы busy и заблокировал
   её же — это не семантика global-lock'а). Поэтому простой in-process
   flag на уровне scheduler. */
let cycleInFlight = false;

/* AbortController текущего cycle. Позволяет stopScheduler/app-quit
   корректно прервать долгий cycle вместо ожидания его естественного
   завершения. */
let cycleAbort: AbortController | null = null;

/* Unregister-функция для probe в globalLlmLock. probe возвращает busy=true
   пока cycle running — другие подсистемы (vision_queue, evaluator) знают
   что arena сейчас грузит LM Studio. Регистрируется только пока scheduler
   запущен (в startScheduler) и снимается в stopScheduler. */
let unregisterArenaProbe: (() => void) | null = null;

function logTickSkip(reasons: string[]): void {
  console.log(`[arena/scheduler] cycle skipped — LM Studio busy: ${reasons.join(", ")}`);
}

async function tick(): Promise<void> {
  /* GUARD-1: re-entrancy. Если предыдущий cycle ещё бежит — пропускаем тик. */
  if (cycleInFlight) {
    globalLlmLock.recordSkip(["arena-cycle: previous cycle still in progress"]);
    console.log("[arena/scheduler] cycle skipped — previous cycle still in progress");
    return;
  }

  /* GUARD-2: globalLlmLock — другие подсистемы (импорт, evaluator).
     runArenaCycle сам проверит lock внутри (через guard), но мы здесь
     дублируем чтобы не делать дорогой ipcMain → preferences read впустую
     и не лезть к loaded models через listLoaded если LM Studio занят. */
  const lock = globalLlmLock.isBusy();
  if (lock.busy) {
    globalLlmLock.recordSkip(lock.reasons);
    logTickSkip(lock.reasons);
    return;
  }

  cycleInFlight = true;
  cycleAbort = new AbortController();
  try {
    const report = await _deps.runCycle({ signal: cycleAbort.signal });
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
  } finally {
    cycleInFlight = false;
    cycleAbort = null;
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
  /* Регистрируем probe чтобы другие подсистемы (vision_queue, evaluator,
     импорт) видели arena как busy на время cycle и могли уважительно
     уступать. Probe возвращает busy только когда cycleInFlight=true. */
  unregisterArenaProbe = globalLlmLock.registerProbe("arena-cycle", () => ({
    busy: cycleInFlight,
    reason: cycleInFlight ? "cycle in progress" : undefined,
  }));
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
  /* Сигналим текущему cycle что пора прерываться. Cycle сам поймает
     signal.aborted в loop по pairs (см. run-cycle.ts) и завершится.
     Без этого app-quit ждал бы естественного завершения cycle (минуты). */
  if (cycleAbort) {
    try {
      cycleAbort.abort();
    } catch {
      /* AbortController.abort() не может бросить в норме, но защита
         от полифиллов / extension hooks не вредит. */
    }
  }
  if (unregisterArenaProbe) {
    unregisterArenaProbe();
    unregisterArenaProbe = null;
  }
}

export function isSchedulerRunning(): boolean {
  return timer !== null;
}
