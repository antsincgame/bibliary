/**
 * Bulkhead — изоляция ресурсов между пайплайнами.
 *
 * НАЗНАЧЕНИЕ: ограничить одновременную загрузку конкретной pipeline (e.g.
 * extraction/chunks-pipeline) чтобы:
 *   1. Зависший long-running job не съел всю память (очередь фиксированной длины).
 *   2. Сбойный path не утянул soundoff-pipeline (translator не должен ждать
 *      30 минут пока 5 extraction jobs молотят).
 *   3. Резкий peak (user clicked "Import" 10 раз) не вырубил систему.
 *
 * ПРИНЦИП — semaphore с bounded queue:
 *   - acquire(): если есть свободный слот — мгновенно run.
 *   - Если слотов нет, но в очереди < maxQueue — встаём в очередь.
 *   - Если очередь заполнена — BulkheadFullError (caller сам решает retry/skip).
 *
 * АНАЛОГИ:
 *   - Hystrix Thread-Pool Isolation
 *   - Resilience4j Bulkhead
 *   - Node.js: p-limit (упрощённая версия без queue overflow)
 */

export class BulkheadFullError extends Error {
  readonly name = "BulkheadFullError";
  readonly bulkheadName: string;
  readonly inflight: number;
  readonly queueDepth: number;
  readonly maxConcurrent: number;
  readonly maxQueue: number;

  constructor(name: string, inflight: number, queueDepth: number, maxConcurrent: number, maxQueue: number) {
    super(
      `Bulkhead "${name}" overloaded: ${inflight}/${maxConcurrent} active, ${queueDepth}/${maxQueue} queued. Reject new request.`,
    );
    this.bulkheadName = name;
    this.inflight = inflight;
    this.queueDepth = queueDepth;
    this.maxConcurrent = maxConcurrent;
    this.maxQueue = maxQueue;
  }
}

export interface BulkheadOptions {
  /** Имя — для логов и telemetry. */
  name: string;
  /** Максимум одновременно работающих операций. По умолчанию 1. */
  maxConcurrent?: number;
  /** Максимум операций в очереди ожидания. По умолчанию 5. 0 = строгий fail-fast (без очереди). */
  maxQueue?: number;
  /** Таймаут ожидания слота в очереди (ms). 0 = бесконечно. По умолчанию 0. */
  acquireTimeoutMs?: number;
}

export interface BulkheadStats {
  name: string;
  inflight: number;
  queueDepth: number;
  maxConcurrent: number;
  maxQueue: number;
  totalAcquired: number;
  totalRejected: number;
  totalTimeouts: number;
}

interface QueuedTask {
  resolve: () => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout | null;
}

export class Bulkhead {
  private readonly opts: Required<Omit<BulkheadOptions, "name">> & { name: string };
  private inflight = 0;
  private readonly queue: QueuedTask[] = [];
  private totalAcquired = 0;
  private totalRejected = 0;
  private totalTimeouts = 0;

  constructor(options: BulkheadOptions) {
    this.opts = {
      name: options.name,
      maxConcurrent: Math.max(1, options.maxConcurrent ?? 1),
      maxQueue: Math.max(0, options.maxQueue ?? 5),
      acquireTimeoutMs: Math.max(0, options.acquireTimeoutMs ?? 0),
    };
  }

  /**
   * Запустить fn под защитой Bulkhead. Возвращает результат fn или бросает:
   *   - BulkheadFullError если очередь заполнена.
   *   - Error('bulkhead acquire timeout') если задан acquireTimeoutMs и истёк.
   *   - Любую ошибку которую кинул fn.
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      const result = await fn();
      return result;
    } finally {
      this.release();
    }
  }

  /** Ручной acquire — для случаев когда нужно держать слот через несколько операций. */
  async acquire(): Promise<void> {
    if (this.inflight < this.opts.maxConcurrent) {
      this.inflight += 1;
      this.totalAcquired += 1;
      return;
    }
    if (this.queue.length >= this.opts.maxQueue) {
      this.totalRejected += 1;
      throw new BulkheadFullError(
        this.opts.name,
        this.inflight,
        this.queue.length,
        this.opts.maxConcurrent,
        this.opts.maxQueue,
      );
    }
    return new Promise<void>((resolve, reject) => {
      const task: QueuedTask = { resolve, reject, timer: null };
      if (this.opts.acquireTimeoutMs > 0) {
        task.timer = setTimeout(() => {
          const idx = this.queue.indexOf(task);
          if (idx >= 0) this.queue.splice(idx, 1);
          this.totalTimeouts += 1;
          reject(new Error(`Bulkhead "${this.opts.name}" acquire timeout (${this.opts.acquireTimeoutMs}ms)`));
        }, this.opts.acquireTimeoutMs);
      }
      this.queue.push(task);
    }).then(() => {
      this.inflight += 1;
      this.totalAcquired += 1;
    });
  }

  /** Ручной release — парный acquire. */
  release(): void {
    this.inflight = Math.max(0, this.inflight - 1);
    /* Дать первому в очереди слот. */
    const next = this.queue.shift();
    if (next) {
      if (next.timer) clearTimeout(next.timer);
      next.resolve();
    }
  }

  getStats(): BulkheadStats {
    return {
      name: this.opts.name,
      inflight: this.inflight,
      queueDepth: this.queue.length,
      maxConcurrent: this.opts.maxConcurrent,
      maxQueue: this.opts.maxQueue,
      totalAcquired: this.totalAcquired,
      totalRejected: this.totalRejected,
      totalTimeouts: this.totalTimeouts,
    };
  }

  /** Принудительно отменить все ожидания (например, на shutdown). */
  drain(): void {
    while (this.queue.length > 0) {
      const t = this.queue.shift()!;
      if (t.timer) clearTimeout(t.timer);
      t.reject(new Error(`Bulkhead "${this.opts.name}" drained`));
    }
  }
}

/* ─── Singletons ────────────────────────────────────────────────────── */

let chunksBulkhead: Bulkhead | null = null;

/**
 * Bulkhead для chunks-pipeline (dataset-v2 extraction + synthesize).
 *
 * Параметры:
 *   maxConcurrent=1  — одна extraction job за раз; LLM-overhead неэффективно
 *                       параллелить на одной GPU (модели конкурируют за VRAM).
 *   maxQueue=3       — допускаем до 3 ожидающих (типичный сценарий: user
 *                       выбирает несколько книг подряд). Свыше — reject с
 *                       UI-сообщением "очередь полная, дождитесь".
 *   acquireTimeoutMs=300_000 — 5 минут ожидания. Если предыдущая job висит
 *                       дольше — caller получает timeout и UI решает retry.
 */
export function getChunksBulkhead(): Bulkhead {
  if (!chunksBulkhead) {
    chunksBulkhead = new Bulkhead({
      name: "chunks-pipeline",
      maxConcurrent: 1,
      maxQueue: 3,
      acquireTimeoutMs: 5 * 60 * 1000,
    });
  }
  return chunksBulkhead;
}

export function _resetChunksBulkheadForTests(): void {
  chunksBulkhead = null;
}
