/**
 * Shared state + lifecycle для dataset-v2 IPC.
 *
 * Извлечено из `dataset-v2.ipc.ts` (Phase 3.2 cross-platform roadmap, 2026-04-30).
 *
 * Содержит:
 *   - `activeJobs` — registry single-extraction abort controllers
 *   - `activeBatches` — registry batch abort controllers
 *   - `abortAllDatasetV2` — shutdown helper для main.ts
 *   - `killAllSynthChildren` — back-compat no-op (синтез теперь in-process)
 *   - `DEFAULT_COLLECTION` — fallback Qdrant collection name
 */

import { abortAllExtractionJobs } from "../lib/dataset-v2/coordinator-pipeline.js";

export const DEFAULT_COLLECTION = "delta-knowledge";

/**
 * Iter 7: cancel-batch — Map<batchId, AbortController> поверх activeJobs.
 *
 * Без этого `dataset-v2:cancel` останавливал бы только текущую
 * runExtraction внутри батча, а цикл `for (let i…)` тут же шёл к
 * следующей книге. Теперь UI вызывает `dataset-v2:cancel-batch(batchId)`
 * → батч-цикл проверяет signal в начале каждой итерации и выходит чисто.
 */
export const activeJobs = new Map<string, AbortController>();
export const activeBatches = new Map<string, AbortController>();

/**
 * killAllSynthChildren — back-compat: раньше синтез запускался как child
 * process через `npx tsx`, и main.ts при выходе должен был их прибить. Сейчас
 * синтез — обычный модуль внутри main, его отменяет `abortAllDatasetV2` через
 * activeJobs. Функция оставлена пустой, чтобы main.ts не пришлось трогать.
 */
export function killAllSynthChildren(): void {
  /* no-op: synth теперь in-process, отменяется через activeJobs */
}

export function abortAllDatasetV2(reason: string): void {
  for (const [id, ctrl] of activeJobs.entries()) {
    ctrl.abort(reason);
    activeJobs.delete(id);
  }
  for (const [bid, ctrl] of activeBatches.entries()) {
    ctrl.abort(reason);
    activeBatches.delete(bid);
  }
  /* Also clear coordinator-side tracking so the watchdog/shutdown path
     doesn't try to pause a job whose AbortController is already gone. */
  abortAllExtractionJobs(reason);
}
