import { ipcMain } from "electron";

import {
  listAllRoles,
  modelRoleResolver,
  type ModelRole,
  type ResolvedModel,
  type RoleMeta,
} from "../lib/llm/model-role-resolver.js";
import { getPreferencesStore } from "../lib/preferences/store.js";

export interface RoleSnapshotEntry extends RoleMeta {
  resolved: ResolvedModel | null;
  prefValue: string;
}

const VALID_ROLES = new Set<ModelRole>(listAllRoles().map((meta) => meta.role));

function sanitizeRolesArg(input: unknown): ModelRole[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const valid = input.filter((x): x is ModelRole => typeof x === "string" && VALID_ROLES.has(x as ModelRole));
  return valid.length > 0 ? valid : undefined;
}

export async function getRoleSnapshot(roles?: ModelRole[]): Promise<RoleSnapshotEntry[]> {
  const requested = roles && roles.length > 0 ? new Set<ModelRole>(roles) : null;
  const metas = listAllRoles().filter((meta) => !requested || requested.has(meta.role));
  let prefs: Record<string, unknown> = {};
  try {
    prefs = await getPreferencesStore().getAll() as Record<string, unknown>;
  } catch { /* prefs not available — prefValue stays empty */ }
  const entries: RoleSnapshotEntry[] = [];
  for (const meta of metas) {
    let resolved: ResolvedModel | null = null;
    try {
      /* v1.0.7 (autonomous heresy fix): UI snapshot ВСЕГДА passive.
         Models page открывается по умолчанию при старте приложения и
         каждые 8 секунд дёргает refresh(). До v1.0.7 это триггерило
         autoLoad для каждой роли с явным prefValue — три модели
         автоматически грузились в LM Studio без команды пользователя.
         Теперь UI получит null для незагруженных моделей и покажет
         "не загружено" — пользователь сам нажмёт "Загрузить". */
      resolved = await modelRoleResolver.resolve(meta.role, { passive: true });
    } catch {
      resolved = null;
    }
    const raw = prefs[meta.prefKey];
    const prefValue = typeof raw === "string" ? raw.trim() : "";
    entries.push({ ...meta, resolved, prefValue });
  }
  return entries;
}

export function registerModelRolesIpc(): void {
  ipcMain.handle("model-roles:list", async (_e, payload: unknown): Promise<RoleSnapshotEntry[]> => {
    const roles = payload && typeof payload === "object"
      ? sanitizeRolesArg((payload as Record<string, unknown>).roles)
      : undefined;
    return getRoleSnapshot(roles);
  });
}
