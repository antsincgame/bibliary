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
import { promises as fs } from "fs";
import * as path from "path";
import { getPreferencesStore, type Preferences } from "../lib/preferences/store.js";
import { globalLlmLock } from "../lib/llm/global-llm-lock.js";
import { modelRoleResolver } from "../lib/llm/model-role-resolver.js";
import { runOlympics, type OlympicsReport, type OlympicsRole } from "../lib/llm/arena/olympics.js";
import { refreshLmStudioClient, listLoaded, loadModel } from "../lmstudio-client.js";

function getOlympicsReportPath(): string {
  const dataDir = process.env.BIBLIARY_DATA_DIR ?? path.join(process.cwd(), "data");
  return path.join(dataDir, "olympics-report.json");
}

async function persistOlympicsReport(report: OlympicsReport): Promise<void> {
  try {
    const p = getOlympicsReportPath();
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, JSON.stringify(report, null, 2), "utf-8");
  } catch (err) {
    console.warn("[arena] failed to persist Olympics report:", err);
  }
}

async function loadPersistedOlympicsReport(): Promise<OlympicsReport | null> {
  try {
    const raw = await fs.readFile(getOlympicsReportPath(), "utf-8");
    return JSON.parse(raw) as OlympicsReport;
  } catch {
    return null;
  }
}

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

    try {
      const report = await runOlympics({
        models: Array.isArray(args.models) ? (args.models as string[]) : undefined,
        disciplines: Array.isArray(args.disciplines) ? (args.disciplines as string[]) : undefined,
        testAll: args.testAll === true,
        roles: Array.isArray(args.roles) ? (args.roles as OlympicsRole[]) : undefined,
        signal: ctrl.signal,
        onProgress: (ev) => send("arena:olympics-progress", ev),
      });
      if (ctrl.signal.aborted) {
        throw new Error("Olympics aborted by user");
      }
      void persistOlympicsReport(report);
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
    try { await fs.unlink(getOlympicsReportPath()); } catch { /* file may not exist */ }
    return { ok: true };
  });

  ipcMain.handle("arena:get-last-report", async (): Promise<OlympicsReport | null> => {
    return loadPersistedOlympicsReport();
  });

  ipcMain.handle("arena:apply-olympics-recommendations", async (_e, payload: unknown): Promise<Preferences> => {
    if (!payload || typeof payload !== "object") {
      throw new Error("apply-olympics-recommendations: ожидается объект {recommendations}");
    }
    const recs = (payload as { recommendations?: Record<string, string> }).recommendations;
    if (!recs || typeof recs !== "object") throw new Error("recommendations отсутствуют");

    /* Whitelist: только эти ключи разрешено применять. */
    const ALLOWED = new Set([
      "extractorModel", "evaluatorModel", "translatorModel",
      "visionModelKey",
      "langDetectorModel", "ukrainianSpecialistModel",
      "layoutAssistantModel",
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
    /* Build PRIORITY-ORDERED list, не Set: первые 2 — гарантированно
     * extractorModel/visionModelKey/evaluatorModel (если заданы), остальные —
     * вспомогательные роли. Раньше Set дедуплицировал но порядок
     * insertion-зависимый: если evaluator оказался впереди extractor по
     * `Object.entries`, то slice(0,2) мог дать [evaluator, vision] вместо
     * [extractor, vision]. */
    const orderedKeys: string[] = [];
    const seen = new Set<string>();
    for (const pk of PRIORITY_KEYS) {
      const val = (recs as Record<string, unknown>)[pk];
      if (typeof val === "string" && val.trim().length > 0 && !seen.has(val.trim())) {
        const k = val.trim();
        orderedKeys.push(k);
        seen.add(k);
      }
    }
    for (const [, val] of Object.entries(recs)) {
      if (typeof val === "string" && val.trim().length > 0 && !seen.has(val.trim())) {
        const k = val.trim();
        orderedKeys.push(k);
        seen.add(k);
      }
    }
    if (orderedKeys.length === 0) return;

    let loaded: Array<{ modelKey: string }>;
    try {
      loaded = await listLoaded();
    } catch {
      return;
    }
    const alreadyLoaded = new Set(loaded.map((m) => m.modelKey));
    const toLoad = orderedKeys.filter((k) => !alreadyLoaded.has(k));
    if (toLoad.length === 0) return;

    const MAX_AUTO_LOAD = 2;
    const selected = toLoad.slice(0, MAX_AUTO_LOAD);
    const targetSet = new Set(selected);

    /* VRAM safety: если в LM Studio УЖЕ загружено много моделей (≥3) и среди
     * них есть НЕ-recommended — выгружаем "лишние" перед загрузкой новых.
     * Иначе риск OOM/freeze: 2 новые × gpuOffload=max поверх 3+ старых
     * на 8GB VRAM = практически гарантированный hang LM Studio.
     *
     * Правило: оставляем те loaded модели, которые ЕСТЬ в orderedKeys
     * (юзер их явно рекомендовал), всё остальное выгружаем. Это безопасный
     * "garbage collect" перед заездом новых рекомендаций. */
    const VRAM_PRESSURE_THRESHOLD = 3;
    if (loaded.length >= VRAM_PRESSURE_THRESHOLD) {
      const recommendedSet = new Set(orderedKeys);
      const toEvict = loaded
        .map((m) => m.modelKey)
        .filter((k) => !recommendedSet.has(k) && !targetSet.has(k));
      if (toEvict.length > 0) {
        console.log(`[arena] VRAM cleanup: ${loaded.length} loaded, evicting ${toEvict.length} non-recommended: ${toEvict.join(", ")}`);
        const { unloadModel } = await import("../lmstudio-client.js");
        for (const evictKey of toEvict) {
          try {
            await unloadModel(evictKey);
            console.log(`[arena] VRAM cleanup OK: "${evictKey}" unloaded`);
          } catch (err) {
            console.warn(`[arena] VRAM cleanup "${evictKey}" failed (non-fatal):`, err);
          }
        }
      }
    }

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
