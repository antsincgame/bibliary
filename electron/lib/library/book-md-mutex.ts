/**
 * Per-bookId mutex для предотвращения lost-update в book.md
 * (Иt 8Г.1, 2026-05-02).
 *
 * КОНТЕКСТ:
 * Inquisitor diagonal review (Иt 8Г разведка) подтвердил РЕАЛЬНУЮ ГОНКУ:
 * evaluator (medium lane) и illustration-worker (heavy lane) — это РАЗНЫЕ
 * scheduler counters, поэтому lane separation не сериализует запись в один
 * файл. Оба пути делают read-modify-write по одному mdPath:
 *   - evaluator: читает md → модифицирует frontmatter (+reasoning) → write
 *   - illustration-worker: читает md → модифицирует body (alt-text) → write
 * При совпадении окон возникает classic lost-update: побеждает писатель,
 * чья запись произошла последней; данные другой стороны теряются.
 *
 * РЕШЕНИЕ:
 * Per-bookId Promise-цепочка (FIFO mutex). Все callers с одинаковым bookId
 * сериализуются. Разные bookId — параллельны. AbortSignal даёт раннюю отмену.
 *
 * ПОЧЕМУ НЕ async-mutex/p-queue:
 * - Same-process coordination, нет нужды в OS-level lock или task-queue
 *   управления параллелизмом.
 * - Zero deps (правило манифеста: «никаких новых тяжёлых зависимостей»).
 * - ~60 строк против 10-30KB external lib — тривиально читается и тестируется.
 *
 * MEMORY:
 * Map потенциально может расти при тысячах книг → soft-cap MAX_ENTRIES + TTL
 * cleanup. После окончания цепочки entry удаляется немедленно (см. finally).
 */

interface LockEntry {
  /** Резолвится когда текущий критический участок отпущен (НЕ когда fn вернулся). */
  release: Promise<void>;
  /** Mtime последней активности — для stale cleanup. */
  lastTouchedAt: number;
}

const MAX_ENTRIES = 256;
const STALE_AGE_MS = 60 * 60_000; // 1 hour
const KEEP_AFTER_CLEANUP = 128;

const locks = new Map<string, LockEntry>();

/**
 * Выполняет fn под эксклюзивной блокировкой по bookId. Все одновременные
 * callers с тем же bookId сериализуются FIFO. Разные bookId — параллельны.
 *
 * AbortSignal:
 *   - если signal уже aborted перед вызовом — бросается синхронно;
 *   - если abort происходит во время ожидания предыдущего caller —
 *     fn не запускается, бросается DOMException AbortError;
 *   - abort ВО ВРЕМЯ fn — fn должна сама отреагировать (mutex не прерывает fn).
 *
 * Возвращает результат fn или пробрасывает её ошибку. В любом случае lock
 * корректно освобождается через finally.
 */
export async function withBookMdLock<T>(
  bookId: string,
  fn: () => Promise<T>,
  options?: { signal?: AbortSignal },
): Promise<T> {
  if (locks.size > MAX_ENTRIES) cleanupStale();

  options?.signal?.throwIfAborted();

  const previous = locks.get(bookId);
  /* catch(()=>undefined) — изолируем ошибки предыдущей цепочки: следующий
     caller не должен падать из-за того, что предыдущий выбросил исключение. */
  const waitFor = previous ? previous.release.catch(() => undefined) : Promise.resolve();

  let releaseFn: () => void = () => {};
  const releasePromise = new Promise<void>((resolve) => {
    releaseFn = resolve;
  });

  const entry: LockEntry = {
    release: releasePromise,
    lastTouchedAt: Date.now(),
  };
  /* Регистрируем ДО await waitFor — следующий caller сразу увидит нашу
     цепочку и встанет за нами в очередь, а не проскочит вперёд. */
  locks.set(bookId, entry);

  try {
    await waitFor;
    options?.signal?.throwIfAborted();
    return await fn();
  } finally {
    entry.lastTouchedAt = Date.now();
    releaseFn();
    /* Если за нами никто не встал — освобождаем память.
       Если встал (locks.get(bookId) !== entry) — оставляем его entry. */
    if (locks.get(bookId) === entry) locks.delete(bookId);
  }
}

function cleanupStale(): void {
  const now = Date.now();
  for (const [bookId, entry] of locks) {
    if (now - entry.lastTouchedAt > STALE_AGE_MS) locks.delete(bookId);
  }
  if (locks.size > KEEP_AFTER_CLEANUP) {
    const sorted = Array.from(locks.entries()).sort(
      (a, b) => b[1].lastTouchedAt - a[1].lastTouchedAt,
    );
    locks.clear();
    for (const [id, entry] of sorted.slice(0, KEEP_AFTER_CLEANUP)) {
      locks.set(id, entry);
    }
  }
}

/** Текущий размер карты — для observability/диагностики. */
export function getBookMdLockStats(): { count: number } {
  return { count: locks.size };
}

/** Только для unit-тестов: полный сброс. */
export function _resetBookMdLocksForTests(): void {
  locks.clear();
}
