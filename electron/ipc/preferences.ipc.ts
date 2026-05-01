import { promises as fs } from "fs";
import { BrowserWindow, dialog, ipcMain } from "electron";
import { getPreferencesStore, DEFAULTS, type Preferences } from "../lib/preferences/store.js";
import { configureWatchdog } from "../lib/resilience/lmstudio-watchdog.js";
import { configureFileLockDefaults } from "../lib/resilience/index.js";
import { invalidateEndpointsCache, getEndpoints } from "../lib/endpoints/index.js";
import { setQdrantUrl } from "../lib/qdrant/http-client.js";
import { refreshLmStudioClient } from "../lmstudio-client.js";
import { syncMarkerEnvFromPrefs } from "../lib/library/marker-sidecar.js";
import { modelRoleResolver } from "../lib/llm/model-role-resolver.js";
import { applyImportSchedulerPrefs } from "../lib/library/import-task-scheduler.js";
import { applyEvaluatorPrefs } from "../lib/library/evaluator-queue.js";
import { applyHeavyLaneRateLimiterPrefs } from "../lib/llm/heavy-lane-rate-limiter.js";
import { applyCalibrePathPrefs } from "../lib/scanner/converters/calibre-cli.js";

/**
 * Whitelist полей, входящих в «профиль моделей» (export/import).
 *
 * Что входит: только модели по ролям + цепочки fallback'ов + связанный
 * флажок translatorTargetLang (нужен для корректной интерпретации translator-роли).
 * Что НЕ входит: URL'ы (lmStudioUrl/qdrantUrl), RAG-параметры, OCR, watchdog —
 * это «среда», а не «профиль ролей». Импорт профиля не должен ломать
 * подключение к LM Studio или менять размер chunk'ов.
 */
const PROFILE_KEYS = [
  "extractorModel", "extractorModelFallbacks",
  "evaluatorModel", "evaluatorModelFallbacks",
  "translatorModel", "translatorModelFallbacks", "translatorTargetLang",
  "ukrainianSpecialistModel", "ukrainianSpecialistModelFallbacks",
  "langDetectorModel", "langDetectorModelFallbacks",
  "visionModelKey", "visionModelFallbacks",
] as const satisfies readonly (keyof Preferences)[];

/** Тип профиля: только whitelisted ключи. */
type ProfileSnapshot = Pick<Preferences, typeof PROFILE_KEYS[number]>;

interface ProfileFile {
  schema: "bibliary.profile/v1";
  exportedAt: string;
  app: { name: string; version?: string };
  profile: Partial<ProfileSnapshot>;
}

function pickProfile(prefs: Preferences): Partial<ProfileSnapshot> {
  const out: Partial<Record<string, unknown>> = {};
  for (const k of PROFILE_KEYS) {
    const v = prefs[k];
    if (v !== undefined && v !== "") out[k] = v;
  }
  return out as Partial<ProfileSnapshot>;
}

function sanitizeImportedProfile(raw: unknown): Partial<ProfileSnapshot> {
  if (!raw || typeof raw !== "object") return {};
  const obj = raw as Record<string, unknown>;
  /* Поддерживаем оба варианта: {profile: {...}} и плоский {extractorModel: ...}. */
  const src: Record<string, unknown> = (obj.profile && typeof obj.profile === "object")
    ? (obj.profile as Record<string, unknown>)
    : obj;
  const out: Record<string, unknown> = {};
  for (const k of PROFILE_KEYS) {
    const v = src[k];
    if (typeof v === "string") out[k] = v;
  }
  return out as Partial<ProfileSnapshot>;
}

/**
 * Apply preference values that affect already-running services. The
 * preferences file write happens earlier (atomic + locked); this only
 * pushes the new numbers into in-memory configuration of long-lived
 * runtime modules (watchdog timing, file-lock defaults, endpoint cache, ...).
 *
 * Exported (Иt 8Б): main.ts вызывает после initPreferencesStore чтобы
 * Settings-driven singletons получили актуальные лимиты на старте, а не
 * ждали первого `preferences:set`.
 */
export function applyRuntimeSideEffects(prefs: Preferences): void {
  configureWatchdog({
    pollIntervalMs: prefs.healthPollIntervalMs,
    failThreshold: prefs.healthFailThreshold,
    livenessTimeoutMs: prefs.watchdogLivenessTimeoutMs,
  });
  configureFileLockDefaults({
    retries: prefs.lockRetries,
    stale: prefs.lockStaleMs,
  });
  /* URL changes: invalidate the endpoint cache, then refresh the live
     binding in qdrant/http-client and drop the cached LM Studio SDK
     client so the next call rebuilds against the new URL. */
  invalidateEndpointsCache();
  void getEndpoints().then(({ qdrantUrl }) => setQdrantUrl(qdrantUrl));
  refreshLmStudioClient();
  /* Sync Marker feature flag to ENV so marker-sidecar.ts can read it
     synchronously without an async preferences store dependency. */
  syncMarkerEnvFromPrefs(prefs.useMarkerExtractor);
  /* Role resolver caches resolved models for `modelRoleCacheTtlMs` —
     invalidate now so changes to model keys and fallbacks are visible on next IPC call. */
  modelRoleResolver.invalidate();
  /* Иt 8Б — Smart Import Pipeline: Settings = single source of truth.
     applyRuntimeSideEffects распространяет изменения на живые singletons.
     parserPoolSize / illustrationParallelism / converterCacheMaxBytes /
     preferDjvuOverPdf читаются из prefs lazy по месту использования
     (не нужен push). calibrePathOverride — особый случай: он кеширует
     результат resolveCalibreBinary(), смена override без invalidate
     останется незамеченной — поэтому отдельный push (Иt 8В.CRITICAL.4). */
  applyImportSchedulerPrefs({
    schedulerLightConcurrency: prefs.schedulerLightConcurrency,
    schedulerMediumConcurrency: prefs.schedulerMediumConcurrency,
    schedulerHeavyConcurrency: prefs.schedulerHeavyConcurrency,
  });
  applyEvaluatorPrefs({ evaluatorSlots: prefs.evaluatorSlots });
  applyHeavyLaneRateLimiterPrefs({ visionOcrRpm: prefs.visionOcrRpm });
  applyCalibrePathPrefs({ calibrePathOverride: prefs.calibrePathOverride });
}

export function registerPreferencesIpc(): void {
  function broadcastChanged(prefs: Preferences): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send("preferences:changed", prefs);
      }
    }
  }

  ipcMain.handle("preferences:get-all", async (): Promise<Preferences> => {
    return getPreferencesStore().getAll();
  });

  ipcMain.handle("preferences:get-defaults", (): Preferences => {
    return DEFAULTS;
  });

  ipcMain.handle("preferences:set", async (_e, partial: Partial<Preferences>): Promise<Preferences> => {
    if (!partial || typeof partial !== "object") throw new Error("Invalid preferences payload");
    const next = await getPreferencesStore().set(partial);
    applyRuntimeSideEffects(next);
    broadcastChanged(next);
    return next;
  });

  ipcMain.handle("preferences:reset", async (): Promise<Preferences> => {
    const next = await getPreferencesStore().reset();
    applyRuntimeSideEffects(next);
    broadcastChanged(next);
    return next;
  });

  /**
   * Получить профиль (whitelisted ключи) как готовый JSON-объект для скачивания
   * на стороне renderer'а (через blob). Renderer-only путь, без файлового диалога.
   */
  ipcMain.handle("preferences:get-profile", async (): Promise<ProfileFile> => {
    const all = await getPreferencesStore().getAll();
    return {
      schema: "bibliary.profile/v1",
      exportedAt: new Date().toISOString(),
      app: { name: "Bibliary" },
      profile: pickProfile(all),
    };
  });

  /**
   * Экспорт профиля через нативный Electron-диалог. Возвращает путь к файлу
   * или null, если пользователь нажал «Отмена».
   */
  ipcMain.handle("preferences:export-profile", async (e): Promise<{ path: string | null }> => {
    const all = await getPreferencesStore().getAll();
    const file: ProfileFile = {
      schema: "bibliary.profile/v1",
      exportedAt: new Date().toISOString(),
      app: { name: "Bibliary" },
      profile: pickProfile(all),
    };
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined;
    const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
    const opts = {
      title: "Экспорт профиля моделей",
      defaultPath: `bibliary-profile-${stamp}.json`,
      filters: [{ name: "Bibliary profile", extensions: ["json"] }],
    };
    const res = win
      ? await dialog.showSaveDialog(win, opts)
      : await dialog.showSaveDialog(opts);
    if (res.canceled || !res.filePath) return { path: null };
    await fs.writeFile(res.filePath, JSON.stringify(file, null, 2), "utf8");
    return { path: res.filePath };
  });

  /**
   * Импорт профиля через нативный диалог. Читает JSON, валидирует whitelist
   * и применяет через store.set. Возвращает: путь файла, количество применённых ключей,
   * актуальные prefs.
   */
  ipcMain.handle("preferences:import-profile", async (e): Promise<{
    path: string | null;
    appliedKeys: string[];
    prefs: Preferences;
  }> => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined;
    const opts = {
      title: "Импорт профиля моделей",
      properties: ["openFile" as const],
      filters: [{ name: "Bibliary profile", extensions: ["json"] }],
    };
    const res = win
      ? await dialog.showOpenDialog(win, opts)
      : await dialog.showOpenDialog(opts);
    if (res.canceled || !res.filePaths[0]) {
      return { path: null, appliedKeys: [], prefs: await getPreferencesStore().getAll() };
    }
    const filePath = res.filePaths[0];
    let parsed: unknown;
    try {
      const raw = await fs.readFile(filePath, "utf8");
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`Не удалось прочитать файл профиля: ${err instanceof Error ? err.message : String(err)}`);
    }
    const sanitized = sanitizeImportedProfile(parsed);
    const appliedKeys = Object.keys(sanitized);
    if (appliedKeys.length === 0) {
      throw new Error("Файл не содержит валидных полей профиля (ожидались модели по ролям).");
    }
    const next = await getPreferencesStore().set(sanitized);
    applyRuntimeSideEffects(next);
    broadcastChanged(next);
    return { path: filePath, appliedKeys, prefs: next };
  });

  /**
   * Применить профиль из объекта (без диалога). Используется для:
   *   - быстрого экспорта-импорта внутри renderer (drag & drop / paste)
   *   - undo после ошибочного импорта.
   */
  ipcMain.handle("preferences:apply-profile", async (_e, payload: unknown): Promise<{
    appliedKeys: string[];
    prefs: Preferences;
  }> => {
    const sanitized = sanitizeImportedProfile(payload);
    const appliedKeys = Object.keys(sanitized);
    if (appliedKeys.length === 0) {
      throw new Error("Профиль не содержит валидных полей.");
    }
    const next = await getPreferencesStore().set(sanitized);
    applyRuntimeSideEffects(next);
    broadcastChanged(next);
    return { appliedKeys, prefs: next };
  });
}
