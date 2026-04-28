/**
 * Arena scheduler — background timer for arena cycle ticks.
 */

import { runArenaCycle, type CycleReport, type CycleOptions } from "./run-cycle.js";
import { getPreferencesStore, type Preferences } from "../../preferences/store.js";
import { globalLlmLock } from "../global-llm-lock.js";

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
let cycleInFlight = false;
let cycleAbort: AbortController | null = null;
let unregisterArenaProbe: (() => void) | null = null;

async function tick(): Promise<void> {
  if (cycleInFlight) {
    globalLlmLock.recordSkip(["arena-cycle: previous cycle still in progress"]);
    return;
  }

  const lock = globalLlmLock.isBusy();
  if (lock.busy) {
    globalLlmLock.recordSkip(lock.reasons);
    console.log(`[arena/scheduler] cycle skipped — LM Studio busy: ${lock.reasons.join(", ")}`);
    return;
  }

  cycleInFlight = true;
  cycleAbort = new AbortController();
  try {
    const report = await _deps.runCycle({ signal: cycleAbort.signal });
    if (!report.ok && !report.skipped) {
      console.warn(`[arena/scheduler] cycle failed: ${report.message}`);
    } else if (report.ok) {
      console.log(`[arena/scheduler] ${report.message}`);
    }
  } catch (e) {
    console.error("[arena/scheduler] cycle threw:", e instanceof Error ? e.message : String(e));
  } finally {
    cycleInFlight = false;
    cycleAbort = null;
  }
}

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
  timer = _deps.setIntervalFn(() => { void tick(); }, intervalMs);
  if (typeof timer === "object" && timer !== null && typeof (timer as NodeJS.Timeout).unref === "function") {
    (timer as NodeJS.Timeout).unref();
  }
  unregisterArenaProbe = globalLlmLock.registerProbe("arena-cycle", () => ({
    busy: cycleInFlight,
    reason: cycleInFlight ? "cycle in progress" : undefined,
  }));
  console.log(`[arena/scheduler] started, interval=${intervalMs}ms`);
}

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
  if (cycleAbort) {
    try { cycleAbort.abort(); } catch { /* safe */ }
  }
  if (unregisterArenaProbe) {
    unregisterArenaProbe();
    unregisterArenaProbe = null;
  }
}

export function isSchedulerRunning(): boolean {
  return timer !== null;
}
