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

/**
 * Сколько циклов основного poll'а пропустить перед запуском дополнительного
 * VRAM pressure poll. При HEALTH_POLL_INTERVAL_MS=10000 это даёт VRAM check
 * раз в минуту — достаточно для выявления memory leak / накопления моделей,
 * но не нагружает LM Studio лишними запросами listLoaded/listDownloaded.
 */
const PRESSURE_POLL_EVERY_N = 6;

/**
 * Порог pressureRatio (totalLoadedMB / capacityMB), при превышении которого
 * watchdog эмитит resilience:lmstudio-pressure событие через webContents.send.
 *
 * NB: на момент v0.6.0 (Foundation Complete) у события два consumer-канала:
 *   1. Renderer: подписка через preload `api.resilience.onLmstudioPressure`
 *      → виджет `pipeline-status-widget.js` (готов к монтированию, см. Iter 6).
 *   2. Pool: НЕ слушает pressure event напрямую — для деградации heavy lane
 *      используется внутренний `loadWithOomRecovery` в model-pool.ts (Iter 1).
 * Полная интеграция «Pool читает pressure → отказывает heavy при ratio>0.85» —
 * запланирована в Iter 6+ при подключении Calibre converters в scheduler.
 */
const PRESSURE_THRESHOLD = 0.85;

let pollTimer: NodeJS.Timeout | null = null;
let isActive = false;
let consecutiveFailures = 0;
let lastState: "online" | "offline" = "online";
let pollCycleCounter = 0;
let lastPressureRatio = 0;
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

export interface VramPressureSnapshot {
  totalLoadedMB: number;
  capacityMB: number;
  pressureRatio: number;
  loadedModels: number;
}

/** Текущий snapshot VRAM pressure — для UI/диагностики. */
export function getLastPressureRatio(): number {
  return lastPressureRatio;
}

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
  pollCycleCounter = 0;
  lastPressureRatio = 0;
  scheduleNextPoll(activeConfig.pollIntervalMs);
}

function deactivate(): void {
  isActive = false;
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  /* Сбрасываем pressure-ratio чтобы UI/диагностика не показывали stale данные
     прошлой сессии после deactivate. Симметрично с activate(). */
  lastPressureRatio = 0;
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
  pollTimer.unref();
}

async function runPollCycle(): Promise<void> {
  if (!isActive) return;
  const startedAt = Date.now();
  try {
    await poll();
  } catch (err) {
    console.error("[watchdog] poll cycle failed:", err instanceof Error ? err.message : err);
  }
  /* Secondary poll — VRAM pressure. Запускается раз в N основных циклов,
     не блокирует liveness check (выполняется ПОСЛЕ него). */
  pollCycleCounter += 1;
  if (pollCycleCounter % PRESSURE_POLL_EVERY_N === 0 && lastState === "online") {
    try {
      await pollVramPressure();
    } catch (err) {
      console.warn("[watchdog] pressure poll failed:", err instanceof Error ? err.message : err);
    }
  }
  if (!isActive) return;
  const elapsed = Date.now() - startedAt;
  const wait = activeConfig.pollIntervalMs - elapsed;
  scheduleNextPoll(wait);
}

/**
 * VRAM pressure poll: считает totalLoadedMB всех загруженных в LM Studio
 * моделей и сравнивает с pool.capacityMB. Эмитит `resilience:lmstudio-pressure`
 * event при ratio > PRESSURE_THRESHOLD через `webContents.send`.
 *
 * НЕ дёргает loadModel/unloadModel — только read-only listLoaded +
 * listDownloaded. Безопасно во время импорта.
 *
 * NB: На момент Итерации 4 у события НЕТ active subscriber'а в renderer / pool.
 * Pressure ratio доступен через `getLastPressureRatio()` для будущей UI-телеметрии
 * (Итерация 5: scheduler-ui-telemetry). Само событие — задел для подписки.
 */
async function pollVramPressure(): Promise<void> {
  /* Lazy import чтобы избежать circular dependency watchdog ↔ model-pool.
     Watchdog работает и без model-pool (pure liveness), pressure poll —
     дополнительный feature, который опирается на pool stats. */
  const [{ getModelPool }, { listLoaded, listDownloaded }] = await Promise.all([
    import("../llm/model-pool.js"),
    import("../../lmstudio-client.js"),
  ]);

  const pool = getModelPool();
  const stats = pool.getStats();
  const capacityMB = stats.capacityMB;
  if (!capacityMB || capacityMB <= 0) return;

  let loaded;
  let downloaded;
  try {
    [loaded, downloaded] = await Promise.all([listLoaded(), listDownloaded()]);
  } catch (err) {
    /* LM Studio недоступен — silently skip, основной liveness check уже
       сообщил offline status. */
    void err;
    return;
  }

  let totalLoadedMB = 0;
  for (const m of loaded) {
    const dl = downloaded.find((d) => d.modelKey === m.modelKey);
    if (dl?.sizeBytes) {
      totalLoadedMB += Math.round((dl.sizeBytes * 1.3) / 1024 / 1024);
    } else {
      /* Fallback — pool.estimateVramMBForModel логика, но без импорта функции
         используем pool entries (если модель уже в pool — её vramMB корректен). */
      const entry = stats.models.find((e) => e.modelKey === m.modelKey);
      totalLoadedMB += entry?.vramMB ?? 4096;
    }
  }

  const pressureRatio = totalLoadedMB / capacityMB;
  lastPressureRatio = pressureRatio;

  if (pressureRatio > PRESSURE_THRESHOLD) {
    const snapshot: VramPressureSnapshot = {
      totalLoadedMB,
      capacityMB,
      pressureRatio,
      loadedModels: loaded.length,
    };
    emit("resilience:lmstudio-pressure", snapshot);
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
