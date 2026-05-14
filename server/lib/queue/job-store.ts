import { ID, Permission, Query, Role } from "../store/query.js";

import { COLLECTIONS, getDatastore, isStoreErrorCode, type RawDoc } from "../datastore.js";
import { canTransition, type JobDoc, type JobState } from "./types.js";

/**
 * Persistence layer для extraction queue — поверх Appwrite collection
 * `dataset_jobs`. State machine + ownership checks + per-user query.
 *
 * Single-pod worker ставит свою cache внутри extraction-queue.ts;
 * этот модуль pure DB-доступ без runtime state.
 */

type RawJob = RawDoc & {
  userId: string;
  state: JobState;
  /** `batchId` field в Appwrite schema используется как bookId для single-book extraction. */
  batchId?: string;
  stage?: string;
  booksTotal?: number;
  booksProcessed?: number;
  conceptsExtracted?: number;
  targetCollection?: string;
  extractModel?: string;
  exportFileId?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
};

function toJob(raw: RawJob): JobDoc {
  return {
    id: raw.$id,
    userId: raw.userId,
    state: raw.state,
    bookId: raw.batchId ?? null,
    stage: raw.stage ?? null,
    booksTotal: raw.booksTotal ?? 0,
    booksProcessed: raw.booksProcessed ?? 0,
    conceptsExtracted: raw.conceptsExtracted ?? 0,
    targetCollection: raw.targetCollection ?? null,
    extractModel: raw.extractModel ?? null,
    exportFileId: raw.exportFileId ?? null,
    error: raw.error ?? null,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
}

export interface CreateJobInput {
  userId: string;
  bookId: string;
  collection?: string;
  extractModel?: string;
}

export async function createJob(input: CreateJobInput): Promise<JobDoc> {
  const { databases, databaseId } = getDatastore();
  const nowIso = new Date().toISOString();
  const doc: Record<string, unknown> = {
    userId: input.userId,
    batchId: input.bookId,
    state: "queued" as JobState,
    stage: "queued",
    booksTotal: 1,
    booksProcessed: 0,
    conceptsExtracted: 0,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  if (input.collection) doc["targetCollection"] = input.collection;
  if (input.extractModel) doc["extractModel"] = input.extractModel;
  const raw = await databases.createDocument<RawJob>(
    databaseId,
    COLLECTIONS.datasetJobs,
    ID.unique(),
    doc,
    [
      Permission.read(Role.user(input.userId)),
      Permission.update(Role.user(input.userId)),
      Permission.delete(Role.user(input.userId)),
      Permission.read(Role.team("admin")),
    ],
  );
  return toJob(raw);
}

/**
 * Phase 8b — export build job (sibling to extraction `createJob`). Same
 * `dataset_jobs` collection, distinguished by `stage` prefix `build:` so
 * the two queues (extraction-queue and export-queue) can each filter
 * their own queued docs on boot resume without a schema migration.
 *
 *   stage  = `build:<format>`  (jsonl / sharegpt / chatml)
 *   state  = "queued"           → worker pickup
 *   bookId = null               (export is collection-wide, not book-scoped)
 */
export async function createExportJob(input: {
  userId: string;
  collection: string;
  format: string;
}): Promise<JobDoc> {
  const { databases, databaseId } = getDatastore();
  const nowIso = new Date().toISOString();
  const doc: Record<string, unknown> = {
    userId: input.userId,
    state: "queued" as JobState,
    stage: `build:${input.format}`,
    booksTotal: 0,
    booksProcessed: 0,
    conceptsExtracted: 0,
    targetCollection: input.collection,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  const raw = await databases.createDocument<RawJob>(
    databaseId,
    COLLECTIONS.datasetJobs,
    ID.unique(),
    doc,
    [
      Permission.read(Role.user(input.userId)),
      Permission.update(Role.user(input.userId)),
      Permission.delete(Role.user(input.userId)),
      Permission.read(Role.team("admin")),
    ],
  );
  return toJob(raw);
}

/**
 * True if the job's stage marker identifies it as an export build, not
 * an extraction. Used by each queue's resumeFromAppwrite() to skip the
 * other queue's queued docs. Keep this predicate in one place so the
 * stage convention can't drift between writer (createExportJob) and
 * readers.
 */
export function isExportJobStage(stage: string | null | undefined): boolean {
  return typeof stage === "string" && stage.startsWith("build:");
}

export async function getJob(userId: string, jobId: string): Promise<JobDoc | null> {
  const { databases, databaseId } = getDatastore();
  try {
    const raw = await databases.getDocument<RawJob>(
      databaseId,
      COLLECTIONS.datasetJobs,
      jobId,
    );
    if (raw.userId !== userId) return null;
    return toJob(raw);
  } catch (err) {
    if (isStoreErrorCode(err, 404)) return null;
    throw err;
  }
}

/** Bypass user-scope check — используется worker loop'ом. */
export async function getJobRaw(jobId: string): Promise<JobDoc | null> {
  const { databases, databaseId } = getDatastore();
  try {
    const raw = await databases.getDocument<RawJob>(
      databaseId,
      COLLECTIONS.datasetJobs,
      jobId,
    );
    return toJob(raw);
  } catch (err) {
    if (isStoreErrorCode(err, 404)) return null;
    throw err;
  }
}

export interface ListJobsOptions {
  state?: JobState;
  limit?: number;
  offset?: number;
}

export async function listUserJobs(
  userId: string,
  opts: ListJobsOptions = {},
): Promise<{ rows: JobDoc[]; total: number }> {
  const { databases, databaseId } = getDatastore();
  const queries: string[] = [
    Query.equal("userId", userId),
    Query.orderDesc("createdAt"),
    Query.limit(Math.min(200, Math.max(1, opts.limit ?? 50))),
    Query.offset(Math.max(0, opts.offset ?? 0)),
  ];
  if (opts.state) queries.push(Query.equal("state", opts.state));
  const list = await databases.listDocuments<RawJob>(
    databaseId,
    COLLECTIONS.datasetJobs,
    queries,
  );
  return { rows: list.documents.map(toJob), total: list.total };
}

/**
 * Phase 11b — cross-user job listing for the admin panel. Same shape
 * as listUserJobs but without the userId equality clause, so admins
 * can survey queue depth, failures, and stuck running jobs across all
 * users from one place.
 */
export async function listAllJobs(opts: {
  state?: JobState;
  limit?: number;
  offset?: number;
} = {}): Promise<{ rows: JobDoc[]; total: number }> {
  const { databases, databaseId } = getDatastore();
  const queries: string[] = [
    Query.orderDesc("createdAt"),
    Query.limit(Math.min(200, Math.max(1, opts.limit ?? 50))),
    Query.offset(Math.max(0, opts.offset ?? 0)),
  ];
  if (opts.state) queries.push(Query.equal("state", opts.state));
  const list = await databases.listDocuments<RawJob>(
    databaseId,
    COLLECTIONS.datasetJobs,
    queries,
  );
  return { rows: list.documents.map(toJob), total: list.total };
}

/** Все queued jobs (всех users) — для re-queue на server bootstrap. */
export async function listQueuedJobs(): Promise<JobDoc[]> {
  const { databases, databaseId } = getDatastore();
  const all: JobDoc[] = [];
  let offset = 0;
  const pageSize = 100;
  while (true) {
    const list = await databases.listDocuments<RawJob>(
      databaseId,
      COLLECTIONS.datasetJobs,
      [
        Query.equal("state", "queued"),
        Query.orderAsc("createdAt"),
        Query.limit(pageSize),
        Query.offset(offset),
      ],
    );
    all.push(...list.documents.map(toJob));
    if (list.documents.length < pageSize) break;
    offset += pageSize;
  }
  return all;
}

/**
 * Jobs застрявшие в state="running" дольше staleAfterMs — kандидаты
 * для orphan-reset (backend крашнул mid-extraction, jobs не получили
 * финальный transition). Caller сравнивает updatedAt с now - staleAfterMs.
 */
export async function listStaleRunningJobs(staleAfterMs: number): Promise<JobDoc[]> {
  const { databases, databaseId } = getDatastore();
  const all: JobDoc[] = [];
  const threshold = new Date(Date.now() - staleAfterMs).toISOString();
  let offset = 0;
  const pageSize = 100;
  while (true) {
    const list = await databases.listDocuments<RawJob>(
      databaseId,
      COLLECTIONS.datasetJobs,
      [
        Query.equal("state", "running"),
        Query.lessThan("updatedAt", threshold),
        Query.orderAsc("updatedAt"),
        Query.limit(pageSize),
        Query.offset(offset),
      ],
    );
    all.push(...list.documents.map(toJob));
    if (list.documents.length < pageSize) break;
    offset += pageSize;
  }
  return all;
}

/**
 * Touch updatedAt без других изменений — heartbeat для worker'а во
 * время длинного run'а. Не вызывает transitionJob — просто updateDocument
 * с пустым patch (Appwrite автоматом ставит свой $updatedAt, плюс мы
 * пишем кастомный updatedAt поле для query consistency).
 */
export async function touchJob(jobId: string): Promise<void> {
  const { databases, databaseId } = getDatastore();
  try {
    await databases.updateDocument(databaseId, COLLECTIONS.datasetJobs, jobId, {
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    if (!isStoreErrorCode(err, 404)) throw err;
  }
}

export interface UpdateJobPatch {
  state?: JobState;
  stage?: string;
  booksProcessed?: number;
  conceptsExtracted?: number;
  extractModel?: string;
  error?: string;
}

/**
 * Updates job document — НЕ проверяет state-machine semantics
 * (caller должен сам убедиться через canTransition). Возвращает обновлённый
 * JobDoc или null если документ удалён.
 */
export async function updateJob(
  jobId: string,
  patch: UpdateJobPatch,
): Promise<JobDoc | null> {
  const { databases, databaseId } = getDatastore();
  const doc: Record<string, unknown> = { updatedAt: new Date().toISOString() };
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) doc[k] = v;
  }
  try {
    const raw = await databases.updateDocument<RawJob>(
      databaseId,
      COLLECTIONS.datasetJobs,
      jobId,
      doc,
    );
    return toJob(raw);
  } catch (err) {
    if (isStoreErrorCode(err, 404)) return null;
    throw err;
  }
}

/**
 * Transition с проверкой state machine. Возвращает true если update
 * прошёл, false если transition forbidden (например, попытка
 * cancel done-job).
 */
export async function transitionJob(
  jobId: string,
  to: JobState,
  patch: UpdateJobPatch = {},
): Promise<boolean> {
  const current = await getJobRaw(jobId);
  if (!current) return false;
  if (!canTransition(current.state, to)) return false;
  const result = await updateJob(jobId, { ...patch, state: to });
  return result !== null;
}
