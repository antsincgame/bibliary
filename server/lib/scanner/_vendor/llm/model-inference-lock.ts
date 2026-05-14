/**
 * Model Inference Lock — per-modelKey сериализация запросов к LM Studio.
 *
 * МОТИВАЦИЯ (диагноз 2026-05-05, Приказ Императора):
 *   LM Studio — один локальный процесс с одним пулом VRAM/CPU. Когда
 *   несколько подсистем (vision-meta, vision-illustration, vision-ocr,
 *   evaluator, text-meta) шлют ПАРАЛЛЕЛЬНЫЕ chat-completions на ОДНУ
 *   физическую модель (например, qwen/qwen3.5-35b-a3b — единственная
 *   loaded LLM), сервер захлёбывается и возвращает empty `""` под
 *   нагрузкой. Симптом: 280 `no JSON in response: ""` за 12 минут импорта
 *   при 6 успешных vision-meta. Книги queued в evaluator никогда не
 *   стартуют (medium-lane занят), illustration-worker внутри ещё
 *   умножает параллельность.
 *
 * АРХИТЕКТУРА:
 *   Простой синглтон KeyedAsyncMutex по `modelKey`. Любой код, делающий
 *   inference (через `chat()`, `chatWithTools()` или прямой fetch
 *   к /v1/chat/completions), оборачивает запрос в `runExclusiveOnModel`.
 *   Mutex сериализует ТОЛЬКО запросы к ОДНОЙ модели — параллелизм
 *   между разными моделями сохраняется (если у пользователя в LM Studio
 *   реально загружены разные модели для разных ролей).
 *
 *   Если modelKey пустой/null — обёртка выполняет fn без блокировки
 *   (graceful degrade — например тесты или legacy пути без model).
 *
 * НЕ ЗАМЕНЯЕТ:
 *   - `ModelPool` — управляет load/unload и refCount, не inference.
 *   - `ImportTaskScheduler` (heavy/medium/light lanes) — это политика
 *      concurrency на уровне tasks, а не на уровне HTTP-запросов к одной
 *      модели. Mutex здесь — последний рубеж сериализации.
 *   - `globalLlmLock` — probe-based (busy?), не блокирует.
 *
 * ИНВАРИАНТЫ:
 *   - Не вводит deadlock: каждый mutex per-key, нет вложенных захватов
 *     разных ключей в одной цепочке (callers всегда работают с одной
 *     моделью на запрос).
 *   - Не задерживает запросы к ДРУГИМ моделям.
 *   - При ошибке fn — release выполнится (try/finally в KeyedAsyncMutex).
 */

import { KeyedAsyncMutex } from "./async-mutex.js";

/**
 * Единый процесс-уровневый mutex для всех inference-вызовов к LM Studio.
 * НЕ создавай новых instance — переиспользуй этот singleton, иначе
 * параллельные fetch к одной модели снова обойдут сериализацию.
 */
const modelInferenceLock = new KeyedAsyncMutex(64);

/**
 * Сериализует выполнение `fn` относительно других вызовов с тем же `modelKey`.
 * Запросы к разным modelKey исполняются параллельно.
 *
 * Если `modelKey` пустой/null/undefined — выполняет fn без блокировки.
 * Это нужно для backward-compat (тесты, legacy пути без явной модели).
 *
 * @example
 * ```ts
 * await runExclusiveOnModel(request.model, async () => {
 *   return await fetch(`${baseUrl}/v1/chat/completions`, { ... });
 * });
 * ```
 */
export async function runExclusiveOnModel<T>(
  modelKey: string | null | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  if (!modelKey || modelKey.trim().length === 0) {
    return fn();
  }
  return modelInferenceLock.runExclusive(modelKey, fn);
}

/**
 * Размер registry mutex'ов — для UI/тестов диагностики (сколько разных
 * модельных ключей было задействовано с момента старта).
 */
export function modelInferenceLockSize(): number {
  return modelInferenceLock.size();
}

/** Только для тестов: очистить registry (между тестами). */
export function _resetModelInferenceLockForTests(): void {
  modelInferenceLock._resetForTests();
}
