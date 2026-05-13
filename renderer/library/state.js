// @ts-check
/**
 * Shared mutable state for the Library page.
 *
 * Singleton objects exported from here — every domain module reads/writes
 * the same references. This is intentional: the Library page is a single-
 * mount SPA panel inside Electron; there is no need for immutable stores.
 */

/** @typedef {{ absPath: string, fileName: string, ext: string, sizeBytes: number, mtimeMs: number }} BookFile */
/** @typedef {{ ingestId: string, phase: string, bookSourcePath: string, bookTitle: string, totalChunks: number, processedChunks: number, embeddedChunks: number, upsertedChunks: number, message?: string, errorMessage?: string }} ScannerProgressEvent */
/** @typedef {{ collection: string, books: Array<{ bookSourcePath: string, fileName: string, status: "running"|"done"|"error"|"paused", totalChunks: number, processedChunks: number, startedAt: string, lastUpdatedAt: string, errorMessage?: string }>, totalBooks: number, totalChunks: number }} HistoryGroup */
/** @typedef {"none"|"ext"|"status"|"folder"} GroupMode */

/**
 * @typedef {object} CatalogMeta
 * @property {string} id
 * @property {string} title
 * @property {string} [titleRu]
 * @property {string} [authorRu]
 * @property {string} [titleEn]
 * @property {string} [author]
 * @property {string} [authorEn]
 * @property {string} [domain]
 * @property {number} wordCount
 * @property {number} [qualityScore]
 * @property {boolean} [isFictionOrWater]
 * @property {number} [year]
 * @property {string} [lastError]
 * @property {string} status
 * @property {string[]} [tags]
 * @property {string[]} [tagsRu]
 */

export const STATE = {
  /** @type {"catalog"|"import"|"collections"} */
  tab: "catalog",
  targetCollection: "",
  /** @type {BookFile[]} */
  books: [],
  /** @type {Map<string, BookFile>} */
  selected: new Map(),
  /** @type {Map<string, ScannerProgressEvent>} */
  progress: new Map(),
  /** @type {Set<string>} */
  knownPaths: new Set(),
  /** @type {string} */
  collection: "",
  /** @type {string[]} */
  collections: [],
  /** @type {Map<string, string>} */
  activeIngests: new Map(),
  /** @type {BookFile[]} */
  queue: [],
  /** @type {BookFile | null} */
  previewBook: null,
  /** @type {"idle"|"loading"|"ready"|"error"} */
  previewState: "idle",
  previewData: null,
  /** @type {HistoryGroup[]} */
  history: [],
  busy: false,
  paused: false,
  prefs: {
    queueParallelism: 3,
    ocrEnabled: false,
    ocrSupported: false,
    ocrPlatform: "unknown",
    ocrReason: "",
    /** @type {GroupMode} */
    groupBy: "none",
  },
  ocrOverride: /** @type {boolean | null} */ (null),
};

export const CATALOG = {
  /** @type {CatalogMeta[]} */
  rows: [],
  total: 0,
  /** @type {Set<string>} bookId */
  selected: new Set(),
  /** @type {string} */
  libraryRoot: "",
  /** @type {string} */
  dbPath: "",
  filters: {
    quality: 0,
    hideFiction: false,
    search: "",
    /** @type {string[]} */
    tags: [],
    /** @type {Set<string> | null} */
    filterBookIds: null,
  },
  loading: false,
  unsubEvaluator: /** @type {null | (() => void)} */ (null),
};

/* Phase 13a — legacy datasetV2 batch state struct retired. The new
 * Phase 9 batch flow keeps no client-side state: a single POST returns
 * the gate result, per-job progress flows through extractor_events,
 * and there is no aggregator to reconcile. */

/** @typedef {{
 *   filePath: string;
 *   fileName: string;
 *   status: "processing"|"added"|"duplicate"|"skipped"|"failed";
 *   startedAt: number;
 *   finishedAt?: number;
 *   outcome?: string;
 *   errorMessage?: string;
 *   warnings?: string[];
 *   duplicateReason?: string;
 * }} BookProgress */

export const IMPORT_STATE = {
  busy: false,
  /** @type {string|null} */
  importId: null,
  scanArchives: true,
  recursive: true,
  /** Map<filePath, BookProgress> — per-book live state.
   *  Old entries trimmed to last 200 to keep memory bounded. */
  /** @type {Map<string, BookProgress>} */
  inFlight: new Map(),
  aggregate: {
    discovered: 0,
    processed: 0,
    added: 0,
    duplicate: 0,
    skipped: 0,
    failed: 0,
    /** @type {number|null} */
    startedAt: null,
  },
};

