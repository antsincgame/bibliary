/**
 * Forge run state — checkpoint store для каждого fine-tune run.
 *
 * Для интеграции в [coordinator](../resilience/batch-coordinator.ts) — позволяет
 * resume незавершённого forge-run после перезапуска приложения.
 */

import * as path from "path";
import { z } from "zod";

/* Direct file-level imports only -- importing the resilience barrel
   created a circular dependency: forge/state -> resilience/index ->
   resilience/bootstrap -> forge/state. Going to the leaf modules
   keeps the dependency graph acyclic. */
import { createCheckpointStore, type CheckpointStore } from "../resilience/checkpoint-store";
import { coordinator, type PipelineHandle } from "../resilience/batch-coordinator";

export const ForgeRunStateSchema = z.object({
  runId: z.string().min(1),
  /**
   * Target: "bundle" — основной (и единственный новый) self-hosted режим;
   * "local" — зарезервирован под Phase 3.3 встроенного Unsloth runner.
   * "colab" / "autotrain" сохранены ТОЛЬКО для backward-compat: Zod не должен
   * отвергать старые checkpoint'ы из v2.3 (до удаления облачной инфраструктуры).
   * Новый код всегда пишет "bundle".
   */
  target: z.enum(["colab", "autotrain", "local", "bundle"]),
  spec: z.unknown(),
  /** Подготовленные пути для train/val/eval JSONL. */
  artifacts: z.object({
    trainPath: z.string(),
    valPath: z.string(),
    evalPath: z.string().optional(),
    bundleDir: z.string().optional(),
  }),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  status: z.enum(["preparing", "submitted", "running", "succeeded", "failed", "cancelled"]),
  /** Любые внешние ID (исторически — Colab notebook URL / HF Space job ID). */
  externalRefs: z.record(z.string(), z.string()).optional(),
});

export type ForgeRunState = z.infer<typeof ForgeRunStateSchema>;

let store: CheckpointStore<ForgeRunState> | null = null;
let storeDir: string | null = null;

export function initForgeStore(dataDir: string): CheckpointStore<ForgeRunState> {
  storeDir = path.join(dataDir, "forge", "checkpoints");
  store = createCheckpointStore<ForgeRunState>({
    dir: storeDir,
    schema: ForgeRunStateSchema,
  });
  return store;
}

export function getForgeStore(): CheckpointStore<ForgeRunState> {
  if (!store) throw new Error("Forge store not initialized — call initForgeStore() in bootstrap.");
  return store;
}

/**
 * Регистрация forge-pipeline в coordinator. Симметрично registerDatasetPipeline.
 */
export function registerForgePipeline(): void {
  if (!store) {
    throw new Error("registerForgePipeline: initForgeStore() must be called first");
  }

  const handle: PipelineHandle = {
    name: "forge",
    store: store as never,
    pause: async () => {
      // Forge runs происходят вне Bibliary (Colab/HF/local WSL). Pause не имеет
      // смысла для нас — внешний процесс продолжает идти своим ходом.
    },
    resume: async () => {
      // То же самое — мы не запускаем процесс заново, пользователь следит сам.
    },
    flushPending: async () => {
      // Forge runs не имеют per-step writes как dataset — checkpoint обновляется
      // на каждом ключевом переходе (preparing → submitted → ...). Flush ничего не делает.
    },
    cancel: async (runId: string) => {
      const state = await store!.load(runId);
      if (!state) return;
      if (state.status === "succeeded" || state.status === "failed") return;
      await store!.save(runId, {
        ...state,
        status: "cancelled",
        finishedAt: new Date().toISOString(),
      });
    },
    discard: async (runId: string) => {
      await store!.remove(runId);
    },
  };
  coordinator.registerPipeline(handle);
}

export function nextForgeRunId(): string {
  // Простой timestamp-id, читаемый: forge-2026-04-20-1234
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `forge-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}
