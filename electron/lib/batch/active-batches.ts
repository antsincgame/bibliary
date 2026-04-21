/**
 * Module-level реестр активных dataset/batch операций.
 * Используется одновременно из dataset.ipc.ts и batch.ipc.ts —
 * вынесен в общий модуль, чтобы не было циклов импортов.
 *
 * Контракт: на каждый `batchName` (или `batchId`) — один AbortController.
 * Кладёт пайплайн при старте, удаляет в `finally`.
 */

const activeBatches = new Map<string, AbortController>();

export function registerActiveBatch(batchName: string, controller: AbortController): void {
  activeBatches.set(batchName, controller);
}

export function isActiveBatch(batchName: string): boolean {
  return activeBatches.has(batchName);
}

export function unregisterActiveBatch(batchName: string): void {
  activeBatches.delete(batchName);
}

/** Аборт всех активных батчей с заданной причиной (`shutdown`, `app-quit`). */
export function abortAllBatches(reason: string): void {
  for (const [id, ctrl] of activeBatches.entries()) {
    ctrl.abort(reason);
    activeBatches.delete(id);
  }
}
