/**
 * Heavy Lane Rate Limiter — защита тяжёлой vision-LLM очереди от DDoS.
 *
 * ПРОБЛЕМА: книга в 1000 страниц без текстового слоя без этой защиты =
 * 1000 vision-LLM запросов к Qwen-VL 22 GB подряд. Это:
 *   - монополизирует heavy lane на дни;
 *   - блокирует evaluator/illustration других книг;
 *   - создаёт thermal throttle на GPU;
 *   - может приводить к потере соединения с LM Studio (timeout).
 *
 * РЕШЕНИЕ: sliding-window лимитер на vision-OCR запросы.
 * Default: 60 запросов в минуту (1 страница в секунду — посильно для
 * 22 GB Qwen-VL на типичном железе RTX 4090, не доводит до перегрева).
 *
 * Конфиг через env BIBLIARY_VISION_OCR_RPM или передаётся в конструктор.
 *
 * Контракт acquire():
 *   - Если в окне последней минуты < limit запросов → возвращает immediately.
 *   - Иначе — спит до момента, когда самый старый таймстамп выпадет из окна.
 *   - Уважает AbortSignal: throws если signal.aborted.
 *
 * Лимитер per-modelKey: разные модели имеют независимые окна. Это правильно,
 * потому что DDoS обычно идёт от ОДНОЙ конкретной vision-OCR модели,
 * а другие vision (vision_meta cover) могут продолжать работать параллельно.
 */

const DEFAULT_LIMIT_PER_MINUTE = 60;
const WINDOW_MS = 60_000;

export interface HeavyLaneRateLimiterOptions {
  /** Сколько acquire'ов разрешено за WINDOW_MS. Default: 60 (1/sec). */
  limitPerMinute?: number;
  /** Кастомный clock (для тестов). */
  now?: () => number;
}

export class HeavyLaneRateLimiter {
  private limit: number;
  private readonly now: () => number;
  /** Ключ — modelKey, значение — отсортированный по возрастанию массив таймстампов. */
  private readonly timestamps = new Map<string, number[]>();
  /** Promise-цепочка per-modelKey для строгой сериализации acquire. */
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(opts: HeavyLaneRateLimiterOptions = {}) {
    this.limit = Math.max(1, Math.floor(opts.limitPerMinute ?? envLimit() ?? DEFAULT_LIMIT_PER_MINUTE));
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Обновить лимит на лету (Иt 8Б — Settings → applyRuntimeSideEffects).
   * Бегущие acquire не отменяются; новый лимит применится при следующих
   * acquireInternal проверках. Снижение лимита может «подвиснуть» текущие
   * запросы пока окно не сожмётся — это ожидаемое поведение.
   */
  updateLimit(newLimit: number): void {
    if (!Number.isFinite(newLimit) || newLimit < 1) return;
    this.limit = Math.floor(newLimit);
  }

  /**
   * Заблокировать call до того, как в sliding window окажется свободный слот.
   * Возвращает после того, как «забронировал» слот (timestamp записан).
   *
   * Per-modelKey сериализован, чтобы две параллельные acquire не записали
   * один и тот же слот (race в bucket'е).
   */
  async acquire(modelKey: string, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new Error("rate-limiter aborted");

    /* Сериализация per-modelKey. Промис каждого acquire ждёт предыдущий. */
    const prev = this.chains.get(modelKey) ?? Promise.resolve();
    let resolve!: (v: unknown) => void;
    const next = new Promise((r) => { resolve = r; });
    this.chains.set(modelKey, next);
    try {
      await prev.catch(() => undefined);
      await this.acquireInternal(modelKey, signal);
    } finally {
      resolve(undefined);
      /* Если цепочка после нас не продолжалась — очищаем map чтобы не накапливать. */
      if (this.chains.get(modelKey) === next) {
        this.chains.delete(modelKey);
      }
    }
  }

  /**
   * Информационная функция: сколько запросов в текущем окне для modelKey.
   */
  currentInWindow(modelKey: string): number {
    const ts = this.timestamps.get(modelKey);
    if (!ts) return 0;
    this.evictExpired(ts);
    return ts.length;
  }

  /** Текущий лимит в минуту. */
  getLimit(): number {
    return this.limit;
  }

  /** Очистить состояние (для тестов / диагностики). */
  reset(): void {
    this.timestamps.clear();
    this.chains.clear();
  }

  private async acquireInternal(modelKey: string, signal?: AbortSignal): Promise<void> {
    let ts = this.timestamps.get(modelKey);
    if (!ts) {
      ts = [];
      this.timestamps.set(modelKey, ts);
    }
    this.evictExpired(ts);

    if (ts.length < this.limit) {
      ts.push(this.now());
      return;
    }

    /* Окно полное. Ждём, пока самый старый таймстамп выйдет из окна. */
    const oldest = ts[0]!;
    const waitMs = WINDOW_MS - (this.now() - oldest) + 1;
    if (waitMs > 0) {
      await sleepWithSignal(waitMs, signal);
    }
    /* После сна окно сдвинулось — повторно проверяем. */
    return this.acquireInternal(modelKey, signal);
  }

  private evictExpired(ts: number[]): void {
    const cutoff = this.now() - WINDOW_MS;
    while (ts.length > 0 && ts[0]! < cutoff) {
      ts.shift();
    }
  }
}

function envLimit(): number | undefined {
  const raw = process.env.BIBLIARY_VISION_OCR_RPM?.trim();
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("rate-limiter aborted"));
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = (): void => {
      cleanup();
      reject(new Error("rate-limiter aborted"));
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
  });
}

/* ─── Singleton ───────────────────────────────────────────────────────── */

let defaultLimiter: HeavyLaneRateLimiter | null = null;

/** Singleton для использования из ModelPool / конкретных vision-OCR call sites. */
export function getHeavyLaneRateLimiter(): HeavyLaneRateLimiter {
  if (!defaultLimiter) defaultLimiter = new HeavyLaneRateLimiter();
  return defaultLimiter;
}

/**
 * Применить vision-OCR rate из preferences (Иt 8Б).
 * Вызывается из applyRuntimeSideEffects.
 */
export function applyHeavyLaneRateLimiterPrefs(prefs: { visionOcrRpm?: number }): void {
  if (typeof prefs.visionOcrRpm === "number" && prefs.visionOcrRpm >= 1) {
    getHeavyLaneRateLimiter().updateLimit(prefs.visionOcrRpm);
  }
}

/* NB: Тестам обычно нужен изолированный экземпляр HeavyLaneRateLimiter с
   контролируемыми params (limitPerMinute, fake clock) — поэтому singleton
   reset hook не экспортируется. См. tests/heavy-lane-rate-limiter.test.ts —
   все тесты создают локальные `new HeavyLaneRateLimiter(...)` экземпляры. */
