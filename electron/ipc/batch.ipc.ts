import { ipcMain, type BrowserWindow } from "electron";
import {
  generateBatch,
  type ChunkProgressEvent,
  type BatchResult,
} from "../dataset-generator.js";
import { BatchSettingsSchema } from "../dataset-generator-config.js";
import { listUnfinalized } from "../finetune-state.js";
import { coordinator } from "../lib/resilience/index.js";
import {
  registerActiveBatch,
  unregisterActiveBatch,
  isActiveBatch,
} from "../lib/batch/active-batches.js";

export function registerBatchIpc(getMainWindow: () => BrowserWindow | null): void {
  ipcMain.handle("batch:cancel", async (_e, batchId: string): Promise<boolean> => {
    const handle = coordinator.resolvePipelineByBatchId(batchId);
    if (!handle) return false;
    await handle.cancel(batchId);
    unregisterActiveBatch(batchId);
    return true;
  });

  ipcMain.handle("batch:discard", async (_e, batchId: string): Promise<boolean> => {
    const fromActive = coordinator.resolvePipelineByBatchId(batchId);
    if (fromActive) {
      await fromActive.discard(batchId);
      unregisterActiveBatch(batchId);
      return true;
    }
    const datasetHandle = coordinator.getPipeline("dataset");
    if (datasetHandle) {
      const items = await datasetHandle.store.scan().catch((err) => {
        console.error("[batch:discard] dataset store scan failed:", err instanceof Error ? err.message : err);
        return [];
      });
      if (items.find((i) => i.id === batchId)) {
        await datasetHandle.discard(batchId);
        return true;
      }
    }
    return false;
  });

  ipcMain.handle(
    "batch:resume",
    async (_e, batchName: string): Promise<BatchResult> => {
      const list = await listUnfinalized();
      const target = list.find((s) => s.batchName === batchName);
      if (!target) throw new Error(`No unfinished batch ${batchName}`);
      if (isActiveBatch(batchName)) {
        throw new Error(`Batch ${batchName} is already running`);
      }

      const settings = BatchSettingsSchema.parse(target.config);
      const controller = new AbortController();
      registerActiveBatch(batchName, controller);

      const emitter = (event: ChunkProgressEvent): void => {
        const win = getMainWindow();
        if (win && !win.isDestroyed()) {
          win.webContents.send("dataset:chunk-progress", event);
        }
      };

      try {
        return await generateBatch(batchName, controller.signal, settings, emitter, {
          resume: true,
          resumeBatchName: target.batchName,
          resumeBatchFile: target.batchFile,
        });
      } finally {
        unregisterActiveBatch(batchName);
      }
    }
  );
}
