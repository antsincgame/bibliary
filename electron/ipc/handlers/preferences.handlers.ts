/**
 * Pure-логика IPC хендлеров preferences.ipc.
 *
 * Извлечено из `preferences.ipc.ts` (2026-05-10): сами `ipcMain.handle`
 * вызовы остаются в .ipc.ts, но тело каждого handler'а вынесено сюда как
 * чистая async-функция с DI-параметром `deps`. Это позволяет unit-тестам
 * вызывать любой handler напрямую без поднятия Electron + ipcMain.
 *
 * Контракт:
 *   - handlers НЕ читают global state кроме того, что приходит через `deps`.
 *   - Дефолтные deps подставляются wrapper'ом в .ipc.ts — production
 *     поведение не меняется.
 *   - Если handler требует BrowserWindow или e.sender, он принимает их
 *     отдельным параметром (после deps и payload).
 */

import type { Preferences } from "../../lib/preferences/store.js";

/* ─── DI: dependencies handler'ов ─────────────────────────────────── */

export interface PreferencesIpcDeps {
  /** Get all preferences. */
  getAllPrefs: () => Promise<Preferences>;
  /** Get defaults (synchronous). */
  getDefaults: () => Preferences;
  /** Persist partial preferences, return new full state. */
  setPrefs: (partial: Partial<Preferences>) => Promise<Preferences>;
  /** Reset all preferences to DEFAULTS, return resulting state. */
  resetPrefs: () => Promise<Preferences>;
  /** Apply runtime side-effects (watchdog, endpoints cache, etc.). */
  applyRuntimeSideEffects: (prefs: Preferences) => void;
  /** Broadcast changed preferences to all renderer windows. */
  broadcast?: (prefs: Preferences) => void;
  /** Show native save dialog. */
  showSaveDialog?: (opts: SaveDialogOpts) => Promise<{ canceled: boolean; filePath?: string }>;
  /** Show native open dialog. */
  showOpenDialog?: (opts: OpenDialogOpts) => Promise<{ canceled: boolean; filePaths: string[] }>;
  /** fs.writeFile (или mock). */
  writeFile?: (path: string, content: string, encoding: "utf8") => Promise<void>;
  /** fs.readFile (или mock). */
  readFile?: (path: string, encoding: "utf8") => Promise<string>;
}

export interface SaveDialogOpts {
  title: string;
  defaultPath?: string;
  filters?: Array<{ name: string; extensions: string[] }>;
}

export interface OpenDialogOpts {
  title: string;
  properties?: Array<"openFile" | "openDirectory" | "multiSelections">;
  filters?: Array<{ name: string; extensions: string[] }>;
}

/* ─── Profile whitelist (re-export для тестов) ────────────────────── */

export const PROFILE_KEYS = [
  "readerModel",
  "extractorModel",
  "visionOcrModel",
] as const satisfies readonly (keyof Preferences)[];

export type ProfileSnapshot = Pick<Preferences, (typeof PROFILE_KEYS)[number]>;

export interface ProfileFile {
  schema: "bibliary.profile/v1";
  exportedAt: string;
  app: { name: string; version?: string };
  profile: Partial<ProfileSnapshot>;
}

export function pickProfile(prefs: Preferences): Partial<ProfileSnapshot> {
  const out: Partial<Record<string, unknown>> = {};
  for (const k of PROFILE_KEYS) {
    const v = prefs[k];
    if (v !== undefined && v !== "") out[k] = v;
  }
  return out as Partial<ProfileSnapshot>;
}

export function sanitizeImportedProfile(raw: unknown): Partial<ProfileSnapshot> {
  if (!raw || typeof raw !== "object") return {};
  const obj = raw as Record<string, unknown>;
  /* Поддерживаем оба варианта: {profile: {...}} и плоский {extractorModel: ...}. */
  const src: Record<string, unknown> =
    obj.profile && typeof obj.profile === "object"
      ? (obj.profile as Record<string, unknown>)
      : obj;
  const out: Record<string, unknown> = {};
  for (const k of PROFILE_KEYS) {
    const v = src[k];
    if (typeof v === "string") out[k] = v;
  }
  return out as Partial<ProfileSnapshot>;
}

/* ─── Handlers ────────────────────────────────────────────────────── */

export async function preferencesGetAll(deps: PreferencesIpcDeps): Promise<Preferences> {
  return deps.getAllPrefs();
}

export function preferencesGetDefaults(deps: PreferencesIpcDeps): Preferences {
  return deps.getDefaults();
}

export async function preferencesSet(
  deps: PreferencesIpcDeps,
  partial: unknown,
): Promise<Preferences> {
  if (!partial || typeof partial !== "object") {
    throw new Error("Invalid preferences payload");
  }
  const next = await deps.setPrefs(partial as Partial<Preferences>);
  deps.applyRuntimeSideEffects(next);
  deps.broadcast?.(next);
  return next;
}

export async function preferencesReset(deps: PreferencesIpcDeps): Promise<Preferences> {
  const next = await deps.resetPrefs();
  deps.applyRuntimeSideEffects(next);
  deps.broadcast?.(next);
  return next;
}

export async function preferencesGetProfile(deps: PreferencesIpcDeps): Promise<ProfileFile> {
  const all = await deps.getAllPrefs();
  return {
    schema: "bibliary.profile/v1",
    exportedAt: new Date().toISOString(),
    app: { name: "Bibliary" },
    profile: pickProfile(all),
  };
}

export async function preferencesExportProfile(
  deps: PreferencesIpcDeps,
): Promise<{ path: string | null }> {
  if (!deps.showSaveDialog || !deps.writeFile) {
    throw new Error("preferences:export-profile requires showSaveDialog + writeFile in deps");
  }
  const all = await deps.getAllPrefs();
  const file: ProfileFile = {
    schema: "bibliary.profile/v1",
    exportedAt: new Date().toISOString(),
    app: { name: "Bibliary" },
    profile: pickProfile(all),
  };
  const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
  const res = await deps.showSaveDialog({
    title: "Экспорт профиля моделей",
    defaultPath: `bibliary-profile-${stamp}.json`,
    filters: [{ name: "Bibliary profile", extensions: ["json"] }],
  });
  if (res.canceled || !res.filePath) return { path: null };
  await deps.writeFile(res.filePath, JSON.stringify(file, null, 2), "utf8");
  return { path: res.filePath };
}

export interface ImportProfileResult {
  path: string | null;
  appliedKeys: string[];
  prefs: Preferences;
}

export async function preferencesImportProfile(
  deps: PreferencesIpcDeps,
): Promise<ImportProfileResult> {
  if (!deps.showOpenDialog || !deps.readFile) {
    throw new Error("preferences:import-profile requires showOpenDialog + readFile in deps");
  }
  const res = await deps.showOpenDialog({
    title: "Импорт профиля моделей",
    properties: ["openFile"],
    filters: [{ name: "Bibliary profile", extensions: ["json"] }],
  });
  if (res.canceled || !res.filePaths[0]) {
    return { path: null, appliedKeys: [], prefs: await deps.getAllPrefs() };
  }
  const filePath = res.filePaths[0];
  let parsed: unknown;
  try {
    const raw = await deps.readFile(filePath, "utf8");
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Не удалось прочитать файл профиля: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const sanitized = sanitizeImportedProfile(parsed);
  const appliedKeys = Object.keys(sanitized);
  if (appliedKeys.length === 0) {
    throw new Error("Файл не содержит валидных полей профиля (ожидались модели по ролям).");
  }
  const next = await deps.setPrefs(sanitized);
  deps.applyRuntimeSideEffects(next);
  deps.broadcast?.(next);
  return { path: filePath, appliedKeys, prefs: next };
}

export interface ApplyProfileResult {
  appliedKeys: string[];
  prefs: Preferences;
}

export async function preferencesApplyProfile(
  deps: PreferencesIpcDeps,
  payload: unknown,
): Promise<ApplyProfileResult> {
  const sanitized = sanitizeImportedProfile(payload);
  const appliedKeys = Object.keys(sanitized);
  if (appliedKeys.length === 0) {
    throw new Error("Профиль не содержит валидных полей.");
  }
  const next = await deps.setPrefs(sanitized);
  deps.applyRuntimeSideEffects(next);
  deps.broadcast?.(next);
  return { appliedKeys, prefs: next };
}
