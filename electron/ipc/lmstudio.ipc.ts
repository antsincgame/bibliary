import { ipcMain } from "electron";
import {
  listDownloaded,
  listLoaded,
  unloadModel,
  getServerStatus,
  type LoadedModelInfo,
} from "../lmstudio-client.js";
import { getModelPool } from "../lib/llm/model-pool.js";
import {
  logModelAction,
  readActionsLog,
  clearActionsLog,
} from "../lib/llm/lmstudio-actions-log.js";

export function registerLmstudioIpc(): void {
  ipcMain.handle("lmstudio:status", async () => getServerStatus());
  ipcMain.handle("lmstudio:list-downloaded", async () => listDownloaded());
  ipcMain.handle("lmstudio:list-loaded", async () => listLoaded());

  ipcMain.handle(
    "lmstudio:load",
    async (
      _e,
      modelKey: string,
      opts: { contextLength?: number; ttlSec?: number; gpuOffload?: "max" | number } = {},
    ): Promise<LoadedModelInfo> => {
      /* Пускаем UI-загрузку через ModelPool — он сериализует все mut-операции
         через runOnChain. Раньше пользовательский «Load model» из UI обходил
         pool, что давало конкуренцию с автоматическими evaluator/vision-prewarm
         запросами и приводило к OOM на тяжёлых моделях. Сразу release: дальше
         модель видна через listLoaded, refCount=0, LRU eviction только when need. */
      logModelAction("LOAD", { modelKey, role: "ui-load", reason: "user clicked Load button in Models page" });
      const pool = getModelPool();
      const handle = await pool.acquire(modelKey, { ...opts, role: "ui-load" });
      try {
        const loaded = await listLoaded();
        const info = loaded.find((m) => m.modelKey === handle.modelKey || m.identifier === handle.identifier);
        /* v1.0.7: invalidate cache ПЕРЕД возвратом, чтобы следующий resolve() увидел
           новую loaded модель сразу. До v1.0.7 invalidate стоял после return —
           недостижимый код (мёртвый), резолвер кешировал устаревший null. */
        /* model-resolver не имеет cache — invalidate не нужен. */
        if (info) return info;
        /* Pool сообщил об успешной загрузке, но listLoaded модель не нашёл —
           редкий race с user-driven unload. Возвращаем минимальный shape,
           основанный на handle, чтобы UI не упал. */
        return {
          modelKey: handle.modelKey,
          identifier: handle.identifier,
        };
      } finally {
        handle.release();
      }
    },
  );
  ipcMain.handle("lmstudio:unload", async (_e, identifier: string) => {
    logModelAction("UNLOAD", { reason: "user clicked Unload button in Models page", meta: { identifier } });
    await unloadModel(identifier);
    await getModelPool().refresh();
  });

  /* v1.0.7: новые endpoints для UI-доступа к структурному логу действий
     Bibliary с моделями LM Studio. Введены после "autonomous heresy" инцидента
     для прозрачности: пользователь видит ВСЕ load/unload/auto-load события. */
  ipcMain.handle("lmstudio:get-actions-log", async (_e, maxLines?: number) => {
    const limit = typeof maxLines === "number" && maxLines > 0 ? Math.min(maxLines, 5000) : 500;
    return readActionsLog(limit);
  });
  ipcMain.handle("lmstudio:clear-actions-log", async () => {
    await clearActionsLog();
    return true;
  });

  /**
   * `models:auto-configure` — heuristic auto-pick reader/extractor/vision-ocr
   * из текущих loaded моделей и запись в preferences. Возвращает что было
   * назначено + reasons + estimated VRAM для UI warning.
   */
  ipcMain.handle("models:auto-configure", async (): Promise<{
    ok: boolean;
    error?: string;
    assignments: { reader: string | null; extractor: string | null; "vision-ocr": string | null };
    reasons: Array<{ task: string; modelKey: string | null; reason: string }>;
    saved: { readerModel?: string; extractorModel?: string; visionOcrModel?: string };
    estimatedVramGb: number;
  }> => {
    try {
      const { listLoaded } = await import("../lmstudio-client.js");
      const { autoConfigureTasks, toPreferenceUpdates, totalVramEstimateGb } = await import("../lib/llm/auto-config.js");
      const { getPreferencesStore } = await import("../lib/preferences/store.js");

      const loaded = await listLoaded();
      const result = autoConfigureTasks(loaded);
      const updates = toPreferenceUpdates(result);

      /* Сохраняем только non-null назначения. Если какая-то задача = null
       * (например vision-ocr когда нет vision модели) — оставляем существующий
       * pref как есть, не перетираем пустотой. */
      if (Object.keys(updates).length > 0) {
        await getPreferencesStore().set(updates);
      }

      return {
        ok: true,
        assignments: result.assignments,
        reasons: result.reasons,
        saved: updates,
        estimatedVramGb: totalVramEstimateGb(result, loaded),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error: msg,
        assignments: { reader: null, extractor: null, "vision-ocr": null },
        reasons: [],
        saved: {},
        estimatedVramGb: 0,
      };
    }
  });

  /**
   * `models:preload-assigned` — последовательно прогревает все назначенные
   * модели через ModelPool.acquire (использует SDK под капотом). Если VRAM
   * не хватает — pool.acquire эвиктит LRU автоматически. Это означает что
   * preload может НЕ оставить все 3 модели в памяти одновременно — они
   * будут грузиться по требованию и эвиктиться по TTL.
   *
   * Возвращает массив {task, modelKey, ok, error?} — UI показывает прогресс.
   */
  ipcMain.handle("models:preload-assigned", async (): Promise<{
    ok: boolean;
    results: Array<{ task: string; modelKey: string; ok: boolean; error?: string; durationMs: number }>;
  }> => {
    const { getPreferencesStore } = await import("../lib/preferences/store.js");
    const { getModelPool } = await import("../lib/llm/model-pool.js");
    const prefs = await getPreferencesStore().getAll();

    /* Порядок: extractor → reader → vision-ocr. Главная модель грузится
     * первой, чтобы при VRAM-pressure она точно поместилась. */
    const queue: Array<{ task: string; modelKey: string }> = [];
    const ext = String((prefs as Record<string, unknown>).extractorModel || "").trim();
    const reader = String((prefs as Record<string, unknown>).readerModel || "").trim();
    const vision = String((prefs as Record<string, unknown>).visionOcrModel || "").trim();
    if (ext) queue.push({ task: "extractor", modelKey: ext });
    if (reader && reader !== ext) queue.push({ task: "reader", modelKey: reader });
    if (vision && vision !== ext && vision !== reader) queue.push({ task: "vision-ocr", modelKey: vision });

    const results: Array<{ task: string; modelKey: string; ok: boolean; error?: string; durationMs: number }> = [];
    const pool = getModelPool();
    for (const { task, modelKey } of queue) {
      const start = Date.now();
      try {
        /* acquire + immediate release — модель загружена, refCount=0, ttl
         * запущен. После TTL pool сам выгрузит если никто не использует. */
        const handle = await pool.acquire(modelKey, { role: task, ttlSec: 1800 });
        handle.release();
        results.push({ task, modelKey, ok: true, durationMs: Date.now() - start });
      } catch (e) {
        results.push({
          task,
          modelKey,
          ok: false,
          error: e instanceof Error ? e.message : String(e),
          durationMs: Date.now() - start,
        });
      }
    }
    return { ok: results.every((r) => r.ok), results };
  });
}
