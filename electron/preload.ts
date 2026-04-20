import { contextBridge, ipcRenderer } from "electron";

interface QdrantPoint {
  id: string;
  principle: string;
  explanation: string;
  domain: string;
  tags: string[];
}

interface ChatUsage {
  prompt: number;
  completion: number;
  total: number;
}

interface CompareResult {
  withoutRag: string;
  withRag: string;
  usageBase?: ChatUsage;
  usageRag?: ChatUsage;
}

interface DownloadedModelInfo {
  modelKey: string;
  displayName?: string;
  format?: string;
  paramsString?: string;
  sizeBytes?: number;
}

interface LoadedModelInfo {
  identifier: string;
  modelKey: string;
  contextLength?: number;
}

interface ProfileSpec {
  key: string;
  label: string;
  quant: string;
  sizeGB: number;
  minVramGB: number;
  capabilities: ReadonlyArray<string>;
  ttlSec: number;
}

interface ServerStatus {
  online: boolean;
  version?: string;
}

interface BatchSettings {
  profile: "BIG" | "SMALL";
  contextLength: number;
  batchSize: number;
  delayMs: number;
  fewShotCount: number;
  sampling: {
    temperature?: number;
    top_p?: number;
    top_k?: number;
    min_p?: number;
    presence_penalty?: number;
    max_tokens?: number;
  };
}

interface ChunkProgressEvent {
  batchId: string;
  index: number;
  total: number;
  chunkId: string;
  domain: string;
  principleHead: string;
  phase: "T1" | "T2" | "T3" | "done" | "error";
  preview?: string;
  error?: string;
  elapsedMs?: number;
}

interface BatchResult {
  batchId: string;
  batchName: string;
  batchFile: string;
  examplesCount: number;
  processedCount: number;
  failedCount: number;
  progress: ProgressInfo;
}

interface ProgressInfo {
  total_chunks: number;
  processed_count: number;
  remaining_count: number;
  processed_chunk_ids: string[];
  batches: Array<{
    name: string;
    file: string;
    chunk_ids: string[];
    example_count: number;
    examples_per_chunk: number;
    created_at: string;
    notes: string;
  }>;
  next_batch_index: number;
}

interface ValidationReport {
  total: number;
  valid: number;
  errors: string[];
}

contextBridge.exposeInMainWorld("api", {
  getCollections: (): Promise<string[]> => ipcRenderer.invoke("qdrant:collections"),
  getPoints: (collection: string): Promise<QdrantPoint[]> => ipcRenderer.invoke("qdrant:points", collection),
  getModels: (): Promise<Array<{ id: string }>> => ipcRenderer.invoke("lmstudio:models"),
  sendChat: (
    messages: Array<{ role: string; content: string }>,
    model: string,
    collection: string
  ): Promise<string> => ipcRenderer.invoke("lmstudio:chat", messages, model, collection),
  compareChat: (
    messages: Array<{ role: string; content: string }>,
    model: string,
    collection: string
  ): Promise<CompareResult> => ipcRenderer.invoke("lmstudio:compare", messages, model, collection),

  lmstudio: {
    status: (): Promise<ServerStatus> => ipcRenderer.invoke("lmstudio:status"),
    listDownloaded: (): Promise<DownloadedModelInfo[]> => ipcRenderer.invoke("lmstudio:list-downloaded"),
    listLoaded: (): Promise<LoadedModelInfo[]> => ipcRenderer.invoke("lmstudio:list-loaded"),
    profiles: (): Promise<Record<"BIG" | "SMALL", ProfileSpec>> => ipcRenderer.invoke("lmstudio:profiles"),
    load: (
      modelKey: string,
      opts?: { contextLength?: number; ttlSec?: number; gpuOffload?: "max" | number }
    ): Promise<LoadedModelInfo> => ipcRenderer.invoke("lmstudio:load", modelKey, opts ?? {}),
    unload: (identifier: string): Promise<void> => ipcRenderer.invoke("lmstudio:unload", identifier),
    switchProfile: (profile: "BIG" | "SMALL", contextLength?: number): Promise<LoadedModelInfo> =>
      ipcRenderer.invoke("lmstudio:switch-profile", profile, contextLength),
  },

  dataset: {
    startBatch: (settings: BatchSettings): Promise<BatchResult> =>
      ipcRenderer.invoke("dataset:start-batch", settings),
    cancelBatch: (batchId: string): Promise<boolean> => ipcRenderer.invoke("dataset:cancel-batch", batchId),
    getProgress: (): Promise<ProgressInfo | null> => ipcRenderer.invoke("dataset:get-progress"),
    listBatches: (): Promise<string[]> => ipcRenderer.invoke("dataset:list-batches"),
    validateBatch: (batchFile: string): Promise<ValidationReport> =>
      ipcRenderer.invoke("dataset:validate-batch", batchFile),
    onChunkProgress: (callback: (event: ChunkProgressEvent) => void): (() => void) => {
      const listener = (_event: unknown, payload: ChunkProgressEvent): void => callback(payload);
      ipcRenderer.on("dataset:chunk-progress", listener);
      return () => ipcRenderer.removeListener("dataset:chunk-progress", listener);
    },
  },
});
