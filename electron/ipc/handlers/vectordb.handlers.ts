/**
 * Pure-логика IPC хендлеров vectordb.ipc.ts (extracted 2026-05-10).
 *
 * Final имя коллекции валидируется через CollectionNameSchema (zod,
 * unit-tested). Здесь — distance-параметр sanitize (с legacy "ip"→"dot"
 * маппингом) + shape mapping LanceDB CollectionInfo → UI payload.
 */

/* ─── distance sanitization (legacy "ip" → "dot") ─────────────────── */

export type StoredDistance = "cosine" | "l2" | "dot";
export type InputDistance = "cosine" | "l2" | "ip" | "dot";

/**
 * Sanitize distance metric для ensureCollection. Контракт:
 *   - "ip" (legacy UI dropdown) → "dot" (новое имя в LanceDB)
 *   - "cosine", "l2", "dot" — passthrough
 *   - undefined / non-string / unknown → "cosine" (default)
 *
 * Это критично: ipсли пользователь выбрал "ip" в старом UI dropdown,
 * мы должны замапить в "dot" (LanceDB native имя), а не упасть с
 * "unknown distance".
 */
export function sanitizeDistance(input: unknown): StoredDistance {
  if (input === "ip") return "dot";
  if (input === "cosine" || input === "l2" || input === "dot") return input;
  return "cosine";
}

/* ─── pre-validation name parameter ───────────────────────────────── */

/**
 * Pre-validation collection name перед передачей в zod CollectionNameSchema.
 * Главное — отличить null/non-string (handler возвращает null без ошибки)
 * от валидной строки которая просто не соответствует zod (handler
 * возвращает error message).
 */
export function preValidateCollectionName(input: unknown): string | null {
  if (typeof input !== "string" || input.length === 0) return null;
  return input;
}

/* ─── CollectionInfoUI shape mapping ──────────────────────────────── */

/** Внутренний LanceDB info shape. */
export interface RawCollectionInfo {
  name: string;
  rowCount: number;
  hasVectorIndex: boolean;
}

/** UI payload shape. */
export interface CollectionInfoUI {
  name: string;
  pointsCount: number;
  status: "ok";
  metadata: { hasVectorIndex: true } | null;
}

/**
 * Pure mapping LanceDB info → UI payload. Извлечено для тестирования
 * корректности преобразования: name passthrough, rowCount → pointsCount,
 * hasVectorIndex bool → conditional metadata.
 */
export function buildCollectionInfoUI(info: RawCollectionInfo): CollectionInfoUI {
  return {
    name: info.name,
    pointsCount: info.rowCount,
    status: "ok",
    metadata: info.hasVectorIndex ? { hasVectorIndex: true } : null,
  };
}

/* ─── create-collection args validation ───────────────────────────── */

export interface CreateCollectionArgs {
  name: string;
  distance: StoredDistance;
}

export interface CreateCollectionValidation {
  ok: boolean;
  data?: CreateCollectionArgs;
  error?: string;
}

/**
 * Pre-validation для `vectordb:create-collection` без zod. Возвращает
 * shape-validated args + normalized distance. Caller потом передаст name
 * через CollectionNameSchema parseOrThrow для финальной проверки.
 */
export function validateCreateCollectionShape(input: unknown): CreateCollectionValidation {
  if (!input || typeof input !== "object") return { ok: false, error: "args required" };
  const args = input as Record<string, unknown>;
  if (typeof args.name !== "string" || args.name.length === 0) {
    return { ok: false, error: "name required" };
  }
  return {
    ok: true,
    data: {
      name: args.name,
      distance: sanitizeDistance(args.distance),
    },
  };
}
