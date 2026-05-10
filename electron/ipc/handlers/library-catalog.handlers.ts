/**
 * Pure-логика IPC хендлеров library-catalog-ipc.ts (extracted 2026-05-10).
 *
 * Большинство catalog-handlers (`library:get-book`, `read-book-md`,
 * `open-original`, `reveal-in-folder`, `get-cover-url`) принимают
 * `bookId: string` и проверяют его ровно одной строкой:
 *
 *   if (typeof bookId !== "string") return null|errorShape;
 *
 * Эта проверка повторяется ~10 раз и не имеет тестов. Extract'аем в
 * `validateBookIdString` чтобы был один источник истины + защита от
 * регрессий типа «забыли проверку, не-string crash'ит handler».
 */

/** Возвращает валидный bookId или null если payload не string / пустой. */
export function validateBookIdString(input: unknown): string | null {
  if (typeof input !== "string" || input.length === 0) return null;
  return input;
}

/* ─── library:delete-book ─────────────────────────────────────────── */

export interface DeleteBookArgs {
  bookId: string;
  deleteFiles?: boolean;
  activeCollection?: string;
}

export interface DeleteBookValidation {
  ok: boolean;
  data?: DeleteBookArgs;
  reason?: string;
}

/**
 * Validate `library:delete-book` payload. Реализует осторожные дефолты:
 *   - deleteFiles: если не указан → undefined (caller трактует как true,
 *     это исторический контракт).
 *   - activeCollection: silent-drop если не string.
 */
export function validateDeleteBookArgs(input: unknown): DeleteBookValidation {
  if (!input || typeof input !== "object") return { ok: false, reason: "bookId required" };
  const args = input as Record<string, unknown>;
  if (typeof args.bookId !== "string" || args.bookId.length === 0) {
    return { ok: false, reason: "bookId required" };
  }
  const out: DeleteBookArgs = { bookId: args.bookId };
  if (typeof args.deleteFiles === "boolean") out.deleteFiles = args.deleteFiles;
  if (typeof args.activeCollection === "string" && args.activeCollection.length > 0) {
    out.activeCollection = args.activeCollection;
  }
  return { ok: true, data: out };
}

/* ─── library:tag-stats / collection-by-tag locale ────────────────── */

/**
 * Опциональный locale параметр — должен быть либо "ru", "en" (или
 * undefined). Что-то ещё → undefined (silent drop). Это безопасно: handler
 * сам выберет дефолт из preferences.
 */
export function sanitizeLocale(input: unknown): "ru" | "en" | undefined {
  if (input === "ru" || input === "en") return input;
  return undefined;
}
