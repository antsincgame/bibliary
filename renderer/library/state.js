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
 * @property {string} [titleEn]
 * @property {string} [author]
 * @property {string} [authorEn]
 * @property {string} [domain]
 * @property {number} wordCount
 * @property {number} [qualityScore]
 * @property {boolean} [isFictionOrWater]
 * @property {string} status
 * @property {string[]} [tags]
 */

/** @typedef {{ downloadId: string, downloaded: number, total: number | null, status: "downloading"|"ingesting"|"done"|"error"|"cancelled", message?: string }} DownloadState */

export const STATE = {
  /** @type {"catalog"|"import"|"browse"|"history"|"search"} */
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
  },
  loading: false,
  unsubEvaluator: /** @type {null | (() => void)} */ (null),
  unsubBatch: /** @type {null | (() => void)} */ (null),
};

export const BATCH = {
  active: false,
  batchId: /** @type {string|null} */ (null),
  total: 0,
  done: 0,
  skipped: 0,
  failed: 0,
  /** @type {string|null} */
  currentBookId: null,
  /** @type {string|null} */
  currentBookTitle: null,
  /** @type {string|null} */
  lastJobId: null,
  /** @type {string|null} */
  collection: null,
};

export const IMPORT_STATE = {
  busy: false,
  /** @type {string|null} */
  importId: null,
  scanArchives: false,
  recursive: true,
};

/** @type {{ query: string, results: Array<any>, searching: boolean, error: string }} */
export const SEARCH_STATE = { query: "", results: [], searching: false, error: "" };

/** @type {Map<string, DownloadState>} */
export const DOWNLOAD_STATE = new Map();
/** @type {Map<string, string>} */
export const DOWNLOAD_BY_ID = new Map();
