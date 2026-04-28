import { contextBridge, ipcRenderer } from "electron";

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
  quantization?: string;
  /** Vision capability (определяется эвристикой по имени в lmstudio-client). */
  vision?: boolean;
  /** Tool-use trained capability (qwen, llama-3+, mistral, и т.д.). */
  trainedForToolUse?: boolean;
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

interface LibraryBookMeta {
  id: string;
  title: string;
  titleEn?: string;
  author?: string;
  authorEn?: string;
  domain?: string;
  tags?: string[];
  wordCount: number;
  status: "imported" | "evaluating" | "evaluated" | "crystallizing" | "indexed" | "failed" | "unsupported";
  year?: number;
  qualityScore?: number;
  isFictionOrWater?: boolean;
  conceptualDensity?: number;
  originality?: number;
  verdictReason?: string;
  evaluatorModel?: string;
  evaluatedAt?: string;
  importedAt: string;
  originalFile: string;
  sourceArchive?: string;
  sphere?: string;
  sha256: string;
  warnings?: string[];
  lastError?: string;
}

interface LibraryCatalogQuery {
  search?: string;
  minQuality?: number;
  maxQuality?: number;
  hideFictionOrWater?: boolean;
  statuses?: Array<"imported" | "evaluating" | "evaluated" | "crystallizing" | "indexed" | "failed" | "unsupported">;
  domain?: string;
  orderBy?: "quality" | "title" | "words" | "evaluated";
  orderDir?: "asc" | "desc";
  limit?: number;
  offset?: number;
}

interface LibraryEvaluatorStatus {
  running: boolean;
  paused: boolean;
  currentBookId: string | null;
  currentTitle: string | null;
  queueLength: number;
  totalEvaluated: number;
  totalFailed: number;
}

function createSmokeLibraryHarness(): {
  rows: LibraryBookMeta[];
  progressCb: ((payload: unknown) => void) | null;
  logCb: ((payload: unknown) => void) | null;
  evaluatorCb: ((payload: unknown) => void) | null;
  importLog: Array<Record<string, unknown>>;
} {
  const now = new Date().toISOString();
  return {
    rows: [
      {
        id: "book-a",
        title: "Cybernetic Predictive Devices",
        titleEn: "Cybernetic Predictive Devices",
        author: "N. Wiener",
        authorEn: "N. Wiener",
        year: 1965,
        domain: "cybernetics",
        wordCount: 12000,
        qualityScore: 92,
        status: "evaluated",
        tags: ["cybernetics", "systems", "prediction"],
        isFictionOrWater: false,
        importedAt: now,
        originalFile: "smoke-book-a.txt",
        sha256: "a".repeat(64),
      },
      {
        id: "book-b",
        title: "Marketing Fog",
        author: "Anon",
        year: 2020,
        domain: "marketing",
        wordCount: 3000,
        qualityScore: 35,
        status: "evaluated",
        tags: ["marketing", "water"],
        isFictionOrWater: true,
        importedAt: now,
        originalFile: "smoke-book-b.txt",
        sha256: "b".repeat(64),
      },
    ],
    progressCb: null,
    logCb: null,
    evaluatorCb: null,
    importLog: [{
      level: "info",
      category: "system.info",
      ts: now,
      importId: "smoke-import",
      message: "Smoke harness online",
    }],
  };
}

const smokeLibrary = process.env.BIBLIARY_SMOKE_UI_HARNESS === "1"
  ? createSmokeLibraryHarness()
  : null;

if (smokeLibrary !== null) {
  console.warn(
    "%c[BIBLIARY SMOKE MODE]%c All library IPC returns FAKE data. " +
      "Set BIBLIARY_SMOKE_UI_HARNESS= (empty) for production.",
    "background:#d97706;color:#fff;padding:2px 6px;border-radius:3px;font-weight:bold;",
    "color:#d97706;font-weight:bold;",
  );
  window.addEventListener("DOMContentLoaded", () => {
    const banner = document.createElement("div");
    banner.id = "bibliary-smoke-banner";
    banner.style.cssText = [
      "position:fixed", "top:0", "left:0", "right:0", "z-index:99999",
      "background:#d97706", "color:#fff", "font-size:11px", "font-family:monospace",
      "padding:3px 12px", "text-align:center", "pointer-events:none",
      "letter-spacing:.03em",
    ].join(";");
    banner.textContent = "⚠ SMOKE MODE — library data is fake (BIBLIARY_SMOKE_UI_HARNESS=1)";
    document.body.prepend(banner);
  });
}

/* Servitor sweep 2026-04-22 (вторая волна, после god+sherlok аудита):
   Удалены 5 dead preload методов и соответствующие IPC handlers:
   - resilience.scanUnfinished + resilience:scan-unfinished
   - resilience.telemetryTail + resilience:telemetry-tail
   - system.curatedModels + system:curated-models (curated JSON используется
     только backend'ом model-profile/dataset-v2, не renderer'ом)
   - chatHistory.clear + chat-history:clear (UI кнопки нет; load/save живут)
   - forge.listRuns + forge:list-runs (нет management UI)
   Оставлены: forge.genConfig (документирован как public API в FINE-TUNING.md),
   resilience.onLmstudioOffline/Online (active в resilience-bar.js),
   все *.ipc.ts экспорты abortAll* для shutdown-hook. */
contextBridge.exposeInMainWorld("api", {
  /** True when BIBLIARY_SMOKE_UI_HARNESS=1 — all library IPC returns fake data. */
  smokeMode: smokeLibrary !== null,
  getCollections: (): Promise<string[]> => ipcRenderer.invoke("qdrant:collections"),

  qdrant: {
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
  },

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
    /** Доступен ли активный backup (значит можно revert). */
    hasBackup: (modelKey: string): Promise<boolean> => ipcRenderer.invoke("yarn:has-backup", modelKey),
  },

  system: {
    hardware: (force?: boolean): Promise<unknown> =>
      ipcRenderer.invoke("system:hardware-info", { force: force === true }),
    /** Параллельный health-check LM Studio + Qdrant для onboarding wizard. */
    probeServices: (): Promise<{
      lmStudio: { online: boolean; version?: string; url: string };
      qdrant: { online: boolean; version?: string; url: string };
    }> => ipcRenderer.invoke("system:probe-services"),
    /** Открыть внешний URL (http/https/lmstudio://) в системном браузере. */
    openExternal: (url: string): Promise<{ ok: boolean; reason?: string }> =>
      ipcRenderer.invoke("system:open-external", url),
  },

  profile: {
    list: (): Promise<unknown[]> => ipcRenderer.invoke("profile:list"),
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
    onChanged: (callback: (prefs: Record<string, unknown>) => void): (() => void) => {
      const listener = (_event: Electron.IpcRendererEvent, prefs: Record<string, unknown>) => callback(prefs);
      ipcRenderer.on("preferences:changed", listener);
      return () => ipcRenderer.removeListener("preferences:changed", listener);
    },
  },

  modelRoles: {
    list: (roles?: string[]): Promise<Array<{
      role: string;
      prefKey: string;
      fallbackKey: string | null;
      required: string[];
      preferred: string[];
      resolved: { modelKey: string; source: string; usedFallback?: boolean } | null;
    }>> => ipcRenderer.invoke("model-roles:list", roles ? { roles } : {}),
  },

  arena: {
    /** Получить Elo по всем ролям + lastCycleAt + lastError. */
    getRatings: (): Promise<{
      roles: Record<string, Record<string, number>>;
      chat: Record<string, number>;
      lastCycleAt?: string;
      lastError?: string;
    }> => ipcRenderer.invoke("arena:get-ratings"),
    /** Запустить cycle. opts.roles — подмножество ролей; opts.manual — ручной запуск даже при выключенном background arena. */
    runCycle: (opts?: { roles?: string[]; bypassLock?: boolean; manual?: boolean }): Promise<{
      ok: boolean;
      message: string;
      skipped?: boolean;
      skipReasons?: string[];
      perRole?: Array<{ role: string; matches: number; results: string[]; ratings: Record<string, number>; skipped?: string }>;
    }> => ipcRenderer.invoke("arena:run-cycle", opts ?? {}),
    /** Обнулить Elo. Возвращает пустой ratings файл. */
    resetRatings: (): Promise<{ version: number; roles: Record<string, Record<string, number>> }> =>
      ipcRenderer.invoke("arena:reset-ratings"),
    /** Текущая конфигурация arena (из preferences). */
    getConfig: (): Promise<{
      arenaEnabled: boolean;
      arenaUseLlmJudge: boolean;
      arenaAutoPromoteWinner: boolean;
      arenaMatchPairsPerCycle: number;
      arenaCycleIntervalMs: number;
      arenaJudgeModelKey: string;
    }> => ipcRenderer.invoke("arena:get-config"),
    /** Частично обновить конфигурацию. Возвращает обновлённую конфигурацию. */
    setConfig: (partial: Record<string, unknown>): Promise<{
      arenaEnabled: boolean;
      arenaUseLlmJudge: boolean;
      arenaAutoPromoteWinner: boolean;
      arenaMatchPairsPerCycle: number;
      arenaCycleIntervalMs: number;
      arenaJudgeModelKey: string;
    }> => ipcRenderer.invoke("arena:set-config", partial),
    /** Состояние GlobalLlmLock — занят ли LM Studio импортом / evaluator. */
    getLockStatus: (): Promise<{
      busy: boolean;
      reasons: string[];
      skipCount: number;
      lastSkippedAt: string | null;
      lastSkipReasons: string[];
      registeredProbes: string[];
    }> => ipcRenderer.invoke("arena:get-lock-status"),
  },

  chatHistory: {
    load: (): Promise<Array<{ role: "user" | "assistant" | "system"; content: string }>> =>
      ipcRenderer.invoke("chat-history:load"),
    save: (messages: Array<{ role: string; content: string }>): Promise<{ saved: number }> =>
      ipcRenderer.invoke("chat-history:save", messages),
  },

  forge: {
    listSourceBatches: (): Promise<string[]> => ipcRenderer.invoke("forge:list-source-batches"),
    nextRunId: (): Promise<string> => ipcRenderer.invoke("forge:next-run-id"),
    previewSource: (sourcePath: string): Promise<unknown> => ipcRenderer.invoke("forge:preview-source", sourcePath),
    prepare: (args: { spec: unknown; sourcePath: string; trainRatio?: number; evalRatio?: number; seed?: number }): Promise<unknown> =>
      ipcRenderer.invoke("forge:prepare", args),
    generateBundle: (args: { spec: unknown; runId: string; target: string }): Promise<unknown> =>
      ipcRenderer.invoke("forge:generate-bundle", args),
    genConfig: (args: { spec: unknown; kind: "unsloth" | "axolotl" }): Promise<{ content: string; ext: string }> =>
      ipcRenderer.invoke("forge:gen-config", args),
    openBundleFolder: (runId: string): Promise<string> => ipcRenderer.invoke("forge:open-bundle-folder", runId),
    markStatus: (runId: string, status: string): Promise<unknown> =>
      ipcRenderer.invoke("forge:mark-status", { runId, status }),
  },

  wsl: {
    detect: (): Promise<unknown> => ipcRenderer.invoke("wsl:detect"),
  },

  scanner: {
    probeFolder: (): Promise<Array<{ absPath: string; fileName: string; ext: string; sizeBytes: number; mtimeMs: number }>> =>
      ipcRenderer.invoke("scanner:probe-folder"),
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
      /** Multiturn-история диалога (без текущего userMessage). Cap ~50 в UI. */
      history?: Array<{ role: "user" | "assistant"; content: string }>;
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
      /** Имя Qdrant-коллекции для тематической изоляции принятых концептов. */
      targetCollection?: string;
    }): Promise<{
      jobId: string;
      bookTitle: string;
      totalChapters: number;
      processedChapters: number;
      totalDelta: { chunks: number; accepted: number; skipped: number };
      warnings: string[];
    }> => ipcRenderer.invoke("dataset-v2:start-extraction", args),
    /** Multi-book батч из Library: guard'ит по quality_score и is_fiction_or_water. */
    startBatch: (args: {
      bookIds: string[];
      minQuality?: number;
      skipFictionOrWater?: boolean;
      extractModel?: string;
      /** Тематическая Qdrant-коллекция для всех книг батча. */
      targetCollection?: string;
    }): Promise<{
      batchId: string;
      total: number;
      processed: number;
      skipped: Array<{ bookId: string; reason: string }>;
      results: Array<{
        bookId: string;
        bookTitle: string;
        totalChapters: number;
        processedChapters: number;
        accepted: number;
        skipped: number;
      }>;
    }> => ipcRenderer.invoke("dataset-v2:start-batch", args),
    cancel: (jobId: string): Promise<boolean> => ipcRenderer.invoke("dataset-v2:cancel", jobId),
    /** Iter 7: прерывает весь батч-цикл (все оставшиеся книги). */
    cancelBatch: (batchId: string): Promise<boolean> => ipcRenderer.invoke("dataset-v2:cancel-batch", batchId),
    listAccepted: (
      collection?: string,
    ): Promise<{ total: number; byDomain: Record<string, number>; collection: string }> =>
      ipcRenderer.invoke("dataset-v2:list-accepted", collection),
    rejectAccepted: (conceptId: string, collection?: string): Promise<boolean> =>
      ipcRenderer.invoke("dataset-v2:reject-accepted", conceptId, collection),
    /**
     * Iter 9: запускает фон-синтез датасета (Qdrant collection → ChatML JSONL)
     * через child-process scripts/dataset-synth.ts. Вернёт сразу с pid и logPath
     * (UI отслеживает прогресс через лог-файл, чтобы не блокировать main thread
     * на 60+ минутный LLM-marathon).
     */
    synthesize: (args: {
      collection: string;
      outputPath: string;
      pairsPerConcept?: number;
      includeReasoning?: boolean;
      preset?: string;
      model?: string;
      limit?: number;
    }): Promise<{ ok: boolean; pid?: number; logPath?: string; error?: string }> =>
      ipcRenderer.invoke("dataset-v2:synthesize", args),
    onEvent: (cb: (payload: { jobId?: string; batchId?: string; stage: string; [k: string]: unknown }) => void): (() => void) => {
      const l = (_e: unknown, p: { jobId?: string; batchId?: string; stage: string; [k: string]: unknown }) => cb(p);
      ipcRenderer.on("dataset-v2:event", l);
      return () => ipcRenderer.removeListener("dataset-v2:event", l);
    },
  },

  library: {
    pickFolder: (): Promise<string | null> =>
      smokeLibrary ? Promise.resolve("smoke-folder") : ipcRenderer.invoke("library:pick-folder"),
    pickFiles: (): Promise<string[] | { paths: string[] }> =>
      smokeLibrary ? Promise.resolve({ paths: ["smoke-book.txt"] }) : ipcRenderer.invoke("library:pick-files"),
    importFolder: (args: {
      folder: string;
      scanArchives?: boolean;
      ocrEnabled?: boolean;
      maxDepth?: number;
    }): Promise<{
      importId: string;
      total: number;
      added: number;
      duplicate: number;
      skipped: number;
      failed: number;
      warnings: string[];
      durationMs: number;
    }> => smokeLibrary
      ? Promise.resolve({ importId: "smoke-import", total: 1, added: 1, duplicate: 0, skipped: 0, failed: 0, warnings: [], durationMs: 1 })
      : ipcRenderer.invoke("library:import-folder", args),
    importFiles: (args: {
      paths: string[];
      scanArchives?: boolean;
      ocrEnabled?: boolean;
    }): Promise<{
      importId: string;
      total: number;
      added: number;
      duplicate: number;
      skipped: number;
      failed: number;
      warnings: string[];
    }> => {
      if (!smokeLibrary) return ipcRenderer.invoke("library:import-files", args);
      const progress = { importId: "smoke-import", phase: "processed", discovered: 1, processed: 1, outcome: "added", index: 1, total: 1 };
      smokeLibrary.progressCb?.(progress);
      const log = {
        level: "info",
        category: "file.added",
        ts: new Date().toISOString(),
        importId: "smoke-import",
        message: "Imported smoke-book.txt",
        file: "smoke-book.txt",
      };
      smokeLibrary.importLog.push(log);
      smokeLibrary.logCb?.(log);
      return Promise.resolve({ importId: "smoke-import", total: 1, added: 1, duplicate: 0, skipped: 0, failed: 0, warnings: [] });
    },
    cancelImport: (importId: string): Promise<boolean> =>
      smokeLibrary ? Promise.resolve(true) : ipcRenderer.invoke("library:cancel-import", importId),
    catalog: (q?: LibraryCatalogQuery): Promise<{ rows: LibraryBookMeta[]; total: number; libraryRoot: string; dbPath: string }> =>
      smokeLibrary
        ? Promise.resolve({ rows: smokeLibrary.rows, total: smokeLibrary.rows.length, libraryRoot: "smoke-library", dbPath: "smoke.db" })
        : ipcRenderer.invoke("library:catalog", q ?? {}),
    tagStats: (): Promise<{ tag: string; count: number }[]> =>
      smokeLibrary
        ? Promise.resolve([{ tag: "cybernetics", count: 1 }, { tag: "systems", count: 1 }, { tag: "marketing", count: 1 }])
        : ipcRenderer.invoke("library:tag-stats"),
    collectionByDomain: (): Promise<Array<{ label: string; count: number; bookIds: string[] }>> =>
      smokeLibrary ? Promise.resolve([]) : ipcRenderer.invoke("library:collection-by-domain"),
    collectionByAuthor: (): Promise<Array<{ label: string; count: number; bookIds: string[] }>> =>
      smokeLibrary ? Promise.resolve([]) : ipcRenderer.invoke("library:collection-by-author"),
    collectionByYear: (): Promise<Array<{ label: string; count: number; bookIds: string[] }>> =>
      smokeLibrary ? Promise.resolve([]) : ipcRenderer.invoke("library:collection-by-year"),
    collectionBySphere: (): Promise<Array<{ label: string; count: number; bookIds: string[] }>> =>
      smokeLibrary ? Promise.resolve([]) : ipcRenderer.invoke("library:collection-by-sphere"),
    collectionByTag: (): Promise<Array<{ label: string; count: number; bookIds: string[] }>> =>
      smokeLibrary ? Promise.resolve([]) : ipcRenderer.invoke("library:collection-by-tag"),
    getBook: (bookId: string): Promise<(LibraryBookMeta & { mdPath: string }) | null> =>
      smokeLibrary
        ? Promise.resolve((smokeLibrary.rows.find((row) => row.id === bookId) as LibraryBookMeta & { mdPath: string } | undefined) ?? null)
        : ipcRenderer.invoke("library:get-book", bookId),
    readBookMd: (bookId: string): Promise<{ markdown: string; mdPath: string } | null> =>
      smokeLibrary
        ? Promise.resolve({ markdown: "---\ntitle: Cybernetic Predictive Devices\n---\n# Cybernetic Predictive Devices\nSmoke reader body.", mdPath: "smoke.md" })
        : ipcRenderer.invoke("library:read-book-md", bookId),
    deleteBook: (bookId: string, deleteFiles?: boolean): Promise<{ ok: boolean; reason?: string }> =>
      smokeLibrary
        ? Promise.resolve({ ok: true }).then((res) => {
          smokeLibrary.rows = smokeLibrary.rows.filter((row) => row.id !== bookId);
          return res;
        })
        : ipcRenderer.invoke("library:delete-book", { bookId, deleteFiles }),
    rebuildCache: (): Promise<{ scanned: number; ingested: number; skipped: number; pruned: number; errors: string[] }> =>
      smokeLibrary ? Promise.resolve({ scanned: smokeLibrary.rows.length, ingested: smokeLibrary.rows.length, skipped: 0, pruned: 0, errors: [] }) : ipcRenderer.invoke("library:rebuild-cache"),
    evaluatorStatus: (): Promise<LibraryEvaluatorStatus> =>
      smokeLibrary ? Promise.resolve({ running: false, paused: false, currentBookId: null, currentTitle: null, queueLength: 0, totalEvaluated: 0, totalFailed: 0 }) : ipcRenderer.invoke("library:evaluator-status"),
    evaluatorPause: (): Promise<boolean> => smokeLibrary ? Promise.resolve(true) : ipcRenderer.invoke("library:evaluator-pause"),
    evaluatorResume: (): Promise<boolean> => smokeLibrary ? Promise.resolve(true) : ipcRenderer.invoke("library:evaluator-resume"),
    evaluatorCancelCurrent: (): Promise<boolean> => smokeLibrary ? Promise.resolve(true) : ipcRenderer.invoke("library:evaluator-cancel-current"),
    reevaluate: (bookId: string): Promise<{ ok: boolean; reason?: string }> =>
      smokeLibrary ? Promise.resolve({ ok: true }) : ipcRenderer.invoke("library:evaluator-reevaluate", { bookId }),
    reevaluateAll: (): Promise<{ queued: number }> =>
      smokeLibrary ? Promise.resolve({ queued: smokeLibrary.rows.length }) : ipcRenderer.invoke("library:reevaluate-all"),
    setEvaluatorModel: (modelKey: string | null): Promise<boolean> =>
      smokeLibrary ? Promise.resolve(true) : ipcRenderer.invoke("library:evaluator-set-model", modelKey),
    /* Phase 4: priority enqueue + runtime slot regulation. */
    evaluatorPrioritize: (bookIds: string[]): Promise<{ ok: boolean; queued: number }> =>
      smokeLibrary ? Promise.resolve({ ok: true, queued: 0 }) : ipcRenderer.invoke("library:evaluator-prioritize", { bookIds }),
    evaluatorSetSlots: (n: number): Promise<{ ok: boolean; slots: number }> =>
      smokeLibrary ? Promise.resolve({ ok: true, slots: n }) : ipcRenderer.invoke("library:evaluator-set-slots", n),
    evaluatorGetSlots: (): Promise<number> =>
      smokeLibrary ? Promise.resolve(2) : ipcRenderer.invoke("library:evaluator-get-slots"),
    reparseBook: (bookId: string): Promise<{ ok: boolean; chapters?: number; reason?: string }> =>
      smokeLibrary ? Promise.resolve({ ok: true, chapters: 1 }) : ipcRenderer.invoke("library:reparse-book", bookId),
    onImportProgress: (cb: (payload: {
      importId: string;
      phase: "discovered" | "processed" | "scan-complete";
      discovered: number;
      processed: number;
      currentFile?: string;
      outcome?: "added" | "duplicate" | "skipped" | "failed";
      duplicateReason?: "duplicate_sha" | "duplicate_isbn" | "duplicate_older_revision";
      existingBookId?: string;
      existingBookTitle?: string;
      errorMessage?: string;
      fileWarnings?: string[];
      /** Backward-compat: для старого UI = processed/discovered. */
      index: number;
      total: number;
    }) => void): (() => void) => {
      if (smokeLibrary) {
        smokeLibrary.progressCb = cb as (payload: unknown) => void;
        return () => { smokeLibrary.progressCb = null; };
      }
      const l = (_e: unknown, p: {
        importId: string;
        phase: "discovered" | "processed" | "scan-complete";
        discovered: number;
        processed: number;
        currentFile?: string;
        outcome?: "added" | "duplicate" | "skipped" | "failed";
        duplicateReason?: "duplicate_sha" | "duplicate_isbn" | "duplicate_older_revision";
        existingBookId?: string;
        existingBookTitle?: string;
        errorMessage?: string;
        fileWarnings?: string[];
        index: number;
        total: number;
      }) => cb(p);
      ipcRenderer.on("library:import-progress", l);
      return () => ipcRenderer.removeListener("library:import-progress", l);
    },
    onImportLog: (cb: (entry: {
      ts: string;
      importId: string;
      level: "debug" | "info" | "warn" | "error";
      category: string;
      message: string;
      file?: string;
      details?: Record<string, unknown>;
      durationMs?: number;
    }) => void): (() => void) => {
      if (smokeLibrary) {
        smokeLibrary.logCb = cb as (payload: unknown) => void;
        return () => { smokeLibrary.logCb = null; };
      }
      const l = (_e: unknown, entry: {
        ts: string;
        importId: string;
        level: "debug" | "info" | "warn" | "error";
        category: string;
        message: string;
        file?: string;
        details?: Record<string, unknown>;
        durationMs?: number;
      }) => cb(entry);
      ipcRenderer.on("library:import-log", l);
      return () => ipcRenderer.removeListener("library:import-log", l);
    },
    importLogSnapshot: (): Promise<Array<{
      ts: string;
      importId: string;
      level: "debug" | "info" | "warn" | "error";
      category: string;
      message: string;
      file?: string;
      details?: Record<string, unknown>;
      durationMs?: number;
    }>> => smokeLibrary
      ? Promise.resolve(smokeLibrary.importLog as Array<{
        ts: string;
        importId: string;
        level: "debug" | "info" | "warn" | "error";
        category: string;
        message: string;
        file?: string;
        details?: Record<string, unknown>;
        durationMs?: number;
      }>)
      : ipcRenderer.invoke("library:import-log-snapshot"),
    onEvaluatorEvent: (cb: (payload: {
      type: string;
      bookId?: string;
      title?: string;
      qualityScore?: number;
      isFictionOrWater?: boolean;
      warnings?: string[];
      error?: string;
      remaining?: number;
    }) => void): (() => void) => {
      if (smokeLibrary) {
        smokeLibrary.evaluatorCb = cb as (payload: unknown) => void;
        return () => { smokeLibrary.evaluatorCb = null; };
      }
      const l = (_e: unknown, p: {
        type: string;
        bookId?: string;
        title?: string;
        qualityScore?: number;
        isFictionOrWater?: boolean;
        warnings?: string[];
        error?: string;
        remaining?: number;
      }) => cb(p);
      ipcRenderer.on("library:evaluator-event", l);
      return () => ipcRenderer.removeListener("library:evaluator-event", l);
    },
    scanFolder: (folder: string): Promise<{ scanId: string }> =>
      smokeLibrary ? Promise.resolve({ scanId: "scan-smoke" }) : ipcRenderer.invoke("library:scan-folder", { folder }),
    cancelScan: (scanId: string): Promise<boolean> =>
      smokeLibrary ? Promise.resolve(true) : ipcRenderer.invoke("library:cancel-scan", scanId),
    onScanProgress: (cb: (payload: {
      scanId: string;
      phase: "walking" | "metadata" | "dedup" | "done";
      scannedFiles: number;
      totalFiles: number;
      bookFilesFound: number;
      currentFile?: string;
    }) => void): (() => void) => {
      if (smokeLibrary) return () => {};
      const l = (_e: unknown, p: Parameters<typeof cb>[0]) => cb(p);
      ipcRenderer.on("library:scan-progress", l);
      return () => ipcRenderer.removeListener("library:scan-progress", l);
    },
    onScanReport: (cb: (payload: {
      scanId: string;
      report?: unknown;
      error?: string;
    }) => void): (() => void) => {
      if (smokeLibrary) return () => {};
      const l = (_e: unknown, p: Parameters<typeof cb>[0]) => cb(p);
      ipcRenderer.on("library:scan-report", l);
      return () => ipcRenderer.removeListener("library:scan-report", l);
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
