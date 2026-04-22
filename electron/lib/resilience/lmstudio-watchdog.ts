import type { BrowserWindow } from "electron";
import { coordinator } from "./batch-coordinator";
import * as telemetry from "./telemetry";
import {
  HEALTH_FAIL_THRESHOLD,
  HEALTH_POLL_INTERVAL_MS,
} from "./constants";
import { getLmStudioUrl } from "../endpoints/index.js";

/** Default fetch timeout for the liveness probe -- overridable via prefs. */
const DEFAULT_LIVENESS_TIMEOUT_MS = 3_000;

let pollTimer: NodeJS.Timeout | null = null;
let isActive = false;
let consecutiveFailures = 0;
let lastState: "online" | "offline" = "online";
let unsubStart: (() => void) | null = null;
let unsubEnd: (() => void) | null = null;
let getMainWindow: (() => BrowserWindow | null) | null = null;

interface WatchdogConfig {
  pollIntervalMs: number;
  failThreshold: number;
  livenessTimeoutMs: number;
}

let activeConfig: WatchdogConfig = {
  pollIntervalMs: HEALTH_POLL_INTERVAL_MS,
  failThreshold: HEALTH_FAIL_THRESHOLD,
  livenessTimeoutMs: DEFAULT_LIVENESS_TIMEOUT_MS,
};

/**
 * Update the runtime watchdog configuration. Безопасно вызывать из
 * preferences IPC после `set`. Если меняется `pollIntervalMs` и watchdog
 * сейчас активен с уже стоящим таймером (т.е. не во время полинга) —
 * таймер немедленно перепланируется с новым интервалом. Если poll сейчас
 * в полёте, новый интервал будет применён к следующему расписанию (его
 * читают из `activeConfig` после завершения poll).
 */
export function configureWatchdog(partial: Partial<WatchdogConfig>): void {
  const prevIntervalMs = activeConfig.pollIntervalMs;
  activeConfig = { ...activeConfig, ...partial };
  const intervalChanged =
    typeof partial.pollIntervalMs === "number" &&
    partial.pollIntervalMs !== prevIntervalMs;
  if (isActive && pollTimer !== null && intervalChanged) {
    clearTimeout(pollTimer);
    pollTimer = null;
    scheduleNextPoll(activeConfig.pollIntervalMs);
  }
}

export function startWatchdog(windowGetter: () => BrowserWindow | null): void {
  if (unsubStart || unsubEnd) return;
  getMainWindow = windowGetter;
  unsubStart = coordinator.onBatchStart(() => activate());
  unsubEnd = coordinator.onBatchEnd(() => {
    if (!coordinator.isAnyActive()) deactivate();
  });
}

export function stopWatchdog(): void {
  deactivate();
  if (unsubStart) {
    unsubStart();
    unsubStart = null;
  }
  if (unsubEnd) {
    unsubEnd();
    unsubEnd = null;
  }
  getMainWindow = null;
}

function activate(): void {
  if (isActive) return;
  isActive = true;
  consecutiveFailures = 0;
  lastState = "online";
  scheduleNextPoll(activeConfig.pollIntervalMs);
}

function deactivate(): void {
  isActive = false;
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

/**
 * Планирует следующий запуск poll-цикла через recursive setTimeout.
 * Гарантии: (1) полинги не накладываются — следующий стартует только после
 * завершения предыдущего; (2) cadence сохраняется когда poll быстрый
 * (next = interval - elapsed), но не уходит в минус если poll медленный;
 * (3) изменения `activeConfig.pollIntervalMs` подхватываются на следующем
 * scheduling без рестарта watchdog.
 */
function scheduleNextPoll(delayMs: number): void {
  if (!isActive) return;
  pollTimer = setTimeout(() => {
    pollTimer = null;
    void runPollCycle();
  }, Math.max(0, delayMs));
}

async function runPollCycle(): Promise<void> {
  if (!isActive) return;
  const startedAt = Date.now();
  try {
    await poll();
  } catch (err) {
    console.error("[watchdog] poll cycle failed:", err instanceof Error ? err.message : err);
  }
  if (!isActive) return;
  const elapsed = Date.now() - startedAt;
  const wait = activeConfig.pollIntervalMs - elapsed;
  scheduleNextPoll(wait);
}

async function poll(): Promise<void> {
  const ok = await checkLiveness();
  if (ok) {
    if (lastState === "offline") {
      lastState = "online";
      consecutiveFailures = 0;
      telemetry.logEvent({ type: "lmstudio.online" });
      emit("resilience:lmstudio-online", null);
      void coordinator.resumeAll().catch((err) => {
        console.error("[watchdog] resumeAll failed:", err instanceof Error ? err.message : err);
      });
    } else {
      consecutiveFailures = 0;
    }
    return;
  }

  consecutiveFailures += 1;
  if (consecutiveFailures >= activeConfig.failThreshold && lastState === "online") {
    lastState = "offline";
    telemetry.logEvent({ type: "lmstudio.offline", consecutiveFailures });
    emit("resilience:lmstudio-offline", { consecutiveFailures });
    void coordinator.pauseAll("lmstudio-offline").catch((err) => {
      console.error("[watchdog] pauseAll failed:", err instanceof Error ? err.message : err);
    });
  }
}

async function checkLiveness(): Promise<boolean> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), activeConfig.livenessTimeoutMs);
  try {
    const baseUrl = await getLmStudioUrl();
    const response = await fetch(`${baseUrl}/v1/models`, { signal: ctl.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function emit(channel: string, payload: unknown): void {
  const win = getMainWindow?.();
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, payload);
  }
}
