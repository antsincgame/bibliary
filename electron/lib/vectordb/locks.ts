/**
 * Per-table writer serialization для LanceDB.
 *
 * LanceDB поддерживает множественные concurrent reads, но writes
 * (add / merge_insert / delete / create_index / drop_table) на одну
 * таблицу должны идти последовательно — иначе можно получить partial
 * state или corrupt manifest.
 *
 * Используем существующий `KeyedAsyncMutex` из llm-слоя — там тот же
 * паттерн «один writer на ключ» уже отлажен.
 */

import { KeyedAsyncMutex } from "../llm/async-mutex.js";

const tableMutex = new KeyedAsyncMutex(64);

/** Запустить writer-операцию под mutex'ом для данной таблицы. */
export function withTableWriteLock<T>(tableName: string, fn: () => Promise<T>): Promise<T> {
  return tableMutex.runExclusive(tableName, fn);
}

/** Только для тестов: сбросить state mutex'ов. */
export function _resetLocksForTesting(): void {
  tableMutex._resetForTests();
}
