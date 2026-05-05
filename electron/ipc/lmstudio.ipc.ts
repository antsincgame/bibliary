import { ipcMain } from "electron";
import {
  listDownloaded,
  listLoaded,
  unloadModel,
  getServerStatus,
  type LoadedModelInfo,
} from "../lmstudio-client.js";
import { getModelPool } from "../lib/llm/model-pool.js";
import { modelRoleResolver } from "../lib/llm/model-role-resolver.js";
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
        modelRoleResolver.invalidate();
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
    modelRoleResolver.invalidate();
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
}
