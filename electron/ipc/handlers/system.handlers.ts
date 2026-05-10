/**
 * Pure-логика IPC хендлеров system.ipc.ts (extracted 2026-05-10).
 *
 * Только URL-validation для system:open-external — самый
 * security-критичный handler (защита от javascript:, file:, chrome:,
 * data:text/html и т.д.). Build-info и hardware-detect остаются inline,
 * поскольку их поведение полностью определяется I/O.
 */

export const ALLOWED_OPEN_SCHEMES = ["http:", "https:", "lmstudio:"];

export interface OpenExternalResult {
  ok: boolean;
  reason?: string;
}

/**
 * Валидирует URL перед открытием через shell.openExternal. Возвращает
 * `{ok: true}` если URL безопасен; иначе `{ok: false, reason}`.
 *
 * Контракт безопасности:
 *   - принимаются только схемы из ALLOWED_OPEN_SCHEMES (http, https, lmstudio)
 *   - НИКОГДА не принимаются: javascript:, vbscript:, data:, file:, chrome:,
 *     about:, blob:, ms-windows-store: и любые другие.
 *   - empty/non-string → reject с reason "url required"
 *   - non-URL parseable → reject с reason "invalid url"
 *
 * Чистая функция: не вызывает shell.openExternal, только валидирует.
 * Caller (registerSystemIpc) вызывает openExternal если функция вернула ok.
 */
export function validateOpenExternalUrl(url: unknown): OpenExternalResult {
  if (typeof url !== "string" || url.length === 0) {
    return { ok: false, reason: "url required" };
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: "invalid url" };
  }
  if (!ALLOWED_OPEN_SCHEMES.includes(parsed.protocol)) {
    return { ok: false, reason: `scheme not allowed: ${parsed.protocol}` };
  }
  return { ok: true };
}
