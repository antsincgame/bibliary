import { ipcMain, shell, type BrowserWindow } from "electron";
import { promises as fs } from "fs";
import * as path from "path";
import {
  generateBatch,
  type ChunkProgressEvent,
  type BatchResult,
} from "../dataset-generator.js";
import { BatchSettingsSchema } from "../dataset-generator-config.js";
import {
  readProgress,
  listBatchFiles,
  getPaths,
  listUnfinalized,
  nextBatchName,
  type Progress,
  type DatasetBatchState,
} from "../finetune-state.js";
import { switchProfile, getServerStatus, listLoaded, PROFILE } from "../lmstudio-client.js";
import { getPromptStore, DatasetRolesSchema, type DatasetRoles } from "../lib/prompts/store.js";
import { validateLine } from "../lib/dataset/validate-line.js";
import {
  registerActiveBatch,
  unregisterActiveBatch,
  isActiveBatch,
} from "../lib/batch/active-batches.js";

interface DatasetReadiness {
  lmStudioOnline: boolean;
  lmStudioVersion?: string;
  bigModelLoaded: boolean;
  bigModelKey: string;
  sourceChunkCount: number;
  unprocessedCount: number;
  goldExampleCount: number;
  sourcePath: string;
  goldPath: string;
  finetuneDir: string;
  sourceExists: boolean;
  goldExists: boolean;
}

export function registerDatasetIpc(getMainWindow: () => BrowserWindow | null): void {
  ipcMain.handle(
    "dataset:start-batch",
    async (_e, rawSettings: unknown): Promise<BatchResult> => {
      const settings = BatchSettingsSchema.parse(rawSettings);
      const progress = await readProgress();
      const { name: batchName } = nextBatchName(progress);
      if (isActiveBatch(batchName)) {
        throw new Error(`Batch ${batchName} is already running`);
      }
      const controller = new AbortController();
      registerActiveBatch(batchName, controller);

      const emitter = (event: ChunkProgressEvent): void => {
        const win = getMainWindow();
        if (win && !win.isDestroyed()) {
          win.webContents.send("dataset:chunk-progress", event);
        }
      };

      try {
        return await generateBatch(batchName, controller.signal, settings, emitter);
      } finally {
        unregisterActiveBatch(batchName);
      }
    }
  );

  ipcMain.handle("dataset:list-unfinalized", async (): Promise<DatasetBatchState[]> => {
    return listUnfinalized();
  });

  ipcMain.handle("dataset:read-roles", async (): Promise<DatasetRoles> => {
    return getPromptStore().readDatasetRoles();
  });

  ipcMain.handle("dataset:write-roles", async (_e, roles: unknown): Promise<DatasetRoles> => {
    const validated = DatasetRolesSchema.parse(roles);
    await getPromptStore().writeDatasetRoles(validated);
    return validated;
  });

  ipcMain.handle("dataset:get-progress", async (): Promise<Progress | null> => {
    try {
      return await readProgress();
    } catch (e) {
      console.error("[dataset:get-progress]", e instanceof Error ? e.message : e);
      return null;
    }
  });

  ipcMain.handle("dataset:list-batches", async (): Promise<string[]> => listBatchFiles());

  ipcMain.handle("dataset:check-readiness", async (): Promise<DatasetReadiness> => {
    const { sourcePath, goldPath, finetuneDir } = getPaths();
    const readiness: DatasetReadiness = {
      lmStudioOnline: false,
      lmStudioVersion: undefined,
      bigModelLoaded: false,
      bigModelKey: PROFILE.BIG.key,
      sourceChunkCount: 0,
      unprocessedCount: 0,
      goldExampleCount: 0,
      sourcePath,
      goldPath,
      finetuneDir,
      sourceExists: false,
      goldExists: false,
    };

    try {
      const status = await getServerStatus();
      readiness.lmStudioOnline = status.online;
      readiness.lmStudioVersion = status.version;
    } catch {
      readiness.lmStudioOnline = false;
    }

    if (readiness.lmStudioOnline) {
      try {
        const loaded = await listLoaded();
        readiness.bigModelLoaded = loaded.some((m) => m.modelKey === PROFILE.BIG.key);
      } catch {
        readiness.bigModelLoaded = false;
      }
    }

    try {
      const raw = await fs.readFile(sourcePath, "utf8");
      const chunks = JSON.parse(raw) as Array<{ id: string }>;
      readiness.sourceExists = true;
      readiness.sourceChunkCount = chunks.length;
      try {
        const progress = await readProgress();
        const processed = new Set(progress.processed_chunk_ids);
        readiness.unprocessedCount = chunks.filter((c) => !processed.has(c.id)).length;
      } catch {
        readiness.unprocessedCount = chunks.length;
      }
    } catch {
      readiness.sourceExists = false;
    }

    try {
      const raw = (await fs.readFile(goldPath, "utf8")).trim();
      readiness.goldExists = true;
      readiness.goldExampleCount = raw ? raw.split("\n").length : 0;
    } catch {
      readiness.goldExists = false;
    }

    return readiness;
  });

  ipcMain.handle(
    "dataset:load-big-model",
    async (_e, contextLength?: number) => switchProfile("BIG", contextLength ?? 32768)
  );

  ipcMain.handle("dataset:open-finetune-folder", async (): Promise<string> => {
    const { finetuneDir } = getPaths();
    await fs.mkdir(finetuneDir, { recursive: true });
    return shell.openPath(finetuneDir);
  });

  ipcMain.handle(
    "dataset:validate-batch",
    async (_e, batchFile: string): Promise<{ total: number; valid: number; errors: string[] }> => {
      const { batchesDir, sourcePath } = getPaths();
      const batchPath = path.join(batchesDir, path.basename(batchFile));
      try {
        const sourceChunks = JSON.parse(await fs.readFile(sourcePath, "utf8")) as Array<{ id: string }>;
        const validIds = new Set(sourceChunks.map((c) => c.id));
        const raw = (await fs.readFile(batchPath, "utf8")).trim();
        const lines = raw.split("\n");
        const errors: string[] = [];
        let valid = 0;
        for (let i = 0; i < lines.length; i++) {
          const issues = validateLine(lines[i], validIds);
          if (issues.length === 0) valid++;
          else issues.forEach((msg) => errors.push(`Line ${i + 1}: ${msg}`));
        }
        return { total: lines.length, valid, errors };
      } catch (e) {
        return { total: 0, valid: 0, errors: [e instanceof Error ? e.message : String(e)] };
      }
    }
  );
}
