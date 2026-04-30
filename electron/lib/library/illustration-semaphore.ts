/**
 * Illustration semaphore — глобальный лимит на одновременные
 * `processIllustrations()` jobs.
 *
 * ПРОБЛЕМА (audit 2026-04-30):
 *   Раньше `import-book.ts:269` делал `void processIllustrations(...)` —
 *   fire-and-forget без какого-либо лимита между книгами. При импорте
 *   папки на 100 книг это могло запустить **100 одновременных** illustration
 *   jobs, каждый из которых внутри держит до 4 параллельных vision-чатов
 *   к LM Studio (`VISION_PARALLELISM = 4` в illustration-worker.ts).
 *
 *   Итог в худшем случае: ~400 одновременных HTTP-запросов к LM Studio
 *   → таймауты, OOM на стороне сервера, swap-thrashing на клиенте.
 *
 * РЕШЕНИЕ:
 *   Глобальный семафор с capacity по умолчанию **2 книги** одновременно
 *   в illustration pipeline. Внутри одной книги остаётся `VISION_PARALLELISM=4`,
 *   итого: max ~8 параллельных vision HTTP. Это укладывается в типичный
 *   GPU/RAM budget для 4B vision-модели и не валит LM Studio.
 *
 *   Lower bound (capacity=1) — последовательная обработка, безопасно для
 *   слабых машин. Override через env `BIBLIARY_ILLUSTRATION_PARALLEL_BOOKS`.
 *
 * АРХИТЕКТУРА:
 *   - FIFO очередь — порядок импорта сохраняется, нет starvation поздних книг.
 *   - Fire-and-forget совместимость — caller продолжает писать `void run(...)`
 *     и не ждёт. Семафор сам сериализует.
 *   - Drain API — при abort импорта или shutdown можно дождаться завершения
 *     всех в очереди.
 */

const DEFAULT_CAPACITY = (() => {
  const raw = process.env.BIBLIARY_ILLUSTRATION_PARALLEL_BOOKS;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed >= 1 && parsed <= 16 ? parsed : 2;
})();

class IllustrationSemaphore {
  private capacity: number;
  private active = 0;
  private queue: Array<() => void> = [];

  constructor(capacity: number) {
    this.capacity = Math.max(1, capacity);
  }

  /**
   * Запустить illustration job с уважением семафора. Возвращает Promise
   * который резолвится после завершения `task` (включая ожидание в очереди).
   *
   * Caller обычно использует `void run(...)` — fire-and-forget с
   * автосериализацией.
   */
  async run<T>(task: () => Promise<T>): Promise<T> {
    /* Ждём пока освободится слот. Lock-free через Promise+resolver. */
    if (this.active >= this.capacity) {
      await new Promise<void>((resolve) => {
        this.queue.push(resolve);
      });
    }
    this.active += 1;
    try {
      return await task();
    } finally {
      this.active -= 1;
      const next = this.queue.shift();
      if (next) next();
    }
  }

  /**
   * Ждать пока очередь полностью опустеет (все running + queued завершатся).
   * Вызывается при abort импорта или приложения shutdown.
   *
   * Возвращает Promise, который резолвится когда `active === 0 && queue.length === 0`.
   */
  async drain(): Promise<void> {
    while (this.active > 0 || this.queue.length > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
  }

  /** Текущий статус для логов / UI / тестов. */
  getStatus(): { active: number; queued: number; capacity: number } {
    return { active: this.active, queued: this.queue.length, capacity: this.capacity };
  }

  /** Изменить capacity на лету (UI «pause illustration jobs» = setCapacity(0)). */
  setCapacity(capacity: number): void {
    this.capacity = Math.max(0, capacity);
    /* Если capacity увеличили — пробудить ожидающих. */
    while (this.active < this.capacity && this.queue.length > 0) {
      const next = this.queue.shift();
      if (next) {
        this.active += 1; /* Зарезервировать слот, иначе run() ниже его не получит */
        /* Откатываем active, потому что run() сам инкрементирует. */
        this.active -= 1;
        next();
      }
    }
  }

  /** Только для тестов — сбросить состояние. */
  _resetForTests(): void {
    this.active = 0;
    this.queue = [];
    this.capacity = DEFAULT_CAPACITY;
  }
}

const sharedSemaphore = new IllustrationSemaphore(DEFAULT_CAPACITY);

/** Получить shared singleton. */
export function getIllustrationSemaphore(): IllustrationSemaphore {
  return sharedSemaphore;
}

/** Convenience: запустить job через shared semaphore. */
export async function runIllustrationJob<T>(task: () => Promise<T>): Promise<T> {
  return sharedSemaphore.run(task);
}

/** Дождаться полного завершения всех illustration jobs (для shutdown). */
export async function drainIllustrationJobs(): Promise<void> {
  return sharedSemaphore.drain();
}

/** Только для тестов — экспортируем класс для standalone instances. */
export { IllustrationSemaphore };
