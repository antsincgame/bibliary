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

type TelemetryEvent = Record<string, unknown> & { type: string; ts: string };

interface UnfinishedBatch {
  pipeline: string;
  id: string;
  snapshot: unknown;
}

interface QdrantCollectionsListItem {
  name: string;
  pointsCount: number;
  vectorSize?: number;
  status: string;
}

interface QdrantCollectionInfo {
  name: string;
  pointsCount: number;
  vectorsCount: number;
  segmentsCount: number;
  status: string;
  vectorSize?: number;
  distance?: string;
  diskDataSize?: number;
  ramDataSize?: number;
}

interface QdrantClusterInfo {
  url: string;
  online: boolean;
  version?: string;
  collectionsCount: number;
}

interface QdrantSearchHit {
  id: string;
  score: number;
  payload: Record<string, unknown>;
}

contextBridge.exposeInMainWorld("api", {
  getCollections: (): Promise<string[]> => ipcRenderer.invoke("qdrant:collections"),
  getPoints: (collection: string): Promise<QdrantPoint[]> => ipcRenderer.invoke("qdrant:points", collection),

  qdrant: {
    list: (): Promise<string[]> => ipcRenderer.invoke("qdrant:collections"),
    listDetailed: (): Promise<QdrantCollectionsListItem[]> =>
      ipcRenderer.invoke("qdrant:collections-detailed"),
    info: (name: string): Promise<QdrantCollectionInfo | null> =>
      ipcRenderer.invoke("qdrant:collection-info", name),
    create: (
      args: { name: string; vectorSize?: number; distance?: "Cosine" | "Euclid" | "Dot" }
    ): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke("qdrant:create-collection", args),
    remove: (name: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke("qdrant:delete-collection", name),
    search: (
      args: { collection: string; query?: string; vector?: number[]; limit?: number }
    ): Promise<QdrantSearchHit[]> => ipcRenderer.invoke("qdrant:search", args),
    cluster: (): Promise<QdrantClusterInfo> => ipcRenderer.invoke("qdrant:cluster-info"),
    points: (collection: string): Promise<QdrantPoint[]> => ipcRenderer.invoke("qdrant:points", collection),
  },

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

  resilience: {
    scanUnfinished: (): Promise<UnfinishedBatch[]> => ipcRenderer.invoke("resilience:scan-unfinished"),
    telemetryTail: (n: number): Promise<TelemetryEvent[]> =>
      ipcRenderer.invoke("resilience:telemetry-tail", n),
    onLmstudioOffline: (callback: (payload: { consecutiveFailures: number }) => void): (() => void) => {
      const listener = (_e: unknown, payload: { consecutiveFailures: number }): void => callback(payload);
      ipcRenderer.on("resilience:lmstudio-offline", listener);
      return () => ipcRenderer.removeListener("resilience:lmstudio-offline", listener);
    },
    onLmstudioOnline: (callback: () => void): (() => void) => {
      const listener = (): void => callback();
      ipcRenderer.on("resilience:lmstudio-online", listener);
      return () => ipcRenderer.removeListener("resilience:lmstudio-online", listener);
    },
  },

  yarn: {
    /** Полная рекомендация для UI (factor + KV variants + suggestions). */
    recommend: (modelKey: string, targetTokens: number, availableForKVGb?: number): Promise<unknown> =>
      ipcRenderer.invoke("yarn:recommend", { modelKey, targetTokens, availableForKVGb }),
    /** Прочитать текущий rope_scaling из model card (или null). */
    readCurrent: (modelKey: string): Promise<{ factor: number; original_max_position_embeddings: number } | null> =>
      ipcRenderer.invoke("yarn:read-current", modelKey),
    /** Применить YaRN к модели (atomic + backup). Возвращает summary. */
    apply: (modelKey: string, targetTokens: number, kvDtype: string): Promise<{ ok: true; configPath: string }> =>
      ipcRenderer.invoke("yarn:apply", { modelKey, targetTokens, kvDtype }),
    /** Откатить YaRN: восстановить config из backup. */
    revert: (modelKey: string): Promise<{ ok: true; restored: boolean }> =>
      ipcRenderer.invoke("yarn:revert", modelKey),
    /** Список known моделей с их native/yarnMax. Для UI presets. */
    listModels: (): Promise<Array<{ modelKey: string; displayName: string; nativeTokens: number; yarnMaxTokens: number }>> =>
      ipcRenderer.invoke("yarn:list-models"),
    /** Доступен ли активный backup (значит можно revert). */
    hasBackup: (modelKey: string): Promise<boolean> => ipcRenderer.invoke("yarn:has-backup", modelKey),
  },

  system: {
    hardware: (force?: boolean): Promise<unknown> =>
      ipcRenderer.invoke("system:hardware-info", { force: force === true }),
    envSummary: (): Promise<{ lmStudioUrl: string; qdrantUrl: string; platform: string; arch: string }> =>
      ipcRenderer.invoke("system:env-summary"),
    hardwarePresets: (): Promise<unknown> => ipcRenderer.invoke("system:hardware-presets"),
    /** Кураторский список рекомендованных моделей для wizard. */
    curatedModels: (): Promise<unknown> => ipcRenderer.invoke("system:curated-models"),
    invalidateHardwareCache: (): Promise<boolean> => ipcRenderer.invoke("system:invalidate-hardware-cache"),
    /** Параллельный health-check LM Studio + Qdrant для onboarding wizard. */
    probeServices: (): Promise<{
      lmStudio: { online: boolean; version?: string; url: string };
      qdrant: { online: boolean; version?: string; url: string };
    }> => ipcRenderer.invoke("system:probe-services"),
  },

  profile: {
    list: (): Promise<unknown[]> => ipcRenderer.invoke("profile:list"),
    get: (id: string): Promise<unknown> => ipcRenderer.invoke("profile:get", id),
    upsert: (profile: unknown): Promise<unknown> => ipcRenderer.invoke("profile:upsert", profile),
    remove: (id: string): Promise<boolean> => ipcRenderer.invoke("profile:remove", id),
    resetToDefaults: (): Promise<unknown[]> => ipcRenderer.invoke("profile:reset-to-defaults"),
    export: (): Promise<{ path: string } | null> => ipcRenderer.invoke("profile:export"),
    import: (): Promise<{ path: string; summary: unknown } | null> => ipcRenderer.invoke("profile:import"),
  },

  preferences: {
    getAll: (): Promise<Record<string, unknown>> => ipcRenderer.invoke("preferences:get-all"),
    getDefaults: (): Promise<Record<string, unknown>> => ipcRenderer.invoke("preferences:get-defaults"),
    set: (partial: Record<string, unknown>): Promise<Record<string, unknown>> =>
      ipcRenderer.invoke("preferences:set", partial),
    reset: (): Promise<Record<string, unknown>> => ipcRenderer.invoke("preferences:reset"),
  },

  chatHistory: {
    load: (): Promise<Array<{ role: "user" | "assistant" | "system"; content: string }>> =>
      ipcRenderer.invoke("chat-history:load"),
    save: (messages: Array<{ role: string; content: string }>): Promise<{ saved: number }> =>
      ipcRenderer.invoke("chat-history:save", messages),
    clear: (): Promise<boolean> => ipcRenderer.invoke("chat-history:clear"),
  },

  forge: {
    listSourceBatches: (): Promise<string[]> => ipcRenderer.invoke("forge:list-source-batches"),
    nextRunId: (): Promise<string> => ipcRenderer.invoke("forge:next-run-id"),
    previewSource: (sourcePath: string): Promise<unknown> => ipcRenderer.invoke("forge:preview-source", sourcePath),
    prepare: (args: { spec: unknown; sourcePath: string; trainRatio?: number; evalRatio?: number; seed?: number }): Promise<unknown> =>
      ipcRenderer.invoke("forge:prepare", args),
    generateBundle: (args: { spec: unknown; runId: string; target: string }): Promise<unknown> =>
      ipcRenderer.invoke("forge:generate-bundle", args),
    genConfig: (args: { spec: unknown; kind: "unsloth" | "autotrain" | "axolotl" | "colab" }): Promise<{ content: string; ext: string }> =>
      ipcRenderer.invoke("forge:gen-config", args),
    openBundleFolder: (runId: string): Promise<string> => ipcRenderer.invoke("forge:open-bundle-folder", runId),
    listRuns: (): Promise<unknown[]> => ipcRenderer.invoke("forge:list-runs"),
    markStatus: (runId: string, status: string): Promise<unknown> =>
      ipcRenderer.invoke("forge:mark-status", { runId, status }),
  },

  hf: {
    hasToken: (): Promise<boolean> => ipcRenderer.invoke("hf:has-token"),
    saveToken: (token: string): Promise<{ ok: true }> => ipcRenderer.invoke("hf:save-token", token),
    clearToken: (): Promise<{ ok: true }> => ipcRenderer.invoke("hf:clear-token"),
    searchModels: (query: string, limit?: number): Promise<Array<{ id: string; downloads?: number; likes?: number; tags?: string[] }>> =>
      ipcRenderer.invoke("hf:search-models", { query, limit }),
    modelInfo: (repoId: string): Promise<unknown> => ipcRenderer.invoke("hf:model-info", repoId),
    openColab: (): Promise<{ url: string }> => ipcRenderer.invoke("hf:open-colab"),
    openAutoTrain: (): Promise<{ url: string }> => ipcRenderer.invoke("hf:open-autotrain"),
    openModelPage: (repoId: string): Promise<{ url: string }> => ipcRenderer.invoke("hf:open-model-page", repoId),
  },

  wsl: {
    detect: (): Promise<unknown> => ipcRenderer.invoke("wsl:detect"),
  },

  scanner: {
    probeFolder: (): Promise<Array<{ absPath: string; fileName: string; ext: string; sizeBytes: number; mtimeMs: number }>> =>
      ipcRenderer.invoke("scanner:probe-folder"),
    probePath: (folder: string): Promise<Array<{ absPath: string; fileName: string; ext: string; sizeBytes: number; mtimeMs: number }>> =>
      ipcRenderer.invoke("scanner:probe-path", folder),
    probeFiles: (paths: string[]): Promise<Array<{ absPath: string; fileName: string; ext: string; sizeBytes: number; mtimeMs: number }>> =>
      ipcRenderer.invoke("scanner:probe-files", paths),
    openFiles: (): Promise<Array<{ absPath: string; fileName: string; ext: string; sizeBytes: number; mtimeMs: number }>> =>
      ipcRenderer.invoke("scanner:open-files"),
    ocrSupport: (): Promise<{ supported: boolean; platform: string; reason?: string }> =>
      ipcRenderer.invoke("scanner:ocr-support"),
    parsePreview: (
      filePath: string
    ): Promise<{
      metadata: { title: string; author?: string; language?: string; warnings: string[] };
      sectionCount: number;
      estimatedChunks: number;
      rawCharCount: number;
      sampleChunks: Array<{ chapterTitle: string; chapterIndex: number; chunkIndex: number; text: string; charCount: number }>;
    }> => ipcRenderer.invoke("scanner:parse-preview", filePath),
    startIngest: (args: {
      filePath: string;
      collection: string;
      chunkerOptions?: { targetChars?: number; maxChars?: number; minChars?: number };
      ocrOverride?: boolean;
    }): Promise<{ ingestId: string; result: unknown }> => ipcRenderer.invoke("scanner:start-ingest", args),
    cancelIngest: (ingestId: string): Promise<boolean> => ipcRenderer.invoke("scanner:cancel-ingest", ingestId),
    listState: (): Promise<unknown> => ipcRenderer.invoke("scanner:list-state"),
    listHistory: (): Promise<
      Array<{
        collection: string;
        books: Array<{
          bookSourcePath: string;
          fileName: string;
          status: "running" | "done" | "error" | "paused";
          totalChunks: number;
          processedChunks: number;
          startedAt: string;
          lastUpdatedAt: string;
          errorMessage?: string;
        }>;
        totalBooks: number;
        totalChunks: number;
      }>
    > => ipcRenderer.invoke("scanner:list-history"),
    deleteFromCollection: (
      bookSourcePath: string,
      collection: string
    ): Promise<{ deleted: boolean; pointsDeleted: number }> =>
      ipcRenderer.invoke("scanner:delete-from-collection", { bookSourcePath, collection }),
    onProgress: (cb: (payload: { ingestId: string; phase: string; bookSourcePath: string; bookTitle: string; totalChunks: number; processedChunks: number; embeddedChunks: number; upsertedChunks: number; message?: string; errorMessage?: string }) => void): (() => void) => {
      const l = (_e: unknown, p: { ingestId: string; phase: string; bookSourcePath: string; bookTitle: string; totalChunks: number; processedChunks: number; embeddedChunks: number; upsertedChunks: number; message?: string; errorMessage?: string }) => cb(p);
      ipcRenderer.on("scanner:ingest-progress", l);
      return () => ipcRenderer.removeListener("scanner:ingest-progress", l);
    },
  },

  agent: {
    start: (args: {
      userMessage: string;
      /** Обязательно: имя модели, загруженной в LM Studio (см. lmstudio.listLoaded). */
      model: string;
      budget?: { maxIterations?: number; maxTokens?: number };
    }): Promise<{
      agentId: string;
      finalAnswer: string;
      iterations: number;
      tokensUsed: number;
      toolHistory: Array<{ name: string; args: unknown; ok: boolean; durationMs: number }>;
      aborted: boolean;
      abortedReason?: string;
    }> => ipcRenderer.invoke("agent:start", args),
    approve: (callId: string, approved: boolean): Promise<boolean> =>
      ipcRenderer.invoke("agent:approve", { callId, approved }),
    cancel: (agentId: string): Promise<boolean> => ipcRenderer.invoke("agent:cancel", agentId),
    onEvent: (cb: (payload: { agentId: string; type: string; [k: string]: unknown }) => void): (() => void) => {
      const l = (_e: unknown, p: { agentId: string; type: string; [k: string]: unknown }) => cb(p);
      ipcRenderer.on("agent:event", l);
      return () => ipcRenderer.removeListener("agent:event", l);
    },
  },

  bookhunter: {
    search: (args: {
      query: string;
      sources?: Array<"gutendex" | "archive" | "openlibrary" | "arxiv">;
      language?: string;
      perSourceLimit?: number;
    }): Promise<
      Array<{
        id: string;
        sourceTag: "gutendex" | "archive" | "openlibrary" | "arxiv";
        title: string;
        authors: string[];
        language?: string;
        year?: number;
        formats: Array<{ format: string; url: string; sizeBytes?: number }>;
        license: string;
        webPageUrl?: string;
        description?: string;
      }>
    > => ipcRenderer.invoke("bookhunter:search", args),
    download: (args: { candidate: unknown; preferredFormat?: string }): Promise<{ downloadId: string; destPath: string; bytesWritten: number; format: string }> =>
      ipcRenderer.invoke("bookhunter:download", args),
    cancelDownload: (downloadId: string): Promise<boolean> =>
      ipcRenderer.invoke("bookhunter:cancel-download", downloadId),
    downloadAndIngest: (args: {
      candidate: unknown;
      collection: string;
      preferredFormat?: string;
      downloadId?: string;
    }): Promise<{ downloadId: string; destPath: string; bookTitle: string; embedded: number; upserted: number }> =>
      ipcRenderer.invoke("bookhunter:download-and-ingest", args),
    onDownloadProgress: (cb: (payload: { downloadId: string; downloaded: number; total: number | null }) => void): (() => void) => {
      const l = (_e: unknown, p: { downloadId: string; downloaded: number; total: number | null }) => cb(p);
      ipcRenderer.on("bookhunter:download-progress", l);
      return () => ipcRenderer.removeListener("bookhunter:download-progress", l);
    },
  },

  datasetV2: {
    startExtraction: (args: {
      bookSourcePath: string;
      chapterRange?: { from: number; to: number };
      extractModel?: string;
      judgeModel?: string;
      scoreThreshold?: number;
    }): Promise<{
      jobId: string;
      bookTitle: string;
      totalChapters: number;
      processedChapters: number;
      totalConcepts: { extractedRaw: number; afterDedup: number; accepted: number; rejected: number };
      warnings: string[];
    }> => ipcRenderer.invoke("dataset-v2:start-extraction", args),
    cancel: (jobId: string): Promise<boolean> => ipcRenderer.invoke("dataset-v2:cancel", jobId),
    listAccepted: (): Promise<{ total: number; byDomain: Record<string, number> }> =>
      ipcRenderer.invoke("dataset-v2:list-accepted"),
    rejectAccepted: (conceptId: string): Promise<boolean> =>
      ipcRenderer.invoke("dataset-v2:reject-accepted", conceptId),
    onEvent: (cb: (payload: { jobId: string; stage: string; [k: string]: unknown }) => void): (() => void) => {
      const l = (_e: unknown, p: { jobId: string; stage: string; [k: string]: unknown }) => cb(p);
      ipcRenderer.on("dataset-v2:event", l);
      return () => ipcRenderer.removeListener("dataset-v2:event", l);
    },
  },

  forgeLocal: {
    start: (args: { runId: string; scriptWinPath: string; distro?: string }): Promise<{ ok: true }> =>
      ipcRenderer.invoke("forge:start-local", args),
    cancel: (runId: string): Promise<boolean> => ipcRenderer.invoke("forge:cancel-local", runId),
    importGguf: (outputDir: string, modelKey: string): Promise<{ destPath: string; copied: number }> =>
      ipcRenderer.invoke("forge:import-gguf", { outputDir, modelKey }),
    runEval: (args: { evalPath: string; baseModel: string; tunedModel: string; judgeModel?: string; maxCases?: number }): Promise<unknown> =>
      ipcRenderer.invoke("forge:run-eval", args),
    cancelEval: (): Promise<boolean> => ipcRenderer.invoke("forge:cancel-eval"),
    onMetric: (cb: (payload: { runId: string; metric: unknown }) => void): (() => void) => {
      const l = (_e: unknown, p: { runId: string; metric: unknown }) => cb(p);
      ipcRenderer.on("forge:local-metric", l);
      return () => ipcRenderer.removeListener("forge:local-metric", l);
    },
    onStdout: (cb: (payload: { runId: string; line: string }) => void): (() => void) => {
      const l = (_e: unknown, p: { runId: string; line: string }) => cb(p);
      ipcRenderer.on("forge:local-stdout", l);
      return () => ipcRenderer.removeListener("forge:local-stdout", l);
    },
    onStderr: (cb: (payload: { runId: string; line: string }) => void): (() => void) => {
      const l = (_e: unknown, p: { runId: string; line: string }) => cb(p);
      ipcRenderer.on("forge:local-stderr", l);
      return () => ipcRenderer.removeListener("forge:local-stderr", l);
    },
    onError: (cb: (payload: { runId: string; error: string }) => void): (() => void) => {
      const l = (_e: unknown, p: { runId: string; error: string }) => cb(p);
      ipcRenderer.on("forge:local-error", l);
      return () => ipcRenderer.removeListener("forge:local-error", l);
    },
    onExit: (cb: (payload: { runId: string; code: number | null }) => void): (() => void) => {
      const l = (_e: unknown, p: { runId: string; code: number | null }) => cb(p);
      ipcRenderer.on("forge:local-exit", l);
      return () => ipcRenderer.removeListener("forge:local-exit", l);
    },
    onEvalProgress: (cb: (payload: { done: number; total: number }) => void): (() => void) => {
      const l = (_e: unknown, p: { done: number; total: number }) => cb(p);
      ipcRenderer.on("forge:eval-progress", l);
      return () => ipcRenderer.removeListener("forge:eval-progress", l);
    },
  },
});
