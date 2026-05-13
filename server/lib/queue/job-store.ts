import { ID, Permission, Query, Role } from "node-appwrite";

import { COLLECTIONS, getAppwrite, isAppwriteCode, type RawDoc } from "../appwrite.js";
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
  const { databases, databaseId } = getAppwrite();
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

export async function getJob(userId: string, jobId: string): Promise<JobDoc | null> {
  const { databases, databaseId } = getAppwrite();
  try {
    const raw = await databases.getDocument<RawJob>(
      databaseId,
      COLLECTIONS.datasetJobs,
      jobId,
    );
    if (raw.userId !== userId) return null;
    return toJob(raw);
  } catch (err) {
    if (isAppwriteCode(err, 404)) return null;
    throw err;
  }
}

/** Bypass user-scope check — используется worker loop'ом. */
export async function getJobRaw(jobId: string): Promise<JobDoc | null> {
  const { databases, databaseId } = getAppwrite();
  try {
    const raw = await databases.getDocument<RawJob>(
      databaseId,
      COLLECTIONS.datasetJobs,
      jobId,
    );
    return toJob(raw);
  } catch (err) {
    if (isAppwriteCode(err, 404)) return null;
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
  const { databases, databaseId } = getAppwrite();
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
  const { databases, databaseId } = getAppwrite();
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
  const { databases, databaseId } = getAppwrite();
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
  const { databases, databaseId } = getAppwrite();
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
  const { databases, databaseId } = getAppwrite();
  try {
    await databases.updateDocument(databaseId, COLLECTIONS.datasetJobs, jobId, {
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    if (!isAppwriteCode(err, 404)) throw err;
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
  const { databases, databaseId } = getAppwrite();
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
    if (isAppwriteCode(err, 404)) return null;
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
