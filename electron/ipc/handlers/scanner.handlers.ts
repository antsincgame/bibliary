/**
 * Pure-логика IPC хендлеров scanner.ipc.ts (extracted 2026-05-10).
 *
 * Final path-validation (AbsoluteFilePathSchema, CollectionNameSchema)
 * делается через zod внутри handler'а — эти схемы уже отдельно
 * unit-tested (см. tests/audit-validators-rejection.test.ts).
 *
 * Здесь — pre-shape проверка и chunkerOptions sanitization (нетривиальная
 * pure-логика которую раньше нельзя было unit-тестировать).
 */

/* ─── scanner:start-ingest chunkerOptions ─────────────────────────── */

export interface ChunkerOptions {
  targetChars?: number;
  maxChars?: number;
  minChars?: number;
}

/**
 * Sanitize chunkerOptions из IPC payload. Берёт только positive integers,
 * всё остальное (NaN, negative, дробные, strings) → undefined.
 *
 * Возвращает chunkerOptions или undefined если ни одно из полей не валидно
 * (пустой объект — это смысл-нагрузка «использовать defaults»).
 */
export function sanitizeChunkerOptions(input: unknown): ChunkerOptions | undefined {
  if (!input || typeof input !== "object") return undefined;
  const raw = input as Record<string, unknown>;
  const out: ChunkerOptions = {};
  let hasAny = false;

  const validIntField = (k: "targetChars" | "maxChars" | "minChars"): void => {
    const v = raw[k];
    if (typeof v === "number" && Number.isInteger(v) && v > 0) {
      out[k] = v;
      hasAny = true;
    }
  };
  validIntField("targetChars");
  validIntField("maxChars");
  validIntField("minChars");

  return hasAny ? out : undefined;
}

/* ─── scanner:start-ingest payload (full validation) ──────────────── */

export interface StartIngestArgs {
  filePath: string;
  collection: string;
  chunkerOptions?: ChunkerOptions;
  ocrOverride?: boolean;
}

export interface StartIngestValidation {
  ok: boolean;
  /** Только shape-валидированные значения. Final path/collection
   *  zod-validation делается уровнем выше. */
  data?: {
    filePath: string;
    collection: string;
    chunkerOptions?: ChunkerOptions;
    ocrOverride?: boolean;
  };
  reason?: string;
}

/**
 * Pre-validation для `scanner:start-ingest`. Проверяет shape и типы.
 * Окончательная валидация filePath (что absolute) и collection (что
 * допустимое имя) делается через zod после этого pre-check.
 */
export function validateStartIngestShape(input: unknown): StartIngestValidation {
  if (!input || typeof input !== "object") return { ok: false, reason: "args required" };
  const args = input as Record<string, unknown>;
  if (typeof args.filePath !== "string" || args.filePath.length === 0) {
    return { ok: false, reason: "filePath required" };
  }
  if (typeof args.collection !== "string" || args.collection.length === 0) {
    return { ok: false, reason: "collection required" };
  }
  const data: StartIngestValidation["data"] = {
    filePath: args.filePath,
    collection: args.collection,
  };
  const chunker = sanitizeChunkerOptions(args.chunkerOptions);
  if (chunker) data.chunkerOptions = chunker;
  if (typeof args.ocrOverride === "boolean") data.ocrOverride = args.ocrOverride;
  return { ok: true, data };
}

/* ─── scanner:start-folder-bundle payload ─────────────────────────── */

export interface StartFolderBundleArgs {
  folderPath: string;
  collection: string;
}

export interface StartFolderBundleValidation {
  ok: boolean;
  data?: StartFolderBundleArgs;
  reason?: string;
}

export function validateStartFolderBundleShape(
  input: unknown,
): StartFolderBundleValidation {
  if (!input || typeof input !== "object") {
    return { ok: false, reason: "folderPath и collection обязательны" };
  }
  const args = input as Record<string, unknown>;
  if (typeof args.folderPath !== "string" || args.folderPath.length === 0) {
    return { ok: false, reason: "folderPath и collection обязательны" };
  }
  if (typeof args.collection !== "string" || args.collection.length === 0) {
    return { ok: false, reason: "folderPath и collection обязательны" };
  }
  return {
    ok: true,
    data: { folderPath: args.folderPath, collection: args.collection },
  };
}

/* ─── scanner:cancel-ingest ───────────────────────────────────────── */

export function validateIngestId(input: unknown): string | null {
  if (typeof input !== "string" || input.length === 0) return null;
  return input;
}
