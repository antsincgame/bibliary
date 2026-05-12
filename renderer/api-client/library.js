import { http } from "./http.js";
import { subscribe } from "./realtime.js";
import { attachDropZone, uploadAndImport, uploadFile } from "./upload.js";

/**
 * Library catalog + aggregations + import + destructive ops.
 *
 * Push-event методы (onScanProgress, onImportProgress, onImportLog,
 * onEvaluatorEvent) — stubs до подключения Appwrite Realtime в Phase 3b.
 *
 * Native dialogs (pickFiles, pickFolder, revealInFolder, openOriginal) —
 * Electron-only. В web заменены на browser API: drag&drop + getCoverUrl.
 */

const noopUnsubscribe = () => undefined;

const notImplemented = (name) => async () => {
  throw new Error(`library.${name} not yet implemented in web mode`);
};

export const library = {
  /* ─── Catalog ──────────────────────────────────────────────────── */

  /**
   * @param {Record<string, string | number | boolean | undefined>} [filters]
   * @returns {Promise<{rows: any[], total: number}>}
   */
  catalog: (filters) => http.get("/api/library/books", { query: filters }),

  /** @param {string} id */
  getBook: (id) =>
    http.get(`/api/library/books/${encodeURIComponent(id)}`).catch((err) => {
      if (err && /** @type {any} */ (err).status === 404) return null;
      throw err;
    }),

  /** @param {string} id */
  readBookMd: (id) =>
    http.get(`/api/library/books/${encodeURIComponent(id)}/markdown`, { parse: "text" }),

  /** @param {string} id @returns {string} same-origin URL — браузер сам подставит cookies */
  getCoverUrl: (id) => `/api/library/books/${encodeURIComponent(id)}/cover`,

  /**
   * @param {string} id
   * @param {{deleteFiles?: boolean}} [opts]
   */
  deleteBook: (id, opts) =>
    http.delete(`/api/library/books/${encodeURIComponent(id)}`, {
      query: opts?.deleteFiles ? { deleteFiles: "true" } : undefined,
    }),

  /* ─── Aggregations (Phase 2f) ──────────────────────────────────── */

  /** @param {"ru" | "en"} [locale] */
  tagStats: (locale) =>
    http.get("/api/library/tag-stats", locale ? { query: { locale } } : undefined),

  collectionByDomain: () => http.get("/api/library/collection/by-domain"),

  /** @param {"ru" | "en"} [locale] */
  collectionByAuthor: (locale) =>
    http.get("/api/library/collection/by-author", locale ? { query: { locale } } : undefined),

  collectionByYear: () => http.get("/api/library/collection/by-year"),

  /** @param {"ru" | "en"} [locale] */
  collectionByTag: (locale) =>
    http.get("/api/library/collection/by-tag", locale ? { query: { locale } } : undefined),

  /** sphere — legacy SQLite concept; web returns empty list для UI safety. */
  collectionBySphere: async () => /** @type {Array<{label: string, count: number, bookIds: string[]}>} */ ([]),

  /* ─── Import (Phase 2k MVP + Phase 4 uploads) ──────────────────── */

  /**
   * @param {string[]} fileIds — IDs already-uploaded в `book-originals`.
   */
  importFiles: (fileIds) => http.post("/api/library/import-files", { json: { fileIds } }),

  /**
   * Single-file upload helper. Multipart POST /api/library/upload →
   * { fileId, name, size }. Renderer прокидывает fileId в importFiles
   * (или batched через uploadAndImport).
   */
  uploadFile,

  /**
   * Full drag&drop → upload → import flow:
   *   - sequential per-file upload (со per-file onProgress callback)
   *   - aggregate fileIds → importFiles
   *   - errors per-file capture в `uploadErrors`, не abort batch.
   */
  uploadAndImport,

  /**
   * Attach drag handlers to a container. Returns detach function.
   * Browser drop events нативные, не зависят от Electron.
   */
  attachDropZone,

  /* ─── Destructive ──────────────────────────────────────────────── */

  burnAll: () => http.post("/api/library/burn-all"),

  /* ─── Realtime push (Phase 3b SSE) ─────────────────────────────── */

  /** @param {(ev: unknown) => void} cb */
  onEvaluatorEvent: (cb) => subscribe("evaluator_events:created", cb),
  /** @param {(ev: unknown) => void} cb */
  onImportProgress: (cb) => subscribe("ingest_jobs:update", cb),
  /** @param {(ev: unknown) => void} cb */
  onImportLog: (cb) => subscribe("import_logs:append", cb),
  /** @param {(ev: unknown) => void} _cb */
  onScanProgress: (_cb) => noopUnsubscribe,
  /** @param {(ev: unknown) => void} _cb */
  onScanReport: (_cb) => noopUnsubscribe,

  importLogSnapshot: async () => /** @type {Array<unknown>} */ ([]),
  clearImportLogs: async () => 0,
  cancelImport: async () => false,
  purgeDeadImports: async () => 0,
  rebuildCache: notImplemented("rebuildCache"),
  reparseBook: notImplemented("reparseBook"),

  /* ─── Evaluator (Phase 6c) ─────────────────────────────────────── */

  evaluatorStatus: async () => ({
    running: false,
    paused: false,
    currentBookId: null,
    currentTitle: null,
    queueLength: 0,
    totalEvaluated: 0,
    totalFailed: 0,
  }),
  evaluatorResume: async () => true,
  /**
   * Synchronous evaluate one book — loads markdown, surrogate, через
   * configured evaluator provider (Settings → Providers → assignments).
   * Прогресс летит через SSE channel evaluator_events:created.
   *
   * @param {string} bookId
   * @returns {Promise<{ok: boolean, bookId: string, warnings: string[], error?: string}>}
   */
  reevaluate: (bookId) =>
    http.post(`/api/library/books/${encodeURIComponent(bookId)}/evaluate`),

  /**
   * Full delta-knowledge extraction для одной книги. Load markdown →
   * split chapters → chunk → extract per-chunk → write concepts в
   * Appwrite collection (default "default"). Sync (Phase 7 → async).
   *
   * Прогресс через SSE evaluator_events:created с payload.kind:
   *   "extraction" — старт/финиш всей книги
   *   "chapter"    — старт/финиш одной главы (stats: {total, extracted,
   *                  filler, failed})
   *
   * @param {string} bookId
   * @param {{collection?: string}} [opts]
   * @returns {Promise<{ok: boolean, bookId: string, chaptersProcessed: number, chunksTotal: number, conceptsAccepted: number, conceptsFailed: number, warnings: string[], error?: string}>}
   */
  extract: (bookId, opts = {}) =>
    http.post(`/api/library/books/${encodeURIComponent(bookId)}/extract`, {
      json: opts,
    }),

  /* ─── Electron-only dialogs (replaced by drag&drop / browser file picker) ─── */

  pickFiles: notImplemented("pickFiles"),
  pickFolder: notImplemented("pickFolder"),
  openOriginal: notImplemented("openOriginal"),
  revealInFolder: notImplemented("revealInFolder"),

  scanFolder: notImplemented("scanFolder"),
  importFolder: notImplemented("importFolder"),
};
