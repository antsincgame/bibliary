/**
 * Pure-логика IPC хендлеров library-evaluator-ipc.ts (extracted 2026-05-10).
 *
 * Здесь только payload validators — heavy I/O handlers (reparse-book,
 * reevaluate-all которые трогают cache-db и evaluator-queue) остаются
 * inline. Validators — самая частая причина регрессий: «забыли проверить
 * isInteger», «приняли отрицательное значение», «не отвергли пустую
 * строку как model».
 */

/** ─── evaluator:set-slots payload ─────────────────────────────────── */

export interface SetSlotsValidation {
  ok: boolean;
  /** Когда ok=true — нормализованное значение. */
  slots?: number;
}

/**
 * UI слайдер пропускает 1..16 целых чисел. Защищаемся от:
 *   - NaN (приходит при ошибочном parseInt из текста)
 *   - 0 / отрицательных (UI-баг)
 *   - дробных (floating-point слайдер с шагом 0.5)
 *   - строк, null, undefined (плохой IPC payload)
 *
 * NB: верхняя граница НЕ enforced — runtime сам решает (зависит от VRAM).
 * Безопасный максимум регулируется evaluator-queue.ts:applyEvaluatorPrefs.
 */
export function validateSetSlots(input: unknown): SetSlotsValidation {
  if (typeof input !== "number") return { ok: false };
  if (!Number.isInteger(input)) return { ok: false };
  if (input < 1) return { ok: false };
  return { ok: true, slots: input };
}

/** ─── evaluator:set-model payload ─────────────────────────────────── */

/**
 * Sanitize evaluator model selection: empty/non-string → null (auto-pick).
 * Возвращает либо валидный model key, либо null. Никогда не throw —
 * это пользовательский UI input.
 */
export function sanitizeEvaluatorModel(input: unknown): string | null {
  if (typeof input === "string" && input.length > 0) return input;
  return null;
}

/** ─── evaluator:reevaluate payload ────────────────────────────────── */

export interface ReevaluateValidation {
  ok: boolean;
  bookId?: string;
  reason?: string;
}

/**
 * Reevaluate args = `{bookId: string}`. UI всегда передаёт строку, но IPC
 * слой получает unknown — валидируем для type-safety и защиты от
 * случайного payload `{bookId: 123}` или `null`.
 */
export function validateReevaluateArgs(input: unknown): ReevaluateValidation {
  if (!input || typeof input !== "object") {
    return { ok: false, reason: "bookId required" };
  }
  const args = input as Record<string, unknown>;
  if (typeof args.bookId !== "string" || args.bookId.length === 0) {
    return { ok: false, reason: "bookId required" };
  }
  return { ok: true, bookId: args.bookId };
}

/** ─── evaluator:prioritize payload ────────────────────────────────── */

export interface PrioritizeValidation {
  ok: boolean;
  /** Очищенный список валидных string IDs (без пустых и не-строк). */
  bookIds?: string[];
}

/**
 * Принимаем `{bookIds: string[]}`, отбрасываем не-string и пустые
 * элементы. Если `bookIds` не массив или вход не объект — `ok=false`.
 *
 * Сохраняет порядок caller'а (это важно для evaluator-queue.unshift
 * семантики «оценить эти первыми в указанном порядке»).
 */
export function validatePrioritizeArgs(input: unknown): PrioritizeValidation {
  if (!input || typeof input !== "object") {
    return { ok: false };
  }
  const args = input as Record<string, unknown>;
  if (!Array.isArray(args.bookIds)) {
    return { ok: false };
  }
  const cleaned: string[] = [];
  for (const id of args.bookIds) {
    if (typeof id === "string" && id.length > 0) {
      cleaned.push(id);
    }
  }
  return { ok: true, bookIds: cleaned };
}

/** ─── reparse-book payload ────────────────────────────────────────── */

export interface ReparseBookValidation {
  ok: boolean;
  bookId?: string;
  reason?: string;
}

export function validateReparseBookArgs(input: unknown): ReparseBookValidation {
  if (typeof input !== "string") {
    return { ok: false, reason: "bookId required" };
  }
  if (input.length === 0) {
    return { ok: false, reason: "bookId required" };
  }
  return { ok: true, bookId: input };
}
