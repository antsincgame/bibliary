/**
 * Pure-логика IPC хендлеров dataset-v2.ipc.ts (extracted 2026-05-10).
 *
 * Финальный нетривиальный IPC файл без покрытия. Здесь — payload
 * sanitization (clamping, format whitelist, trim) для:
 *   - dataset-v2:start-batch (bookIds + filters)
 *   - dataset-v2:synthesize (LLM dataset synthesis: pairs, ratio, limit)
 *   - dataset-v2:reject-accepted (conceptId validation)
 *
 * Heavy I/O (runExtraction, synthesizeDataset, vectordb) остаётся inline.
 */

/** Default vectordb collection name fallback. */
export const DEFAULT_COLLECTION = "default";

/* ─── start-batch payload ─────────────────────────────────────────── */

export interface StartBatchArgs {
  bookIds: string[];
  minQuality?: number;
  skipFictionOrWater?: boolean;
  extractModel?: string;
  targetCollection?: string;
}

export interface StartBatchValidation {
  ok: boolean;
  data?: StartBatchArgs;
  reason?: string;
}

/**
 * Pre-validate `dataset-v2:start-batch` payload. Shape + опциональные
 * фильтры:
 *   - bookIds: required, non-empty array of non-empty strings
 *   - minQuality: number 0..100 (silent drop если invalid)
 *   - skipFictionOrWater: boolean (silent drop если invalid)
 *   - extractModel, targetCollection: trimmed string или undefined
 *
 * Final assertValidCollectionName проверяется в handler после этого.
 */
export function validateStartBatchArgs(input: unknown): StartBatchValidation {
  if (!input || typeof input !== "object") return { ok: false, reason: "bookIds required" };
  const args = input as Record<string, unknown>;
  if (!Array.isArray(args.bookIds) || args.bookIds.length === 0) {
    return { ok: false, reason: "bookIds required" };
  }
  const cleanedIds: string[] = [];
  for (const id of args.bookIds) {
    if (typeof id === "string" && id.length > 0) cleanedIds.push(id);
  }
  if (cleanedIds.length === 0) {
    return { ok: false, reason: "bookIds required" };
  }

  const data: StartBatchArgs = { bookIds: cleanedIds };
  if (
    typeof args.minQuality === "number" &&
    Number.isFinite(args.minQuality) &&
    args.minQuality >= 0 &&
    args.minQuality <= 100
  ) {
    data.minQuality = args.minQuality;
  }
  if (typeof args.skipFictionOrWater === "boolean") {
    data.skipFictionOrWater = args.skipFictionOrWater;
  }
  if (typeof args.extractModel === "string") {
    const t = args.extractModel.trim();
    if (t.length > 0) data.extractModel = t;
  }
  if (typeof args.targetCollection === "string") {
    const t = args.targetCollection.trim();
    if (t.length > 0) data.targetCollection = t;
  }
  return { ok: true, data };
}

/* ─── synthesize payload ──────────────────────────────────────────── */

export interface SynthesizeArgs {
  collection: string;
  outputDir: string;
  format: "sharegpt" | "chatml";
  pairsPerConcept: number;
  model: string;
  trainRatio: number;
  limit?: number;
}

export interface SynthesizeValidation {
  ok: boolean;
  data?: SynthesizeArgs;
  error?: string;
}

/**
 * Sanitize `dataset-v2:synthesize` payload. Контракт:
 *   - collection: trimmed → fallback DEFAULT_COLLECTION (если пусто)
 *   - outputDir: required (trimmed non-empty)
 *   - format: "chatml" → "chatml", иначе "sharegpt"
 *   - pairsPerConcept: clamp 1..5 (UI слайдер 1-5, защита от outliers)
 *   - model: required (trimmed non-empty)
 *   - trainRatio: number 0..1 или default 0.9
 *   - limit: positive integer или undefined
 *
 * Final assertValidCollectionName проверяется в handler после этого.
 */
export function sanitizeSynthesizeArgs(input: unknown): SynthesizeValidation {
  if (!input || typeof input !== "object") {
    return { ok: false, error: "invalid args" };
  }
  const args = input as Record<string, unknown>;
  const collection =
    (typeof args.collection === "string" ? args.collection.trim() : "") || DEFAULT_COLLECTION;
  const outputDir = typeof args.outputDir === "string" ? args.outputDir.trim() : "";
  const format: "sharegpt" | "chatml" = args.format === "chatml" ? "chatml" : "sharegpt";
  const pairsRaw = Number(args.pairsPerConcept) || 2;
  const pairsPerConcept = Math.max(1, Math.min(5, pairsRaw));
  const model = typeof args.model === "string" ? args.model.trim() : "";

  if (!outputDir) return { ok: false, error: "не выбрана папка для сохранения" };
  if (!model) return { ok: false, error: "не выбрана модель LM Studio" };

  const trainRatio =
    typeof args.trainRatio === "number" && Number.isFinite(args.trainRatio) &&
    args.trainRatio >= 0 && args.trainRatio <= 1
      ? args.trainRatio
      : 0.9;
  const data: SynthesizeArgs = {
    collection,
    outputDir,
    format,
    pairsPerConcept,
    model,
    trainRatio,
  };
  if (
    typeof args.limit === "number" &&
    Number.isInteger(args.limit) &&
    args.limit > 0
  ) {
    data.limit = args.limit;
  }
  return { ok: true, data };
}

/* ─── reject-accepted: conceptId ──────────────────────────────────── */

export function validateConceptId(input: unknown): string | null {
  if (typeof input !== "string" || input.length === 0) return null;
  return input;
}
