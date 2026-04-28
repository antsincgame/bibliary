// @ts-check
/**
 * datasets-history — локальная история созданных датасетов.
 *
 * Хранится в localStorage (ключ `bibliary.datasets.history.v1`). Это
 * единственное место, где renderer помнит «где лежат мои датасеты».
 *
 * Запись добавляется автоматически после успешного экспорта или синтеза.
 * Раздел «Датасеты» использует эту же историю для построения списка карточек.
 */

const STORAGE_KEY = "bibliary.datasets.history.v1";
const MAX_RECORDS = 200;

/**
 * @typedef {Object} DatasetRecord
 * @property {string} outputDir
 * @property {string} collection
 * @property {string} format
 * @property {"template" | "llm-synth"} method
 * @property {string} [model]
 * @property {number} concepts
 * @property {number} totalLines
 * @property {number} trainLines
 * @property {number} valLines
 * @property {number} [durationMs]
 * @property {string} createdAt
 * @property {string} [label]
 */

const listeners = new Set();

/** @returns {DatasetRecord[]} */
export function loadHistory() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isRecord);
  } catch {
    return [];
  }
}

/** @param {DatasetRecord[]} records */
function saveHistory(records) {
  try {
    const trimmed = records.slice(0, MAX_RECORDS);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
    for (const cb of listeners) {
      try {
        cb(trimmed);
      } catch {
        /* listener errors should not break save */
      }
    }
  } catch {
    /* quota / privacy mode */
  }
}

/** @param {DatasetRecord} record */
export function recordDataset(record) {
  if (!record || !record.outputDir) return;
  const existing = loadHistory().filter((r) => r.outputDir !== record.outputDir);
  saveHistory([record, ...existing]);
}

/** @param {string} outputDir */
export function removeDataset(outputDir) {
  const filtered = loadHistory().filter((r) => r.outputDir !== outputDir);
  saveHistory(filtered);
}

/** @param {(records: DatasetRecord[]) => void} cb */
export function onHistoryChange(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** @param {unknown} v @returns {v is DatasetRecord} */
function isRecord(v) {
  if (!v || typeof v !== "object") return false;
  const r = /** @type {Record<string, unknown>} */ (v);
  return typeof r.outputDir === "string" && typeof r.createdAt === "string";
}
