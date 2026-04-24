/**
 * Archive Tracker — refcount lifecycle для temp-директорий распакованных архивов.
 *
 * Контракт:
 *   - `register(tempDir, fileCount, cleanup)` — после распаковки архива.
 *     `fileCount` = сколько книг будет yield'нуто из этого архива.
 *     `cleanup` — что вызвать когда обработка всех книг закончится.
 *   - `finishOne(tempDir)` — после обработки одной книги (success или failure).
 *     Когда счётчик дошёл до 0, вызывается cleanup; tempDir исчезает с диска.
 *   - `cleanupAll()` — для abort-сценария: чистим всё что осталось.
 *     Идемпотентно, безопасно вызывать в `finally`.
 *
 * Важно: tracker НЕ знает откуда идут книги (walker, pool, etc.) — он
 * только лайфсайкл. Это снижает coupling.
 */

interface TrackerSlot {
  remaining: number;
  cleanup: () => Promise<void>;
}

export class ArchiveTracker {
  private slots = new Map<string, TrackerSlot>();

  /** Регистрирует архив. Если cleanup уже зарегистрирован для этого tempDir — пропуск. */
  register(tempDir: string, fileCount: number, cleanup: () => Promise<void>): void {
    if (this.slots.has(tempDir)) return;
    if (fileCount <= 0) {
      /* Пустой архив — cleanup сразу (без ожидания finishOne). */
      void cleanup().catch(() => undefined);
      return;
    }
    this.slots.set(tempDir, { remaining: fileCount, cleanup });
  }

  /** Сигнализирует, что одна книга из архива обработана. Может быть undefined для не-архивных книг. */
  async finishOne(tempDir: string | undefined): Promise<void> {
    if (!tempDir) return;
    const slot = this.slots.get(tempDir);
    if (!slot) return;
    slot.remaining -= 1;
    if (slot.remaining <= 0) {
      this.slots.delete(tempDir);
      try {
        await slot.cleanup();
      } catch {
        /* cleanup ошибки не должны валить ingest — temp-папки чистятся OS позже. */
      }
    }
  }

  /** Вызывается в `finally` импорта — чистит остатки на случай abort'а. */
  async cleanupAll(): Promise<void> {
    const all = Array.from(this.slots.values());
    this.slots.clear();
    await Promise.allSettled(all.map((s) => s.cleanup()));
  }

  /** Только для тестов: количество живых slots. */
  get size(): number {
    return this.slots.size;
  }
}
