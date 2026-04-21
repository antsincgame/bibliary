import type { BrowserWindow } from "electron";
import { coordinator } from "./batch-coordinator";
import * as telemetry from "./telemetry";
import {
  HEALTH_FAIL_THRESHOLD,
  HEALTH_POLL_INTERVAL_MS,
} from "./constants";

const HTTP_URL = process.env.LM_STUDIO_URL || "http://localhost:1234";
/** Default fetch timeout for the liveness probe -- overridable via prefs. */
const DEFAULT_LIVENESS_TIMEOUT_MS = 3_000;

let pollTimer: NodeJS.Timeout | null = null;
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
 * Update the runtime watchdog configuration. Safe to call from preferences
 * IPC after a `set` -- next activate() reads the new values. If a poll is
 * already in flight it keeps the old interval until next deactivate/activate
 * cycle (caller responsibility if instant change matters).
 */
export function configureWatchdog(partial: Partial<WatchdogConfig>): void {
  activeConfig = { ...activeConfig, ...partial };
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
  if (pollTimer) return;
  consecutiveFailures = 0;
  lastState = "online";
  pollTimer = setInterval(() => {
    void poll();
  }, activeConfig.pollIntervalMs);
}

function deactivate(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function poll(): Promise<void> {
  const ok = await checkLiveness();
  if (ok) {
    if (lastState === "offline") {
      lastState = "online";
      consecutiveFailures = 0;
      telemetry.logEvent({ type: "lmstudio.online" });
      emit("resilience:lmstudio-online", null);
      void coordinator.resumeAll().catch(() => undefined);
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
    void coordinator.pauseAll("lmstudio-offline").catch(() => undefined);
  }
}

async function checkLiveness(): Promise<boolean> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), activeConfig.livenessTimeoutMs);
  try {
    const response = await fetch(`${HTTP_URL}/v1/models`, { signal: ctl.signal });
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
