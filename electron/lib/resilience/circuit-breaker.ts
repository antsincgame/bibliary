/**
 * Circuit Breaker для LM Studio HTTP API.
 *
 * НАЗНАЧЕНИЕ: предохранитель — когда LM Studio в состоянии падения (offline,
 * crash-loop, аппаратный OOM, бесконечный 5xx), не давать всему пайплайну
 * импорта молотить запросами, расходуя ресурсы и забивая лог-таблицы. Вместо
 * этого мгновенно отвечать `CircuitOpenError` пока сервер не очнётся.
 *
 * РЕАЛИЗАЦИЯ — классическая трёхсостоянийная (Nygard / Resilience4j / opossum):
 *
 *   CLOSED       Запросы идут как обычно. Считаем последние N в sliding window.
 *                Если errorRate ≥ failureThreshold (и достигли minimumRequests),
 *                переходим в OPEN.
 *
 *   OPEN         Все запросы немедленно валятся CircuitOpenError без обращения
 *                к сервису. Через resetTimeoutMs (с экспоненциальным backoff
 *                и full jitter — AWS recipe) переходим в HALF_OPEN.
 *
 *   HALF_OPEN    Пускаем ограниченное количество "пробных" запросов. Если
 *                halfOpenSuccessThreshold подряд успешных — возвращаемся в
 *                CLOSED (со сбросом backoff). Если хотя бы один fail — снова
 *                в OPEN с увеличенным таймаутом.
 *
 * ВЗАИМОДЕЙСТВИЕ С withPolicy:
 *   CB должен быть СНАРУЖИ от retry-цикла withPolicy: одна логическая операция
 *   (с ретраями) — это один success/failure для CB. Если CB будет внутри retry,
 *   он будет считать каждую попытку как отдельный запрос — и один таймаут
 *   откроет цепь после первой логической операции.
 *
 * ИСТОЧНИКИ:
 *   - Hystrix wiki / Resilience4j docs (sliding window + half-open).
 *   - AWS Architecture Blog "Exponential Backoff and Jitter" — full jitter
 *     рекомендован для распределённых систем чтобы избежать thundering herd.
 *   - opossum (Node.js) — параметры по умолчанию (50% threshold, 30s reset).
 */

import * as telemetry from "./telemetry.js";

export type CircuitState = "closed" | "open" | "half_open";

export interface CircuitBreakerOptions {
  /** Имя для логов и telemetry. */
  name: string;
  /** Размер sliding window (количество последних запросов). По умолчанию 20. */
  windowSize?: number;
  /** Минимум запросов в window до того как срабатывает threshold. По умолчанию 10. */
  minimumRequests?: number;
  /** Доля fail'ов в window для срабатывания (0..1). По умолчанию 0.5 (50%). */
  failureThreshold?: number;
  /** Базовый таймаут OPEN→HALF_OPEN (ms). По умолчанию 5000. */
  resetTimeoutMs?: number;
  /** Максимум resetTimeout для exponential backoff (ms). По умолчанию 60000. */
  maxResetTimeoutMs?: number;
  /** Сколько подряд успехов в HALF_OPEN для возврата в CLOSED. По умолчанию 2. */
  halfOpenSuccessThreshold?: number;
  /** Максимум одновременных пробных запросов в HALF_OPEN. По умолчанию 1. */
  halfOpenMaxConcurrent?: number;
  /** Источник времени (для тестов). */
  now?: () => number;
  /** Источник случайности (для тестов). */
  random?: () => number;
}

export interface CircuitBreakerStats {
  state: CircuitState;
  /** Сколько fail'ов в последнем window. */
  windowFailures: number;
  /** Сколько успехов в последнем window. */
  windowSuccesses: number;
  /** Текущий resetTimeout (с учётом backoff). */
  currentResetTimeoutMs: number;
  /** Сколько раз цепь открывалась подряд (для exponential backoff). */
  consecutiveOpens: number;
  /** Когда (ms epoch) цепь откроется → half_open в следующий раз. -1 если CLOSED/HALF_OPEN. */
  nextHalfOpenAt: number;
}

export class CircuitOpenError extends Error {
  readonly name = "CircuitOpenError";
  readonly circuitName: string;
  readonly nextHalfOpenAt: number;
  readonly currentResetTimeoutMs: number;

  constructor(circuitName: string, nextHalfOpenAt: number, currentResetTimeoutMs: number) {
    super(
      `Circuit "${circuitName}" is OPEN — service degraded, retry after ${Math.max(
        0,
        Math.ceil((nextHalfOpenAt - Date.now()) / 1000),
      )}s (current backoff ${Math.round(currentResetTimeoutMs)}ms)`,
    );
    this.circuitName = circuitName;
    this.nextHalfOpenAt = nextHalfOpenAt;
    this.currentResetTimeoutMs = currentResetTimeoutMs;
  }
}

/**
 * Sliding window — кольцевой буфер последних N результатов.
 * Хранит true=success, false=fail. Подсчёт O(window) на каждом insert,
 * что для window=20 дешёво.
 */
class SlidingWindow {
  private readonly buffer: boolean[];
  private readonly capacity: number;
  private size = 0;
  private head = 0;

  constructor(capacity: number) {
    this.capacity = Math.max(1, capacity);
    this.buffer = new Array<boolean>(this.capacity).fill(true);
  }

  push(success: boolean): void {
    this.buffer[this.head] = success;
    this.head = (this.head + 1) % this.capacity;
    if (this.size < this.capacity) this.size += 1;
  }

  size_(): number {
    return this.size;
  }

  failureRate(): number {
    if (this.size === 0) return 0;
    let fails = 0;
    for (let i = 0; i < this.size; i += 1) fails += this.buffer[i] ? 0 : 1;
    return fails / this.size;
  }

  failures(): number {
    let f = 0;
    for (let i = 0; i < this.size; i += 1) if (!this.buffer[i]) f += 1;
    return f;
  }

  successes(): number {
    let s = 0;
    for (let i = 0; i < this.size; i += 1) if (this.buffer[i]) s += 1;
    return s;
  }

  clear(): void {
    this.size = 0;
    this.head = 0;
  }
}

export class CircuitBreaker {
  private readonly opts: Required<Omit<CircuitBreakerOptions, "name">> & { name: string };
  private state: CircuitState = "closed";
  private window: SlidingWindow;
  private consecutiveOpens = 0;
  private currentResetTimeoutMs: number;
  private halfOpenAt = -1;
  private halfOpenSuccesses = 0;
  private halfOpenInflight = 0;

  constructor(options: CircuitBreakerOptions) {
    this.opts = {
      name: options.name,
      windowSize: options.windowSize ?? 20,
      minimumRequests: options.minimumRequests ?? 10,
      failureThreshold: options.failureThreshold ?? 0.5,
      resetTimeoutMs: options.resetTimeoutMs ?? 5_000,
      maxResetTimeoutMs: options.maxResetTimeoutMs ?? 60_000,
      halfOpenSuccessThreshold: options.halfOpenSuccessThreshold ?? 2,
      halfOpenMaxConcurrent: options.halfOpenMaxConcurrent ?? 1,
      now: options.now ?? (() => Date.now()),
      random: options.random ?? (() => Math.random()),
    };
    this.window = new SlidingWindow(this.opts.windowSize);
    this.currentResetTimeoutMs = this.opts.resetTimeoutMs;
  }

  /**
   * Главный entry: оборачивает операцию.
   * - Если CLOSED → пускает, считает результат.
   * - Если OPEN до halfOpenAt → CircuitOpenError немедленно.
   * - Если OPEN после halfOpenAt → переход в HALF_OPEN, пускает (если есть слот).
   * - Если HALF_OPEN с свободным слотом → пускает; иначе CircuitOpenError.
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    this.transitionIfReady();

    if (this.state === "open") {
      throw new CircuitOpenError(this.opts.name, this.halfOpenAt, this.currentResetTimeoutMs);
    }

    if (this.state === "half_open") {
      if (this.halfOpenInflight >= this.opts.halfOpenMaxConcurrent) {
        throw new CircuitOpenError(
          this.opts.name,
          this.halfOpenAt,
          this.currentResetTimeoutMs,
        );
      }
      this.halfOpenInflight += 1;
    }

    try {
      const result = await fn();
      this.recordSuccess();
      return result;
    } catch (err) {
      this.recordFailure();
      throw err;
    } finally {
      if (this.state === "half_open") {
        this.halfOpenInflight = Math.max(0, this.halfOpenInflight - 1);
      }
    }
  }

  /**
   * Зарегистрировать успех. В CLOSED — кладём в window. В HALF_OPEN —
   * проверяем halfOpenSuccessThreshold для возврата в CLOSED.
   */
  recordSuccess(): void {
    if (this.state === "half_open") {
      this.halfOpenSuccesses += 1;
      if (this.halfOpenSuccesses >= this.opts.halfOpenSuccessThreshold) {
        this.transitionToClosed();
      }
      return;
    }
    this.window.push(true);
  }

  /**
   * Зарегистрировать ошибку. В HALF_OPEN — мгновенно обратно в OPEN.
   * В CLOSED — push в window, проверка threshold.
   */
  recordFailure(): void {
    if (this.state === "half_open") {
      this.transitionToOpen();
      return;
    }
    this.window.push(false);
    if (
      this.window.size_() >= this.opts.minimumRequests &&
      this.window.failureRate() >= this.opts.failureThreshold
    ) {
      this.transitionToOpen();
    }
  }

  getState(): CircuitState {
    this.transitionIfReady();
    return this.state;
  }

  getStats(): CircuitBreakerStats {
    this.transitionIfReady();
    return {
      state: this.state,
      windowFailures: this.window.failures(),
      windowSuccesses: this.window.successes(),
      currentResetTimeoutMs: this.currentResetTimeoutMs,
      consecutiveOpens: this.consecutiveOpens,
      nextHalfOpenAt: this.state === "open" ? this.halfOpenAt : -1,
    };
  }

  /** Принудительный сброс — для UI кнопки "сброс цепи" или диагностики. */
  reset(): void {
    this.transitionToClosed();
  }

  private transitionIfReady(): void {
    if (this.state === "open" && this.opts.now() >= this.halfOpenAt) {
      this.state = "half_open";
      this.halfOpenSuccesses = 0;
      this.halfOpenInflight = 0;
      telemetry.logEvent({
        type: "lmstudio.circuit_half_open",
        name: this.opts.name,
        backoffMs: this.currentResetTimeoutMs,
      });
    }
  }

  private transitionToOpen(): void {
    this.state = "open";
    this.consecutiveOpens += 1;
    /* Exponential backoff с full jitter (AWS recipe):
       sleep = random_between(0, min(cap, base * 2^attempt))
       Это распределяет восстановление по времени и предотвращает thundering herd
       когда сервис вернулся и все клиенты разом долбят его. */
    const exp = Math.min(
      this.opts.maxResetTimeoutMs,
      this.opts.resetTimeoutMs * Math.pow(2, this.consecutiveOpens - 1),
    );
    const jittered = this.opts.random() * exp;
    this.currentResetTimeoutMs = Math.max(this.opts.resetTimeoutMs, Math.round(jittered));
    this.halfOpenAt = this.opts.now() + this.currentResetTimeoutMs;
    this.halfOpenInflight = 0;
    this.halfOpenSuccesses = 0;
    telemetry.logEvent({
      type: "lmstudio.circuit_open",
      name: this.opts.name,
      backoffMs: this.currentResetTimeoutMs,
      consecutiveOpens: this.consecutiveOpens,
      windowFailures: this.window.failures(),
      windowSuccesses: this.window.successes(),
    });
  }

  private transitionToClosed(): void {
    const wasOpen = this.state !== "closed";
    this.state = "closed";
    this.window.clear();
    this.halfOpenSuccesses = 0;
    this.halfOpenInflight = 0;
    this.halfOpenAt = -1;
    this.consecutiveOpens = 0;
    this.currentResetTimeoutMs = this.opts.resetTimeoutMs;
    if (wasOpen) {
      telemetry.logEvent({
        type: "lmstudio.circuit_closed",
        name: this.opts.name,
      });
    }
  }
}

/* ─── Singleton для LM Studio ───────────────────────────────────────── */

let lmStudioBreaker: CircuitBreaker | null = null;

/**
 * Глобальный CB для LM Studio HTTP API.
 *
 * Параметры подобраны из практики:
 *   windowSize=20    — устаканившийся EMA-период (~10 импортных запросов)
 *   minimumRequests=10 — не открываем при разовых сбоях
 *   failureThreshold=0.5 — половина в окне = деградация
 *   resetTimeoutMs=5000  — быстрый первый half-open
 *   maxResetTimeoutMs=60000 — потолок 1 минута
 */
export function getLmStudioCircuitBreaker(): CircuitBreaker {
  if (!lmStudioBreaker) {
    lmStudioBreaker = new CircuitBreaker({
      name: "lmstudio",
      windowSize: 20,
      minimumRequests: 10,
      failureThreshold: 0.5,
      resetTimeoutMs: 5_000,
      maxResetTimeoutMs: 60_000,
      halfOpenSuccessThreshold: 2,
      halfOpenMaxConcurrent: 1,
    });
  }
  return lmStudioBreaker;
}

/** Сброс singleton (для тестов и hot-reload). */
export function _resetLmStudioCircuitBreakerForTests(): void {
  lmStudioBreaker = null;
}
