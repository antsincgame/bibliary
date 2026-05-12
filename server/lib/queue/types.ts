/**
 * Pure helpers для extraction-queue state machine — изолированы от
 * Appwrite, тестируются отдельно.
 */

export type JobState = "queued" | "running" | "done" | "failed" | "cancelled";

export const ALL_JOB_STATES = [
  "queued",
  "running",
  "done",
  "failed",
  "cancelled",
] as const satisfies readonly JobState[];

const TERMINAL_STATES: ReadonlySet<JobState> = new Set([
  "done",
  "failed",
  "cancelled",
]);

export function isTerminalState(state: JobState): boolean {
  return TERMINAL_STATES.has(state);
}

/**
 * Допустимые переходы state machine:
 *   queued  → running, cancelled
 *   running → done, failed, cancelled
 *   terminal → ничего (job завершён)
 *
 * Защищает worker loop от race-conditions когда POST /cancel приходит
 * после того как job уже done — мы не должны переписать done в cancelled.
 */
export function canTransition(from: JobState, to: JobState): boolean {
  if (isTerminalState(from)) return false;
  if (from === "queued") return to === "running" || to === "cancelled";
  if (from === "running") return to === "done" || to === "failed" || to === "cancelled";
  return false;
}

/**
 * Сериализуемый snapshot job-документа для UI / SSE.
 * Соответствует dataset_jobs collection schema из appwrite-bootstrap.
 */
export interface JobDoc {
  id: string;
  userId: string;
  state: JobState;
  /** bookId — для single-book extraction. Для будущего batch — batchId агрегирующий несколько books. */
  bookId: string | null;
  stage: string | null;
  booksTotal: number;
  booksProcessed: number;
  conceptsExtracted: number;
  targetCollection: string | null;
  extractModel: string | null;
  exportFileId: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}
