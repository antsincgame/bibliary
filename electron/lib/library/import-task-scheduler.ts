/**
 * Import Task Scheduler — оркестратор LLM-задач при импорте библиотеки.
 *
 * ПРОБЛЕМА БЕЗ SCHEDULER:
 *   import.ts параллельно обрабатывает 4 книги (CPU-bound parser pool).
 *   Внутри каждой — vision-meta (medium model), evaluator (heavy model),
 *   illustration (heavy vision model) могут стартовать почти одновременно.
 *   Результат: 4 книги × 3 LLM роли = 12 параллельных задач, которые
 *   через withModel дёргают одновременно тяжёлые загрузки в LM Studio.
 *
 * РЕШЕНИЕ:
 *   Scheduler делит задачи на три lane по тяжести модели:
 *     - light  (≤ 8 GB): высокий параллелизм, до 8 одновременно
 *     - medium (8..16 GB): умеренный, до 3 одновременно
 *     - heavy  (> 16 GB): СТРОГО 1 одновременно
 *
 *   Каждая задача — это `() => Promise<T>`, scheduler не знает что внутри.
 *   Caller сам выбирает lane при enqueue (через тип задачи).
 *
 * АРХИТЕКТУРНЫЙ КОНТРАКТ:
 *   - Scheduler НЕ загружает модели — это работа ModelPool.
 *   - Scheduler НЕ знает про LM Studio — оперирует абстрактными task'ами.
 *   - Production-интеграция (Iter 7+ smart-import-pipeline): converters/{calibre,
 *     cbz, multi-tiff}.ts оборачивают heavy CPU-операции в `enqueue("heavy")`,
 *     evaluator-queue.ts — в `enqueue("medium")`, illustration-worker.ts — в
 *     `enqueue("heavy")`. Парсер-пул в import.ts остаётся отдельным CPU-bound
 *     orchestrator-ом (см. docs/smart-import-pipeline.md).
 *
 * NB: light/medium/heavy именуются по характеру МОДЕЛИ, не задачи.
 *     Задача "extract metadata from cover" сама по себе лёгкая, но если
 *     требует vision_meta модель которая весит 12 GB — это medium lane.
 */

import type { ModelWeight } from "../llm/model-size-classifier.js";
import type { AimdController } from "../llm/aimd-controller.js";

/**
 * Иt 8В.MAIN.1.5: io lane удалена как мёртвая — за всю историю Pipeline
 * (Iter 7+ smart-import) ни один caller её не использовал. Все архивные
 * extract / atomic copy уже сериализованы внутри собственных модулей
 * (archive-extractor через node-stream-zip, converters/cache через
 * fs.rename). Если в будущем появится FS-bound задача требующая глобального
 * лимита — вернуть `"io"` в TaskLane и SchedulerSnapshot.
 */
export type TaskLane = ModelWeight;

export interface ImportSchedulerOptions {
  /** Лимит для light (≤ 8 GB модели). Default: 8. */
  lightConcurrency?: number;
  /** Лимит для medium. Default: 3. */
  mediumConcurrency?: number;
  /** Лимит для heavy. Default: 1 (строгий). */
  heavyConcurrency?: number;
  /** Источник времени (для тестов). По умолчанию Date.now. */
  now?: () => number;
}

export interface SchedulerSnapshot {
  light: { running: number; queued: number };
  medium: { running: number; queued: number };
  heavy: { running: number; queued: number };
}

interface QueuedTask<T> {
  fn: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
}

interface Lane {
  limit: number;
  running: number;
  queue: QueuedTask<unknown>[];
}

const DEFAULT_LIGHT_CONCURRENCY = 8;
const DEFAULT_MEDIUM_CONCURRENCY = 3;
const DEFAULT_HEAVY_CONCURRENCY = 1;

export class ImportTaskScheduler {
  private readonly lanes: Record<TaskLane, Lane>;
  /** Опциональный AIMD-контроллер на lane — подстраивает limit на основе success/latency. */
  private readonly aimd: Partial<Record<TaskLane, AimdController>> = {};
  /** Источник времени (для тестов). */
  private readonly now: () => number;

  constructor(opts: ImportSchedulerOptions = {}) {
    this.lanes = {
      light: { limit: opts.lightConcurrency ?? DEFAULT_LIGHT_CONCURRENCY, running: 0, queue: [] },
      medium: { limit: opts.mediumConcurrency ?? DEFAULT_MEDIUM_CONCURRENCY, running: 0, queue: [] },
      heavy: { limit: opts.heavyConcurrency ?? DEFAULT_HEAVY_CONCURRENCY, running: 0, queue: [] },
    };
    this.now = opts.now ?? ((): number => Date.now());
  }

  /**
   * Подключить AIMD-контроллер к lane.
   *
   * Каждый завершённый task в этом lane передаётся в `controller.record()`.
   * Контроллер сам решает когда менять limit и через `onLimitChange` callback
   * (который мы здесь подменяем) применяет его к scheduler.
   *
   * Контракт: caller сам выставляет controller.opts.onLimitChange — мы
   * добавляем wrapper для setLimit поверх существующего callback (если есть).
   */
  attachAimd(lane: TaskLane, controller: AimdController): void {
    this.aimd[lane] = controller;
  }

  detachAimd(lane: TaskLane): void {
    delete this.aimd[lane];
  }

  /**
   * Поставить задачу в lane и получить promise результата.
   *
   * Если в lane свободный слот — задача стартует немедленно.
   * Иначе — ждёт в FIFO очереди освобождения слота.
   *
   * Контракт: scheduler не знает про загрузку моделей — он только лимитирует
   * число одновременных fn вызовов. Per-lane FIFO порядок гарантирован.
   */
  enqueue<T>(lane: TaskLane, fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const target = this.lanes[lane];
      const task: QueuedTask<T> = { fn, resolve, reject };
      target.queue.push(task as QueuedTask<unknown>);
      this.drain(lane);
    });
  }

  /**
   * Текущее состояние всех lane'ов — для UI телеметрии.
   */
  getSnapshot(): SchedulerSnapshot {
    return {
      light: snap(this.lanes.light),
      medium: snap(this.lanes.medium),
      heavy: snap(this.lanes.heavy),
    };
  }

  /**
   * Динамическое изменение лимитов (например, юзер двигает слайдер).
   * Снижение лимита НЕ прерывает уже бегущие задачи — они отрабатывают
   * до конца, новые запускаются с учётом нового лимита.
   */
  setLimit(lane: TaskLane, limit: number): void {
    if (!Number.isFinite(limit) || limit < 1) return;
    this.lanes[lane].limit = Math.floor(limit);
    /* После повышения лимита — попробовать заполнить освободившиеся слоты. */
    this.drain(lane);
  }

  /** Очистить все очереди — отклоняет ожидающие задачи. Бегущие не трогает. */
  drainAndCancelPending(reason = "scheduler reset"): number {
    let cancelled = 0;
    for (const lane of Object.values(this.lanes)) {
      while (lane.queue.length > 0) {
        const task = lane.queue.shift()!;
        task.reject(new Error(reason));
        cancelled += 1;
      }
    }
    return cancelled;
  }

  private drain(lane: TaskLane): void {
    const target = this.lanes[lane];
    while (target.running < target.limit && target.queue.length > 0) {
      const task = target.queue.shift()!;
      target.running += 1;
      void this.runTask(lane, task);
    }
  }

  private async runTask(lane: TaskLane, task: QueuedTask<unknown>): Promise<void> {
    const startedAt = this.now();
    let success = false;
    try {
      const result = await task.fn();
      success = true;
      task.resolve(result);
    } catch (err) {
      task.reject(err);
    } finally {
      this.lanes[lane].running -= 1;
      const latencyMs = this.now() - startedAt;
      const aimd = this.aimd[lane];
      if (aimd) {
        try {
          aimd.record(success, latencyMs);
          /* AIMD сам через onLimitChange callback вызывает scheduler.setLimit
             (если caller настроил). Также синхронизуем напрямую: */
          const desired = aimd.getCurrentLimit();
          if (desired !== this.lanes[lane].limit) {
            this.setLimit(lane, desired);
          }
        } catch (e) {
          console.warn(`[scheduler] AIMD record failed for lane=${lane}`, e);
        }
      }
      this.drain(lane);
    }
  }
}

function snap(lane: Lane): { running: number; queued: number } {
  return { running: lane.running, queued: lane.queue.length };
}

/* ─── Singleton ───────────────────────────────────────────────────────── */

let defaultScheduler: ImportTaskScheduler | null = null;

/**
 * Singleton scheduler. Создаётся лениво с дефолтными лимитами;
 * `applyImportSchedulerPrefs(prefs)` вызывается из preferences.ipc
 * `applyRuntimeSideEffects` чтобы синхронизировать с актуальными prefs
 * (Иt 8Б: schedulerLight/Medium/HeavyConcurrency как single source of truth).
 */
export function getImportScheduler(): ImportTaskScheduler {
  if (!defaultScheduler) defaultScheduler = new ImportTaskScheduler();
  return defaultScheduler;
}

/**
 * Применить лимиты из preferences к singleton scheduler.
 * Вызывается из bootstrap (после initPreferencesStore) и из IPC
 * applyRuntimeSideEffects (после каждого preferences:set).
 *
 * Не пересоздаёт scheduler: setLimit лишь меняет capacity, бегущие
 * задачи продолжаются, новые слоты освобождаются по мере завершения.
 */
export function applyImportSchedulerPrefs(prefs: {
  schedulerLightConcurrency?: number;
  schedulerMediumConcurrency?: number;
  schedulerHeavyConcurrency?: number;
}): void {
  const scheduler = getImportScheduler();
  if (typeof prefs.schedulerLightConcurrency === "number") {
    scheduler.setLimit("light", prefs.schedulerLightConcurrency);
  }
  if (typeof prefs.schedulerMediumConcurrency === "number") {
    scheduler.setLimit("medium", prefs.schedulerMediumConcurrency);
  }
  if (typeof prefs.schedulerHeavyConcurrency === "number") {
    scheduler.setLimit("heavy", prefs.schedulerHeavyConcurrency);
  }
}

export function _resetImportSchedulerForTests(): void {
  defaultScheduler = null;
}
