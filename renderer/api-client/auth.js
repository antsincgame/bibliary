import { http } from "./http.js";

/**
 * Auth surface. Cookie-based (`bibliary_at` / `bibliary_rt` httpOnly).
 * Renderer не хранит токены в JS — auto-refresh при 401 живёт в http.js.
 *
 * @typedef {Object} UserInfo
 * @property {string} sub      user document id
 * @property {string} email
 * @property {string} [name]
 * @property {"user" | "admin"} role
 */

export const auth = {
  /**
   * @param {{email: string, password: string, name?: string}} body
   * @returns {Promise<UserInfo>}
   */
  register: (body) => http.post("/api/auth/register", { json: body, skipRefresh: true }),

  /**
   * @param {{email: string, password: string}} body
   * @returns {Promise<UserInfo>}
   */
  login: (body) => http.post("/api/auth/login", { json: body, skipRefresh: true }),

  /**
   * @returns {Promise<UserInfo>}
   */
  me: () => http.get("/api/auth/me"),

  logout: () => http.post("/api/auth/logout", { parse: "void" }),

  /**
   * @param {{currentPassword: string, newPassword: string}} body
   */
  changePassword: (body) => http.post("/api/auth/password/change", { json: body }),

  /**
   * Sometimes the UI wants to know the auth state without forcing a redirect
   * (e.g. the splash screen). Returns null on 401 instead of throwing.
   * @returns {Promise<UserInfo | null>}
   */
  async meOrNull() {
    try {
      return await http.get("/api/auth/me");
    } catch (err) {
      if (err && /** @type {any} */ (err).status === 401) return null;
      throw err;
    }
  },
};
