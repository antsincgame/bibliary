/**
 * Olympics IPC — model calibration tournament for local LM Studio models.
 *
 * Историческая заметка: модуль раньше назывался Arena (Shadow Arena с Elo-рейтингом),
 * но в Apr 2026 Shadow Arena была удалена в пользу Олимпиады (детерминированной,
 * управляемой пользователем, с явным lifecycle для безопасности RAM/VRAM).
 *
 * IPC-каналы оставлены с префиксом `arena:*` для backward-compat с preload.ts —
 * переименование channel'ов даёт нулевой выигрыш, но ломает рендерер. Имя файла
 * можно переименовать в olympics.ipc.ts, если в проекте больше нигде не нужен `arena:`.
 */

import { BrowserWindow, ipcMain } from "electron";
import { getPreferencesStore, type Preferences } from "../lib/preferences/store.js";
import { globalLlmLock } from "../lib/llm/global-llm-lock.js";
import { modelRoleResolver } from "../lib/llm/model-role-resolver.js";
import { runOlympics, type OlympicsReport, type OlympicsRole } from "../lib/llm/arena/olympics.js";
import { refreshLmStudioClient, listLoaded, loadModel } from "../lmstudio-client.js";

export function registerArenaIpc(): void {
  function broadcastPreferencesChanged(prefs: Preferences): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send("preferences:changed", prefs);
      }
    }
  }

  /* Lock-status — нужен Олимпиаде для UI индикатора «LM Studio занята». */
  ipcMain.handle("arena:get-lock-status", async () => {
    return globalLlmLock.getStatus();
  });

  /* ─── Олимпиада: реальный турнир локальных моделей через LM Studio ─── */

  let activeOlympicsCtrl: AbortController | null = null;

  ipcMain.handle("arena:run-olympics", async (e, payload: unknown): Promise<OlympicsReport> => {
    if (activeOlympicsCtrl) {
      throw new Error("Олимпиада уже идёт. Подожди или нажми «Отмена».");
    }
    const lock = globalLlmLock.isBusy();
    if (lock.busy) {
      globalLlmLock.recordSkip(lock.reasons);
      throw new Error(`LM Studio сейчас занята: ${lock.reasons.join("; ")}. Останови импорт/оценку и запусти Олимпиаду снова.`);
    }
    const args = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
    const ctrl = new AbortController();
    activeOlympicsCtrl = ctrl;
    const unregisterOlympicsProbe = globalLlmLock.registerProbe("olympics", () => ({
      busy: true,
      reason: "Olympics model calibration is running",
    }));

    const win = BrowserWindow.fromWebContents(e.sender);
    const send = (channel: string, data: unknown): void => {
      if (win && !win.isDestroyed()) win.webContents.send(channel, data);
    };

    /* Read prefs once for per-role tuning toggle. */
    const prefs = await getPreferencesStore().getAll();
    /* Lightning preset (см. docs/lightning-olympics.md): один тумблер в UI
     * перекрывает несколько частных настроек на лету. Это «macro-pref»:
     *   weightClasses → ["s"]   (только мелкие модели)
     *   testAll       → false   (не пробежать всё)
     *   maxModels     → 5       (top-K фильтр)
     *   timeout       → 30s     (вместо 90s — Lightning не для медленного reasoning)
     * Если Lightning выключен — работают индивидуальные prefs/args. */
    const lightning = prefs.olympicsLightning === true;
    const requestedWeightClasses = Array.isArray(args.weightClasses)
      ? (args.weightClasses as Array<"xs"|"s"|"m"|"l"|"xl"|"unknown">)
      : undefined;
    const finalWeightClasses = lightning ? (["s"] as const) : requestedWeightClasses;
    const finalTestAll = lightning ? false : (args.testAll === true);
    const finalMaxModels = lightning
      ? 5
      : (typeof args.maxModels === "number" ? args.maxModels : undefined);
    const finalTimeout = lightning ? 30_000 : undefined;
    try {
      const report = await runOlympics({
        models: Array.isArray(args.models) ? (args.models as string[]) : undefined,
        disciplines: Array.isArray(args.disciplines) ? (args.disciplines as string[]) : undefined,
        maxModels: finalMaxModels,
        weightClasses: finalWeightClasses as Array<"xs"|"s"|"m"|"l"|"xl"|"unknown"> | undefined,
        testAll: finalTestAll,
        perDisciplineTimeoutMs: finalTimeout,
        roles: Array.isArray(args.roles) ? (args.roles as OlympicsRole[]) : undefined,
        roleLoadConfigEnabled: prefs.olympicsRoleLoadConfigEnabled === true,
        useLmsSDK: prefs.olympicsUseLmsSDK === true,
        signal: ctrl.signal,
        onProgress: (ev) => send("arena:olympics-progress", ev),
      });
      if (ctrl.signal.aborted) {
        throw new Error("Olympics aborted by user");
      }
      return report;
    } finally {
      unregisterOlympicsProbe();
      activeOlympicsCtrl = null;
    }
  });

  ipcMain.handle("arena:cancel-olympics", async (): Promise<boolean> => {
    if (!activeOlympicsCtrl) return false;
    activeOlympicsCtrl.abort();
    return true;
  });

  ipcMain.handle("arena:clear-olympics-cache", async () => {
    const { clearOlympicsCache } = await import("../lib/llm/arena/olympics.js");
    clearOlympicsCache();
    return { ok: true };
  });

  ipcMain.handle("arena:apply-olympics-recommendations", async (_e, payload: unknown): Promise<Preferences> => {
    if (!payload || typeof payload !== "object") {
      throw new Error("apply-olympics-recommendations: ожидается объект {recommendations}");
    }
    const recs = (payload as { recommendations?: Record<string, string> }).recommendations;
    if (!recs || typeof recs !== "object") throw new Error("recommendations отсутствуют");

    /* Whitelist: только эти ключи разрешено применять. */
    const ALLOWED = new Set([
      "extractorModel", "judgeModel", "evaluatorModel", "translatorModel",
      "visionModelKey",
      "langDetectorModel", "ukrainianSpecialistModel",
    ]);
    const filtered: Partial<Preferences> = {};
    for (const [k, v] of Object.entries(recs)) {
      if (ALLOWED.has(k) && typeof v === "string" && v.trim().length > 0) {
        (filtered as Record<string, unknown>)[k] = v;
      }
    }
    if (Object.keys(filtered).length === 0) {
      throw new Error("Нет валидных рекомендаций для применения");
    }
    await getPreferencesStore().set(filtered);
    modelRoleResolver.invalidate();
    refreshLmStudioClient();
    const prefs = await getPreferencesStore().getAll();
    broadcastPreferencesChanged(prefs);

    /* ── Auto-load recommended models into LM Studio ──
     * Olympics только записывает prefs, но если модели не загружены — весь
     * production pipeline (vision, evaluator, crystallizer) видит null при
     * resolveModelForRole и skip'ает задачи. Здесь мы загружаем unique модели
     * из рекомендаций, которых ещё нет в LM Studio loaded list.
     *
     * Стратегия VRAM: загружаем последовательно, не более 2 уникальных
     * моделей (primary = extractorModel, secondary = visionModelKey).
     * Остальные роли часто разделяют одну из этих двух моделей.
     * Если модель уже загружена — пропускаем. Ошибка load — не фатальна. */
    void ensureRecommendedModelsLoaded(filtered).catch((err) => {
      console.warn("[arena] auto-load after apply failed (non-fatal):", err);
    });

    return prefs;
  });

  async function ensureRecommendedModelsLoaded(recs: Partial<Preferences>): Promise<void> {
    const PRIORITY_KEYS = ["extractorModel", "visionModelKey", "evaluatorModel"] as const;
    const modelKeysToLoad = new Set<string>();
    for (const pk of PRIORITY_KEYS) {
      const val = (recs as Record<string, unknown>)[pk];
      if (typeof val === "string" && val.trim().length > 0) {
        modelKeysToLoad.add(val.trim());
      }
    }
    for (const [, val] of Object.entries(recs)) {
      if (typeof val === "string" && val.trim().length > 0) {
        modelKeysToLoad.add(val.trim());
      }
    }
    if (modelKeysToLoad.size === 0) return;

    let loaded: Array<{ modelKey: string }>;
    try {
      loaded = await listLoaded();
    } catch {
      return;
    }
    const alreadyLoaded = new Set(loaded.map((m) => m.modelKey));
    const toLoad = [...modelKeysToLoad].filter((k) => !alreadyLoaded.has(k));
    if (toLoad.length === 0) return;

    const MAX_AUTO_LOAD = 2;
    const selected = toLoad.slice(0, MAX_AUTO_LOAD);
    console.log(`[arena] auto-load: attempting ${selected.length} models: ${selected.join(", ")}`);
    for (const modelKey of selected) {
      try {
        await loadModel(modelKey, { gpuOffload: "max" });
        console.log(`[arena] auto-load OK: "${modelKey}"`);
      } catch (err) {
        console.warn(`[arena] auto-load "${modelKey}" failed:`, err);
      }
    }
  }
}
