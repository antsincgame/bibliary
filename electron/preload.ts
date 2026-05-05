import { contextBridge, ipcRenderer } from "electron";

interface LoadedModelInfo {
  identifier: string;
  modelKey: string;
  contextLength?: number;
  quantization?: string;
  vision?: boolean;
  trainedForToolUse?: boolean;
}

interface DownloadedModelInfo {
  modelKey: string;
  displayName?: string;
  format?: string;
  paramsString?: string;
  sizeBytes?: number;
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

interface LibraryBookMeta {
  id: string;
  title: string;
  titleRu?: string;
  authorRu?: string;
  titleEn?: string;
  author?: string;
  authorEn?: string;
  domain?: string;
  tags?: string[];
  tagsRu?: string[];
  wordCount: number;
  status: "imported" | "layout-cleaning" | "evaluating" | "evaluated" | "crystallizing" | "indexed" | "failed" | "unsupported";
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
  statuses?: Array<"imported" | "layout-cleaning" | "evaluating" | "evaluated" | "crystallizing" | "indexed" | "failed" | "unsupported">;
  domain?: string;
  displayLocale?: "ru" | "en";
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

contextBridge.exposeInMainWorld("api", {
  smokeMode: smokeLibrary !== null,

  getCollections: (): Promise<string[]> => ipcRenderer.invoke("qdrant:collections"),

  qdrant: {
    listDetailed: (): Promise<QdrantCollectionsListItem[]> =>
      ipcRenderer.invoke("qdrant:collections-detailed"),
    info: (name: string): Promise<QdrantCollectionInfo | null> =>
      ipcRenderer.invoke("qdrant:collection-info", name),
    create: (
      args: {
        name: string;
        vectorSize?: number;
        distance?: "Cosine" | "Euclid" | "Dot";
      }
    ): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke("qdrant:create-collection", args),
    remove: (name: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke("qdrant:delete-collection", name),
    cluster: (): Promise<QdrantClusterInfo> => ipcRenderer.invoke("qdrant:cluster-info"),
  },

  lmstudio: {
    status: (): Promise<ServerStatus> => ipcRenderer.invoke("lmstudio:status"),
    listDownloaded: (): Promise<DownloadedModelInfo[]> => ipcRenderer.invoke("lmstudio:list-downloaded"),
    listLoaded: (): Promise<LoadedModelInfo[]> => ipcRenderer.invoke("lmstudio:list-loaded"),
    load: (
      modelKey: string,
      opts?: { contextLength?: number; ttlSec?: number; gpuOffload?: "max" | number }
    ): Promise<LoadedModelInfo> => ipcRenderer.invoke("lmstudio:load", modelKey, opts ?? {}),
    unload: (identifier: string): Promise<void> => ipcRenderer.invoke("lmstudio:unload", identifier),
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
    /**
     * VRAM pressure event от lmstudio-watchdog (Итерация 2).
     * Эмитится когда totalLoadedMB / capacityMB > 0.85 (default threshold).
     * payload: { totalLoadedMB, capacityMB, pressureRatio, loadedModels }.
     */
    onLmstudioPressure: (callback: (snapshot: {
      totalLoadedMB: number;
      capacityMB: number;
      pressureRatio: number;
      loadedModels: number;
    }) => void): (() => void) => {
      const listener = (_e: unknown, payload: {
        totalLoadedMB: number;
        capacityMB: number;
        pressureRatio: number;
        loadedModels: number;
      }): void => callback(payload);
      ipcRenderer.on("resilience:lmstudio-pressure", listener);
      return () => ipcRenderer.removeListener("resilience:lmstudio-pressure", listener);
    },
    /**
     * Scheduler snapshot периодически эмитится из bootstrap (Итерация 5).
     * Показывает текущее состояние lanes: light/medium/heavy с running/queued.
     * payload: SchedulerSnapshot из import-task-scheduler.ts.
     */
    /**
     * Иt 8В MAIN.4: ModelPool snapshot — какие модели в VRAM, какие роли занимают.
     * channel: "resilience:model-pool-snapshot"
     * payload: ModelPoolSnapshotPayload (см. model-pool-snapshot-broadcaster.ts).
     */
    onModelPoolSnapshot: (callback: (snapshot: {
      capacityMB: number;
      totalLoadedMB: number;
      loadedCount: number;
      models: ReadonlyArray<{
        modelKey: string;
        role?: string;
        weight: "light" | "medium" | "heavy";
        refCount: number;
        vramMB: number;
        source: "pool" | "external";
      }>;
    }) => void): (() => void) => {
      const listener = (_e: unknown, payload: {
        capacityMB: number;
        totalLoadedMB: number;
        loadedCount: number;
        models: ReadonlyArray<{
          modelKey: string;
          role?: string;
          weight: "light" | "medium" | "heavy";
          refCount: number;
          vramMB: number;
          source: "pool" | "external";
        }>;
      }): void => callback(payload);
      ipcRenderer.on("resilience:model-pool-snapshot", listener);
      return () => ipcRenderer.removeListener("resilience:model-pool-snapshot", listener);
    },

    onSchedulerSnapshot: (callback: (snapshot: {
      light: { running: number; queued: number };
      medium: { running: number; queued: number };
      heavy: { running: number; queued: number };
    }) => void): (() => void) => {
      const listener = (_e: unknown, payload: {
        light: { running: number; queued: number };
        medium: { running: number; queued: number };
        heavy: { running: number; queued: number };
      }): void => callback(payload);
      ipcRenderer.on("resilience:scheduler-snapshot", listener);
      return () => ipcRenderer.removeListener("resilience:scheduler-snapshot", listener);
    },
  },

  system: {
    hardware: (force?: boolean): Promise<unknown> =>
      ipcRenderer.invoke("system:hardware-info", { force: force === true }),
    probeServices: (): Promise<{
      lmStudio: { online: boolean; version?: string; url: string };
      qdrant: { online: boolean; version?: string; url: string };
    }> => ipcRenderer.invoke("system:probe-services"),
    openExternal: (url: string): Promise<{ ok: boolean; reason?: string }> =>
      ipcRenderer.invoke("system:open-external", url),
    appVersion: (): Promise<{
      version: string;
      commit: string | null;
      builtAt: string | null;
      electron: string;
      isPackaged: boolean;
    }> => ipcRenderer.invoke("system:app-version"),
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
    /** Получить готовый профиль (whitelisted ключи) для скачивания blob'ом. */
    getProfile: (): Promise<{
      schema: string;
      exportedAt: string;
      app: { name: string; version?: string };
      profile: Record<string, unknown>;
    }> => ipcRenderer.invoke("preferences:get-profile"),
    /** Экспорт профиля через нативный Save dialog. */
    exportProfile: (): Promise<{ path: string | null }> =>
      ipcRenderer.invoke("preferences:export-profile"),
    /** Импорт профиля через нативный Open dialog. */
    importProfile: (): Promise<{
      path: string | null;
      appliedKeys: string[];
      prefs: Record<string, unknown>;
    }> => ipcRenderer.invoke("preferences:import-profile"),
    /** Применить уже распарсенный профиль (для drag&drop или undo). */
    applyProfile: (profile: Record<string, unknown>): Promise<{
      appliedKeys: string[];
      prefs: Record<string, unknown>;
    }> => ipcRenderer.invoke("preferences:apply-profile", profile),
  },

  modelRoles: {
    list: (roles?: string[]): Promise<Array<{
      role: string;
      prefKey: string;
      fallbackKey: string | null;
      required: string[];
      preferred: string[];
      resolved: { modelKey: string; source: string; usedFallback?: boolean } | null;
      prefValue: string;
    }>> => ipcRenderer.invoke("model-roles:list", roles ? { roles } : {}),
  },

  arena: {
    /* Shadow Arena (Elo + golden prompts) удалена в apr 2026.
     * Bridge оставляет имя `arena` для backward-compat с models-page.js. */
    getLockStatus: (): Promise<{ busy: boolean; reasons: string[] }> =>
      ipcRenderer.invoke("arena:get-lock-status"),
    runOlympics: (opts?: {
      models?: string[];
      disciplines?: string[];
      maxModels?: number;
      weightClasses?: string[];
      testAll?: boolean;
      roles?: string[];
    }): Promise<unknown> =>
      ipcRenderer.invoke("arena:run-olympics", opts ?? {}),
    cancelOlympics: (): Promise<boolean> => ipcRenderer.invoke("arena:cancel-olympics"),
    clearOlympicsCache: (): Promise<unknown> => ipcRenderer.invoke("arena:clear-olympics-cache"),
    getLastReport: (): Promise<unknown> => ipcRenderer.invoke("arena:get-last-report"),
    applyOlympicsRecommendations: (payload: { recommendations: Record<string, string> }): Promise<unknown> =>
      ipcRenderer.invoke("arena:apply-olympics-recommendations", payload),
    onOlympicsProgress: (cb: (e: unknown) => void): (() => void) => {
      const listener = (_: unknown, data: unknown): void => cb(data);
      ipcRenderer.on("arena:olympics-progress", listener);
      return () => ipcRenderer.off("arena:olympics-progress", listener);
    },
    /* Custom Olympics disciplines (Iter 14.3 / 2026-05-05). */
    customDisciplines: {
      list: (): Promise<unknown[]> => ipcRenderer.invoke("arena:list-custom-disciplines"),
      save: (payload: unknown): Promise<unknown> => ipcRenderer.invoke("arena:save-custom-discipline", payload),
      delete: (id: string): Promise<{ ok: boolean; deleted: boolean }> =>
        ipcRenderer.invoke("arena:delete-custom-discipline", { id }),
      saveImage: (payload: { disciplineId: string; base64: string; ext: string }): Promise<{ imageRef: string }> =>
        ipcRenderer.invoke("arena:save-discipline-image", payload),
      getImage: (imageRef: string): Promise<{ dataUrl: string | null }> =>
        ipcRenderer.invoke("arena:get-discipline-image", { imageRef }),
    },
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
    startFolderBundle: (args: { folderPath: string; collection: string }): Promise<{
      ingestId: string;
      bundleStats: { sidecars: number; described: number; warnings: string[] };
    }> => ipcRenderer.invoke("scanner:start-folder-bundle", args),
    onBundleProgress: (cb: (payload: unknown) => void): (() => void) => {
      const l = (_e: unknown, p: unknown): void => cb(p);
      ipcRenderer.on("scanner:bundle-progress", l);
      return () => ipcRenderer.removeListener("scanner:bundle-progress", l);
    },
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
      collection: string,
      bookId?: string
    ): Promise<{ deleted: boolean; pointsDeleted: number }> =>
      ipcRenderer.invoke("scanner:delete-from-collection", { bookSourcePath, collection, bookId }),
    onProgress: (cb: (payload: { ingestId: string; phase: string; bookSourcePath: string; bookTitle: string; totalChunks: number; processedChunks: number; embeddedChunks: number; upsertedChunks: number; message?: string; errorMessage?: string }) => void): (() => void) => {
      const l = (_e: unknown, p: { ingestId: string; phase: string; bookSourcePath: string; bookTitle: string; totalChunks: number; processedChunks: number; embeddedChunks: number; upsertedChunks: number; message?: string; errorMessage?: string }) => cb(p);
      ipcRenderer.on("scanner:ingest-progress", l);
      return () => ipcRenderer.removeListener("scanner:ingest-progress", l);
    },
  },


  datasetV2: {
    /* startExtraction (single-book) удалён из preload (Iter 8А) — UI всегда
       использует startBatch (catalog crystallize button). IPC handler
       `dataset-v2:start-extraction` сохранён для legacy CLI / scripts. */
    startBatch: (args: {
      bookIds: string[];
      minQuality?: number;
      skipFictionOrWater?: boolean;
      extractModel?: string;
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
    cancelBatch: (batchId: string): Promise<boolean> => ipcRenderer.invoke("dataset-v2:cancel-batch", batchId),
    listAccepted: (
      collection?: string,
    ): Promise<{ total: number; byDomain: Record<string, number>; collection: string }> =>
      ipcRenderer.invoke("dataset-v2:list-accepted", collection),
    rejectAccepted: (conceptId: string, collection?: string): Promise<boolean> =>
      ipcRenderer.invoke("dataset-v2:reject-accepted", conceptId, collection),
    synthesize: (args: {
      collection: string;
      outputDir: string;
      format: "sharegpt" | "chatml";
      pairsPerConcept: number;
      model: string;
      trainRatio?: number;
      limit?: number;
    }): Promise<{
      ok: boolean;
      jobId?: string;
      error?: string;
      stats?: {
        concepts: number;
        byDomain: Record<string, number>;
        totalLines: number;
        trainLines: number;
        valLines: number;
        outputDir: string;
        format: "sharegpt" | "chatml";
        files: string[];
        llmFailures: number;
        schemaFailures: number;
        emptyPayloadSkips: number;
        rawSamples?: Array<{ conceptId: string; reason: string; raw: string }>;
        model: string;
        durationMs: number;
      };
    }> => ipcRenderer.invoke("dataset-v2:synthesize", args),
    pickExportDir: (): Promise<string | null> => ipcRenderer.invoke("dataset-v2:pick-export-dir"),
    openFolder: (dirPath: string): Promise<boolean> => ipcRenderer.invoke("dataset-v2:open-folder", dirPath),
    exportDataset: (args: {
      collection: string;
      outputDir: string;
      format: "sharegpt" | "chatml";
      pairsPerConcept: number;
      trainRatio?: number;
      limit?: number;
    }): Promise<{
      ok: boolean;
      error?: string;
      stats?: {
        concepts: number;
        totalLines: number;
        trainLines: number;
        valLines: number;
        outputDir: string;
        format: "sharegpt" | "chatml";
        files: string[];
        byDomain: Record<string, number>;
      };
    }> => ipcRenderer.invoke("dataset-v2:export-dataset", args),
    onEvent: (cb: (payload: { jobId?: string; batchId?: string; stage: string; [k: string]: unknown }) => void): (() => void) => {
      const l = (_e: unknown, p: { jobId?: string; batchId?: string; stage: string; [k: string]: unknown }) => cb(p);
      ipcRenderer.on("dataset-v2:event", l);
      return () => ipcRenderer.removeListener("dataset-v2:event", l);
    },
  },

  datasets: {
    readMeta: (
      dirPath: string,
    ): Promise<{
      ok: boolean;
      error?: string;
      meta?: Record<string, unknown>;
      files?: Array<{ name: string; sizeBytes: number; lines?: number }>;
      outputDir?: string;
    }> => ipcRenderer.invoke("datasets:read-meta", dirPath),
    readJsonlHead: (args: {
      filePath: string;
      limit?: number;
    }): Promise<{
      ok: boolean;
      error?: string;
      lines?: Array<{ raw: string; parsed: unknown | null }>;
    }> => ipcRenderer.invoke("datasets:read-jsonl-head", args),
    pickFolder: (): Promise<string | null> => ipcRenderer.invoke("datasets:pick-folder"),
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
    tagStats: (locale?: string): Promise<{ tag: string; count: number }[]> =>
      smokeLibrary
        ? Promise.resolve([{ tag: "cybernetics", count: 1 }, { tag: "systems", count: 1 }, { tag: "marketing", count: 1 }])
        : ipcRenderer.invoke("library:tag-stats", locale),
    collectionByDomain: (): Promise<Array<{ label: string; count: number; bookIds: string[] }>> =>
      smokeLibrary ? Promise.resolve([]) : ipcRenderer.invoke("library:collection-by-domain"),
    collectionByAuthor: (locale?: string): Promise<Array<{ label: string; count: number; bookIds: string[] }>> =>
      smokeLibrary ? Promise.resolve([]) : ipcRenderer.invoke("library:collection-by-author", locale),
    collectionByYear: (): Promise<Array<{ label: string; count: number; bookIds: string[] }>> =>
      smokeLibrary ? Promise.resolve([]) : ipcRenderer.invoke("library:collection-by-year"),
    collectionBySphere: (): Promise<Array<{ label: string; count: number; bookIds: string[] }>> =>
      smokeLibrary ? Promise.resolve([]) : ipcRenderer.invoke("library:collection-by-sphere"),
    collectionByTag: (locale?: string): Promise<Array<{ label: string; count: number; bookIds: string[] }>> =>
      smokeLibrary ? Promise.resolve([]) : ipcRenderer.invoke("library:collection-by-tag", locale),
    getBook: (bookId: string): Promise<(LibraryBookMeta & { mdPath: string }) | null> =>
      smokeLibrary
        ? Promise.resolve((smokeLibrary.rows.find((row) => row.id === bookId) as LibraryBookMeta & { mdPath: string } | undefined) ?? null)
        : ipcRenderer.invoke("library:get-book", bookId),
    readBookMd: (bookId: string): Promise<{ markdown: string; mdPath: string } | null> =>
      smokeLibrary
        ? Promise.resolve({ markdown: "---\ntitle: Cybernetic Predictive Devices\n---\n# Cybernetic Predictive Devices\nSmoke reader body.", mdPath: "smoke.md" })
        : ipcRenderer.invoke("library:read-book-md", bookId),
    /* Iter 12 P6.1: lightweight cover-url probe для catalog thumbnails. */
    getCoverUrl: (bookId: string): Promise<string | null> =>
      smokeLibrary
        ? Promise.resolve(null)
        : ipcRenderer.invoke("library:get-cover-url", bookId),
    /* Iter 12 P2.1: reader actions toolbar. */
    openOriginal: (bookId: string): Promise<{ ok: boolean; reason?: string }> =>
      smokeLibrary
        ? Promise.resolve({ ok: true })
        : ipcRenderer.invoke("library:open-original", bookId),
    revealInFolder: (bookId: string): Promise<{ ok: boolean; reason?: string }> =>
      smokeLibrary
        ? Promise.resolve({ ok: true })
        : ipcRenderer.invoke("library:reveal-in-folder", bookId),
    deleteBook: (
      bookId: string,
      deleteFiles?: boolean,
      /* Иt 8Е.1 (cascade Qdrant cleanup): активная коллекция в renderer
         для sync-удаления точек этой книги до возврата. Если undefined —
         только background full-scan. */
      activeCollection?: string,
    ): Promise<{ ok: boolean; reason?: string; qdrantCleaned?: number; qdrantBackgroundScheduled?: boolean }> =>
      smokeLibrary
        ? Promise.resolve({ ok: true }).then((res) => {
          smokeLibrary.rows = smokeLibrary.rows.filter((row) => row.id !== bookId);
          return res;
        })
        : ipcRenderer.invoke("library:delete-book", { bookId, deleteFiles, activeCollection }),
    /* Иt 8Е.5 (rebuild cache UI restored, 2026-05-02) — preload-мост
       library.rebuildCache возвращён, smoke assert hasRebuildCache тоже
       вернулся. Прежние мосты (evaluatorPause, evaluatorCancelCurrent,
       setEvaluatorModel, evaluatorPrioritize, evaluatorSetSlots,
       evaluatorGetSlots) пока остаются неподключёнными — добавим если
       UI-итерации потребуют. */
    rebuildCache: (): Promise<{ scanned: number; ingested: number; skipped: number; pruned: number; errors: string[] }> =>
      smokeLibrary
        ? Promise.resolve({ scanned: 0, ingested: 0, skipped: 0, pruned: 0, errors: [] })
        : ipcRenderer.invoke("library:rebuild-cache"),
    /* Iter 13.2 (P6, dev-mode): "Сжечь библиотеку" — снести все файлы под
       data/library/, bibliary-cache.db (+ wal/shm), Qdrant коллекции
       bibliary-*. Кэш-DB откроется заново лениво. */
    burnAll: (): Promise<{
      ok: boolean;
      reason?: string;
      libraryRoot: string;
      removedFiles: number;
      removedDirs: number;
      qdrantCleaned: number;
      qdrantErrors: string[];
    }> =>
      smokeLibrary
        ? Promise.resolve({
          ok: true,
          libraryRoot: "(smoke)",
          removedFiles: 0,
          removedDirs: 0,
          qdrantCleaned: 0,
          qdrantErrors: [],
        }).then((r) => {
          smokeLibrary.rows = [];
          return r;
        })
        : ipcRenderer.invoke("library:burn-all"),
    evaluatorStatus: (): Promise<LibraryEvaluatorStatus> =>
      smokeLibrary ? Promise.resolve({ running: false, paused: false, currentBookId: null, currentTitle: null, queueLength: 0, totalEvaluated: 0, totalFailed: 0 }) : ipcRenderer.invoke("library:evaluator-status"),
    evaluatorResume: (): Promise<boolean> => smokeLibrary ? Promise.resolve(true) : ipcRenderer.invoke("library:evaluator-resume"),
    reevaluate: (bookId: string): Promise<{ ok: boolean; reason?: string }> =>
      smokeLibrary ? Promise.resolve({ ok: true }) : ipcRenderer.invoke("library:evaluator-reevaluate", { bookId }),
    reevaluateAll: (): Promise<{ queued: number }> =>
      smokeLibrary ? Promise.resolve({ queued: smokeLibrary.rows.length }) : ipcRenderer.invoke("library:reevaluate-all"),
    reparseBook: (bookId: string): Promise<{ ok: boolean; chapters?: number; reason?: string }> =>
      smokeLibrary ? Promise.resolve({ ok: true, chapters: 1 }) : ipcRenderer.invoke("library:reparse-book", bookId),
    /**
     * On-demand AI illustration enrichment (MVP v1.0.1). User-triggered from
     * catalog -- runs `vision_illustration` model on selected books'
     * illustrations.json files, writing back descriptions and scores.
     */
    enrichIllustrations: (bookIds: string[]): Promise<{
      ok: boolean;
      processed: number;
      alreadyDone: number;
      skipped: number;
      errors: number;
      bookCount: number;
      reason?: string;
    }> =>
      smokeLibrary
        ? Promise.resolve({ ok: true, processed: 0, alreadyDone: 0, skipped: bookIds.length, errors: 0, bookCount: bookIds.length })
        : ipcRenderer.invoke("library:enrich-illustrations", bookIds),
    /**
     * v1.0.2: Sweep dead imports (incomplete-torrent files filled with 0xFF/0x00).
     * Manually triggered from catalog UI. Returns summary for toast display.
     */
    purgeDeadImports: (): Promise<{
      ok: boolean;
      reason?: string;
      scanned?: number;
      purged?: number;
      skipped?: number;
      missing?: number;
      freedBytes?: number;
      purgedDetails?: Array<{ id: string; title: string; reason: string; bytes: number }>;
    }> =>
      smokeLibrary
        ? Promise.resolve({ ok: true, scanned: 0, purged: 0, skipped: 0, missing: 0, freedBytes: 0, purgedDetails: [] })
        : ipcRenderer.invoke("library:purge-dead-imports"),
    onImportProgress: (cb: (payload: {
      importId: string;
      phase: "discovered" | "file-start" | "processed" | "scan-complete";
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
    }) => void): (() => void) => {
      if (smokeLibrary) {
        smokeLibrary.progressCb = cb as (payload: unknown) => void;
        return () => { smokeLibrary.progressCb = null; };
      }
      const l = (_e: unknown, p: {
        importId: string;
        phase: "discovered" | "file-start" | "processed" | "scan-complete";
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
    clearImportLogs: (): Promise<number> => smokeLibrary
      ? Promise.resolve(0)
      : ipcRenderer.invoke("library:clear-import-logs"),
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
    /* cancelScan удалён из preload (Iter 8А): zero renderer-callers. IPC
       handler `library:cancel-scan` сохранён в library-import-ipc.ts. */
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
});
