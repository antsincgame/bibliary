import * as telemetry from "./telemetry";
import type { CheckpointStore } from "./checkpoint-store";

export type PipelineName = "extraction";

export interface BatchInfo {
  batchId: string;
  pipeline: PipelineName;
  startedAt: string;
  config: unknown;
}

export interface PipelineHandle {
  name: PipelineName;
  store: CheckpointStore<unknown>;
  pause: (batchId: string) => Promise<void>;
  resume: (batchId: string) => Promise<void>;
  cancel: (batchId: string) => Promise<void>;
  discard: (batchId: string) => Promise<void>;
  flushPending: () => Promise<void>;
}

export type BatchStartListener = (info: BatchInfo) => void;
export type BatchEndListener = (info: { batchId: string }) => void;

export interface BatchCoordinator {
  registerPipeline(handle: PipelineHandle): void;
  getPipeline(name: PipelineName): PipelineHandle | null;
  resolvePipelineByBatchId(batchId: string): PipelineHandle | null;
  reportBatchStart(info: BatchInfo): void;
  reportBatchEnd(batchId: string): void;
  scanUnfinished(): Promise<Array<{ pipeline: PipelineName; id: string; snapshot: unknown }>>;
  isAnyActive(): boolean;
  listActive(): BatchInfo[];
  pauseAll(reason: string): Promise<void>;
  resumeAll(): Promise<void>;
  flushAll(timeoutMs: number): Promise<{ ok: boolean; pending: string[] }>;
  onBatchStart(callback: BatchStartListener): () => void;
  onBatchEnd(callback: BatchEndListener): () => void;
}

class CoordinatorImpl implements BatchCoordinator {
  private readonly pipelines = new Map<PipelineName, PipelineHandle>();
  private readonly active = new Map<string, BatchInfo>();
  private readonly startListeners = new Set<BatchStartListener>();
  private readonly endListeners = new Set<BatchEndListener>();

  registerPipeline(handle: PipelineHandle): void {
    this.pipelines.set(handle.name, handle);
  }

  getPipeline(name: PipelineName): PipelineHandle | null {
    return this.pipelines.get(name) ?? null;
  }

  resolvePipelineByBatchId(batchId: string): PipelineHandle | null {
    const info = this.active.get(batchId);
    if (info) return this.pipelines.get(info.pipeline) ?? null;
    return null;
  }

  reportBatchStart(info: BatchInfo): void {
    if (!this.pipelines.has(info.pipeline)) {
      // Невозможно нормально cancel/discard — pipeline должен быть зарегистрирован
      // ДО старта батча. Это инвариант приложения, а не runtime ошибка пользователя.
      throw new Error(
        `Coordinator: pipeline "${info.pipeline}" is not registered. Register it in main.ts bootstrap.`
      );
    }
    this.active.set(info.batchId, info);
    telemetry.logEvent({
      type: "batch.start",
      batchId: info.batchId,
      pipeline: info.pipeline,
      config: info.config,
    });
    for (const listener of this.startListeners) {
      try {
        listener(info);
      } catch (err) {
        console.error("[coordinator] start listener error:", err);
      }
    }
  }

  reportBatchEnd(batchId: string): void {
    if (!this.active.has(batchId)) return;
    this.active.delete(batchId);
    for (const listener of this.endListeners) {
      try {
        listener({ batchId });
      } catch (err) {
        console.error("[coordinator] end listener error:", err);
      }
    }
  }

  async scanUnfinished(): Promise<Array<{ pipeline: PipelineName; id: string; snapshot: unknown }>> {
    const out: Array<{ pipeline: PipelineName; id: string; snapshot: unknown }> = [];
    for (const handle of this.pipelines.values()) {
      try {
        const items = await handle.store.scan();
        for (const item of items) {
          out.push({ pipeline: handle.name, id: item.id, snapshot: item.snapshot });
        }
      } catch (err) {
        console.error(`[coordinator] scan ${handle.name} failed:`, err);
      }
    }
    return out;
  }

  isAnyActive(): boolean {
    return this.active.size > 0;
  }

  listActive(): BatchInfo[] {
    return [...this.active.values()];
  }

  async pauseAll(reason: string): Promise<void> {
    const tasks: Promise<void>[] = [];
    for (const info of this.active.values()) {
      const handle = this.pipelines.get(info.pipeline);
      if (!handle) continue;
      tasks.push(
        handle.pause(info.batchId).catch((err) => {
          console.error(`[coordinator] pause ${info.batchId} (${reason}):`, err);
        })
      );
    }
    await Promise.all(tasks);
  }

  async resumeAll(): Promise<void> {
    const tasks: Promise<void>[] = [];
    for (const info of this.active.values()) {
      const handle = this.pipelines.get(info.pipeline);
      if (!handle) continue;
      tasks.push(
        handle.resume(info.batchId).catch((err) => {
          console.error(`[coordinator] resume ${info.batchId}:`, err);
        })
      );
    }
    await Promise.all(tasks);
  }

  async flushAll(timeoutMs: number): Promise<{ ok: boolean; pending: string[] }> {
    const pendingIds = [...this.active.keys()];
    if (pendingIds.length === 0) return { ok: true, pending: [] };

    if (this.pipelines.size === 0) {
      // Активные батчи существуют, но pipeline не зарегистрирован — flush невозможен.
      // Это указывает на bug в bootstrap; логируем и возвращаем ok=false.
      telemetry.logEvent({
        type: "shutdown.flush.error",
        error: `flushAll: ${pendingIds.length} active batch(es) but no pipelines registered`,
      });
      return { ok: false, pending: pendingIds };
    }

    const tasks: Promise<void>[] = [];
    for (const handle of this.pipelines.values()) {
      tasks.push(
        handle.flushPending().catch((err) => {
          telemetry.logEvent({
            type: "shutdown.flush.error",
            error: `${handle.name}: ${err instanceof Error ? err.message : String(err)}`,
          });
        })
      );
    }

    let timer: NodeJS.Timeout | null = null;
    const timeoutPromise = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
    });

    try {
      const result = await Promise.race([Promise.all(tasks).then(() => "done" as const), timeoutPromise]);
      const stillPending = [...this.active.keys()];
      if (result === "timeout") {
        // ВАЖНО: pipeline.flushPending() **продолжает** выполняться в фоне.
        // app.exit() корректно прервёт их. Документировано в RESILIENCE.md.
        return { ok: stillPending.length === 0, pending: stillPending };
      }
      return { ok: true, pending: stillPending };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  onBatchStart(callback: BatchStartListener): () => void {
    this.startListeners.add(callback);
    return () => this.startListeners.delete(callback);
  }

  onBatchEnd(callback: BatchEndListener): () => void {
    this.endListeners.add(callback);
    return () => this.endListeners.delete(callback);
  }
}

export const coordinator: BatchCoordinator = new CoordinatorImpl();
