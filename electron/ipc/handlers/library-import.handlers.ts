/**
 * Pure-логика IPC хендлеров library-import-ipc.ts (extracted 2026-05-10).
 *
 * Validators для четырёх главных payload'ов:
 *   - import-folder: {folder, scanArchives?, ocrEnabled?, maxDepth?}
 *   - import-files:  {paths[], scanArchives?, ocrEnabled?}
 *   - cancel-import: importId string
 *   - scan-folder:   {folder}
 *   - cancel-scan:   scanId string
 *
 * Heavy I/O (fs.stat, walker, ingestBook вызов) остаётся в registerLibraryImportIpc.
 * Здесь — только проверка структуры payload'а, чтобы handler мог рано
 * рапортовать об ошибке вместо crash на полпути.
 */

/* ─── Common helpers ──────────────────────────────────────────────── */

export interface ValidationResult<T> {
  ok: boolean;
  data?: T;
  reason?: string;
}

/* ─── library:import-folder ───────────────────────────────────────── */

export interface ImportFolderArgs {
  folder: string;
  scanArchives?: boolean;
  ocrEnabled?: boolean;
  maxDepth?: number;
}

/**
 * Pre-validation для `library:import-folder`. Final path-validation
 * делается через zod (`AbsoluteFilePathSchema`) внутри handler'а;
 * здесь проверяем shape объекта + типы опциональных полей.
 *
 * Контракт:
 *   - folder: required string
 *   - scanArchives, ocrEnabled: boolean | undefined (всё остальное → undefined)
 *   - maxDepth: integer ≥0 | undefined
 */
export function validateImportFolderArgs(input: unknown): ValidationResult<ImportFolderArgs> {
  if (!input || typeof input !== "object") return { ok: false, reason: "args required" };
  const args = input as Record<string, unknown>;
  if (typeof args.folder !== "string" || args.folder.length === 0) {
    return { ok: false, reason: "folder required" };
  }
  const out: ImportFolderArgs = { folder: args.folder };
  if (typeof args.scanArchives === "boolean") out.scanArchives = args.scanArchives;
  if (typeof args.ocrEnabled === "boolean") out.ocrEnabled = args.ocrEnabled;
  if (typeof args.maxDepth === "number" && Number.isInteger(args.maxDepth) && args.maxDepth >= 0) {
    out.maxDepth = args.maxDepth;
  }
  return { ok: true, data: out };
}

/* ─── library:import-files ────────────────────────────────────────── */

export interface ImportFilesArgs {
  paths: string[];
  scanArchives?: boolean;
  ocrEnabled?: boolean;
}

/**
 * Pre-validation для `library:import-files`. Final per-path validation
 * (что существуют, абсолютные) делается через zod внутри handler'а.
 * Здесь — shape + что paths не пустой массив строк.
 */
export function validateImportFilesArgs(input: unknown): ValidationResult<ImportFilesArgs> {
  if (!input || typeof input !== "object") return { ok: false, reason: "args required" };
  const args = input as Record<string, unknown>;
  if (!Array.isArray(args.paths)) return { ok: false, reason: "paths required" };
  if (args.paths.length === 0) return { ok: false, reason: "paths required" };
  /* Все элементы должны быть строками. Если хоть один не string — отказ
     (не silently filter, иначе пользователь не поймёт почему его 5
     файлов превратились в 4). */
  for (const p of args.paths) {
    if (typeof p !== "string" || p.length === 0) {
      return { ok: false, reason: "all paths must be non-empty strings" };
    }
  }
  const out: ImportFilesArgs = { paths: args.paths as string[] };
  if (typeof args.scanArchives === "boolean") out.scanArchives = args.scanArchives;
  if (typeof args.ocrEnabled === "boolean") out.ocrEnabled = args.ocrEnabled;
  return { ok: true, data: out };
}

/* ─── library:scan-folder ─────────────────────────────────────────── */

export interface ScanFolderArgs {
  folder: string;
}

export function validateScanFolderArgs(input: unknown): ValidationResult<ScanFolderArgs> {
  if (!input || typeof input !== "object") return { ok: false, reason: "args required" };
  const args = input as Record<string, unknown>;
  if (typeof args.folder !== "string" || args.folder.length === 0) {
    return { ok: false, reason: "folder required" };
  }
  return { ok: true, data: { folder: args.folder } };
}

/* ─── library:cancel-import / library:cancel-scan ─────────────────── */

/**
 * Validate cancel-* handler payload (single string ID). Возвращает
 * чистый ID или null если payload невалиден — caller просто вернёт
 * `false` (нет такого in-flight'а).
 */
export function validateCancelId(input: unknown): string | null {
  if (typeof input !== "string" || input.length === 0) return null;
  return input;
}
