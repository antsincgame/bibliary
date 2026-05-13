// @ts-check
/**
 * Phase 11 — admin panel api-client.
 *
 * Все endpoints под /api/admin guarded server-side requireAdmin → 403
 * для non-admin users. Renderer feature-detects через api.auth.meOrNull()
 * → user.role === "admin" перед монтированием admin route.
 */
import { http } from "./http.js";

/** @typedef {{
 *   id: string,
 *   email: string,
 *   name: string | null,
 *   role: "user" | "admin",
 *   deactivated: boolean,
 *   createdAt: string,
 *   lastLoginAt: string | null,
 *   libraryQuotaBytes: number | null,
 * }} AdminUserRow */

/** @typedef {{ rows: AdminUserRow[], total: number }} AdminUserList */

/** @typedef {{
 *   id: string,
 *   userId: string,
 *   state: string,
 *   bookId: string | null,
 *   stage: string | null,
 *   targetCollection: string | null,
 *   conceptsExtracted: number,
 *   createdAt: string,
 *   updatedAt: string,
 *   error: string | null,
 * }} AdminJobRow */

/** @typedef {{ rows: AdminJobRow[], total: number }} AdminJobList */

/** @typedef {{
 *   userId: string,
 *   bookCount: number,
 *   bytesOriginal: number,
 *   bytesMarkdown: number,
 *   bytesCovers: number,
 *   bytesDatasets: number,
 *   totalBytes: number,
 *   partial: boolean,
 * }} StorageUsage */

/** @typedef {{
 *   id: string,
 *   userId: string | null,
 *   action: string,
 *   target: string | null,
 *   metadata: Record<string, unknown> | null,
 *   ip: string | null,
 *   userAgent: string | null,
 *   createdAt: string,
 * }} AuditRow */

/** @typedef {{ rows: AuditRow[], total: number }} AuditList */

export const admin = {
  /* ─── Users ─── */
  /**
   * @param {{ limit?: number, offset?: number }} [args]
   * @returns {Promise<AdminUserList>}
   */
  listUsers: (args = {}) => http.get("/api/admin/users", { query: args }),

  /**
   * @param {string} userId
   * @returns {Promise<AdminUserRow>}
   */
  getUser: (userId) =>
    http.get(`/api/admin/users/${encodeURIComponent(userId)}`),

  /** @param {string} userId */
  promote: (userId) =>
    http.post(`/api/admin/users/${encodeURIComponent(userId)}/promote`),

  /** @param {string} userId */
  demote: (userId) =>
    http.post(`/api/admin/users/${encodeURIComponent(userId)}/demote`),

  /** @param {string} userId */
  deactivate: (userId) =>
    http.post(`/api/admin/users/${encodeURIComponent(userId)}/deactivate`),

  /** @param {string} userId */
  reactivate: (userId) =>
    http.post(`/api/admin/users/${encodeURIComponent(userId)}/reactivate`),

  /** @param {string} userId */
  deleteUser: (userId) =>
    http.delete(`/api/admin/users/${encodeURIComponent(userId)}`),

  /* ─── Jobs ─── */
  /**
   * @param {{ state?: string, limit?: number, offset?: number }} [args]
   * @returns {Promise<AdminJobList>}
   */
  listJobs: (args = {}) => http.get("/api/admin/jobs", { query: args }),

  /** @returns {Promise<{ pending: number, active: number }>} */
  jobsDepth: () => http.get("/api/admin/jobs/depth"),

  /** @param {string} jobId */
  cancelJob: (jobId) =>
    http.post(`/api/admin/jobs/${encodeURIComponent(jobId)}/cancel`),

  /* ─── Storage ─── */
  /**
   * @param {string} userId
   * @returns {Promise<StorageUsage>}
   */
  storageUsage: (userId) =>
    http.get(`/api/admin/storage/usage/${encodeURIComponent(userId)}`),

  /* ─── Audit ─── */
  /**
   * @param {{ action?: string, userId?: string, limit?: number, offset?: number }} [args]
   * @returns {Promise<AuditList>}
   */
  audit: (args = {}) => http.get("/api/admin/audit", { query: args }),
};
