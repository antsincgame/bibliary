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
      const pool = getModelPool();
      const handle = await pool.acquire(modelKey, { ...opts, role: "ui-load" });
      try {
        const loaded = await listLoaded();
        const info = loaded.find((m) => m.modelKey === handle.modelKey || m.identifier === handle.identifier);
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
      modelRoleResolver.invalidate();
    },
  );
  ipcMain.handle("lmstudio:unload", async (_e, identifier: string) => {
    await unloadModel(identifier);
    await getModelPool().refresh();
    modelRoleResolver.invalidate();
  });
}
