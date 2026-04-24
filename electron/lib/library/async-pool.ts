/**
 * Generic async concurrency pool — обрабатывает поток входов с ограничением
 * на количество одновременных воркеров. Используется parser pool в Фазе 2
 * (CPU-задача), позже переиспользуется evaluator slots в Фазе 4 (LLM).
 *
 * Контракт:
 *   - Источник — любой `AsyncIterable<T>` (например, async generator).
 *   - Concurrency >= 1: при 1 поведение строго последовательное.
 *   - Порядок выдачи результатов != порядку источника. Если caller'у нужен
 *     порядок — пусть пишет index из результата.
 *   - Worker может бросить — ошибка приходит в результате (`error` поле).
 *     Pool НЕ останавливается на ошибке одного элемента, иначе одна
 *     битая книга валит партию из 10k.
 *   - Если вызывающий cancel'ит async-iteration (break/return), inflight
 *     promises отбрасываются (без unhandled rejection — мы их await'им).
 */

export interface PoolItem<T> {
  /** Порядковый номер из источника, 0-based. */
  index: number;
  /** Исходный элемент. */
  input: T;
}

export type PoolResult<T, U> =
  | (PoolItem<T> & { ok: true; value: U })
  | (PoolItem<T> & { ok: false; error: Error });

/**
 * Запускает `worker` на каждом элементе `source` с ограничением `concurrency`
 * одновременных задач. Yields результаты по мере их завершения (без сохранения
 * порядка источника).
 */
export async function* runWithConcurrency<T, U>(
  source: AsyncIterable<T>,
  concurrency: number,
  worker: (input: T, index: number) => Promise<U>,
): AsyncGenerator<PoolResult<T, U>> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`runWithConcurrency: concurrency must be >= 1, got ${concurrency}`);
  }

  const iterator = source[Symbol.asyncIterator]();
  const inflight = new Map<number, Promise<PoolResult<T, U>>>();
  let nextIndex = 0;
  let sourceExhausted = false;

  const startNext = async (): Promise<boolean> => {
    if (sourceExhausted) return false;
    const step = await iterator.next();
    if (step.done) {
      sourceExhausted = true;
      return false;
    }
    const index = nextIndex++;
    const input = step.value;
    const promise = worker(input, index)
      .then<PoolResult<T, U>>((value) => ({ index, input, ok: true, value }))
      .catch<PoolResult<T, U>>((err) => ({
        index,
        input,
        ok: false,
        error: err instanceof Error ? err : new Error(String(err)),
      }));
    inflight.set(index, promise);
    return true;
  };

  /* Прогрев: заполняем пул. */
  while (inflight.size < concurrency) {
    const started = await startNext();
    if (!started) break;
  }

  while (inflight.size > 0) {
    const settled = await Promise.race(inflight.values());
    inflight.delete(settled.index);
    yield settled;
    /* После каждого готового слота пробуем дозаполнить. */
    while (inflight.size < concurrency) {
      const started = await startNext();
      if (!started) break;
    }
  }
}
