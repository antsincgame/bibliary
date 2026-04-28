/**
 * Model Role Resolver — единая точка резолва "роль → modelKey".
 *
 * РОЛИ:
 *   crystallizer    — extractor для dataset-v2 (delta knowledge extraction)
 *   judge           — критик генераций / pre-flight оценка
 *   vision_meta     — извлечение метаданных книги из обложки
 *   vision_ocr      — vision-based OCR страниц книг
 *   evaluator       — book pre-flight evaluator (quality scoring)
 *
 * ЦЕПОЧКА РЕЗОЛВА (для каждой роли):
 *   1. preference:   prefs[<role>Model] (явный выбор пользователя)
 *   2. fallback_list: первый загруженный из CSV prefs[<role>ModelFallbacks]
 *   3. auto_detect:  эвристика по capabilities (vision_* через vision flag)
 *   4. fallback_any: первая загруженная модель
 *   5. null:         ни одной загруженной модели
 *
 * CAPABILITY FILTERING:
 *   Для ролей vision_meta/vision_ocr из кандидатов отбрасываются модели без
 *   `vision: true`.
 *
 * КЭШ:
 *   Резолвед результаты кешируются в памяти на `prefs.modelRoleCacheTtlMs`
 *   (default 30 секунд). Кэш инвалидируется через `invalidate()` —
 *   например при изменении prefs или unload модели.
 */

import { listLoaded as _listLoaded, type LoadedModelInfo } from "../../lmstudio-client.js";
import { getPreferencesStore, type Preferences } from "../preferences/store.js";

export type ModelRole =
  | "crystallizer"
  | "judge"
  | "vision_meta"
  | "vision_ocr"
  | "evaluator";

export type Capability = "vision";

export type ResolvedModelSource =
  | "preference"
  | "fallback_list"
  | "auto_detect"
  | "fallback_any";

export interface ResolvedModel {
  modelKey: string;
  source: ResolvedModelSource;
  /** True если выбран не из prefs (=пользователь не задал явно). */
  usedFallback?: boolean;
}

/**
 * Какие capabilities обязательны для роли. Если у кандидата нет всех
 * required caps — он отбрасывается. Если список пуст — фильтрации нет.
 */
const ROLE_REQUIRED_CAPS: Record<ModelRole, Capability[]> = {
  crystallizer: [],
  judge: [],
  vision_meta: ["vision"],
  vision_ocr: ["vision"],
  evaluator: [],
};

/**
 * Какие capabilities предпочтительны для роли (tie-breaker при выборе из
 * списка загруженных). Кандидаты с бо́льшим числом матчей идут первыми.
 */
const ROLE_PREFERRED_CAPS: Record<ModelRole, Capability[]> = {
  crystallizer: [],
  judge: [],
  vision_meta: ["vision"],
  vision_ocr: ["vision"],
  evaluator: [],
};

/**
 * Какой preferences ключ хранит явный выбор пользователя для роли.
 */
const ROLE_PREF_KEY: Record<ModelRole, string> = {
  crystallizer: "extractorModel",
  judge: "judgeModel",
  vision_meta: "visionModelKey",
  vision_ocr: "visionModelKey",
  evaluator: "evaluatorModel",
};

/** CSV ключ для fallback chain. null = нет fallback chain. */
const ROLE_FALLBACKS_PREF_KEY: Record<ModelRole, string | null> = {
  crystallizer: "extractorModelFallbacks",
  judge: "judgeModelFallbacks",
  vision_meta: "visionModelFallbacks",
  vision_ocr: "visionModelFallbacks",
  evaluator: "evaluatorModelFallbacks",
};

interface CacheEntry {
  resolved: ResolvedModel | null;
  expiresAt: number;
}

/**
 * Injectable dependencies — позволяют unit-тестам подменить LM Studio / prefs
 * без запуска реального Electron/LM Studio.
 */
interface ResolverDeps {
  listLoaded: () => Promise<LoadedModelInfo[]>;
  getPrefs: () => Promise<Preferences>;
}

const defaultDeps: ResolverDeps = {
  listLoaded: _listLoaded,
  getPrefs: async () => getPreferencesStore().getAll(),
};

let deps: ResolverDeps = defaultDeps;

export function _setResolverDepsForTests(overrides: Partial<ResolverDeps>): void {
  deps = { ...defaultDeps, ...overrides };
}

export function _resetResolverForTests(): void {
  deps = defaultDeps;
}

class ModelRoleResolverImpl {
  private readonly cache = new Map<ModelRole, CacheEntry>();

  invalidate(role?: ModelRole): void {
    if (role) {
      this.cache.delete(role);
    } else {
      this.cache.clear();
    }
  }

  async resolve(role: ModelRole): Promise<ResolvedModel | null> {
    const cached = this.cache.get(role);
    const now = Date.now();
    if (cached && cached.expiresAt > now) return cached.resolved;

    const resolved = await this.resolveUncached(role);

    const ttl = await this.cacheTtlMs();
    if (ttl > 0) {
      this.cache.set(role, { resolved, expiresAt: now + ttl });
    }
    return resolved;
  }

  private async cacheTtlMs(): Promise<number> {
    try {
      const prefs = await deps.getPrefs();
      return Math.max(0, prefs.modelRoleCacheTtlMs ?? 30_000);
    } catch {
      return 30_000;
    }
  }

  private async resolveUncached(role: ModelRole): Promise<ResolvedModel | null> {
    const prefs = await deps.getPrefs();
    const loaded = await deps.listLoaded();
    const eligible = filterByCaps(loaded, ROLE_REQUIRED_CAPS[role]);

    /* 1. Явный выбор пользователя */
    const prefKey = ROLE_PREF_KEY[role];
    const prefVal = (prefs as Record<string, unknown>)[prefKey];
    if (typeof prefVal === "string" && prefVal.trim()) {
      const wanted = prefVal.trim();
      if (eligible.some((m) => m.modelKey === wanted)) {
        return { modelKey: wanted, source: "preference" };
      }
      /* Пользователь выбрал модель, но её сейчас нет в loaded или нет нужной
         capability. Не делаем silent fallback — продолжаем цепочку, но
         помечаем usedFallback=true. */
    }

    /* 2. Fallback list (CSV) */
    const fbKey = ROLE_FALLBACKS_PREF_KEY[role];
    if (fbKey) {
      const fbVal = (prefs as Record<string, unknown>)[fbKey];
      if (typeof fbVal === "string" && fbVal.trim()) {
        const candidates = fbVal.split(",").map((s) => s.trim()).filter(Boolean);
        for (const c of candidates) {
          if (eligible.some((m) => m.modelKey === c)) {
            return { modelKey: c, source: "fallback_list", usedFallback: true };
          }
        }
      }
    }

    /* 3. Auto-detect по preferred capabilities */
    const preferred = pickByPreferredCaps(eligible, ROLE_PREFERRED_CAPS[role]);
    if (preferred) {
      return { modelKey: preferred, source: "auto_detect", usedFallback: true };
    }

    /* 4. Любая загруженная (не пройдёт capability filter если eligible пуст) */
    if (eligible.length > 0) {
      return { modelKey: eligible[0]!.modelKey, source: "fallback_any", usedFallback: true };
    }

    return null;
  }
}

function filterByCaps(loaded: LoadedModelInfo[], required: Capability[]): LoadedModelInfo[] {
  if (required.length === 0) return loaded;
  return loaded.filter((m) => {
    for (const cap of required) {
      if (cap === "vision" && !m.vision) return false;
    }
    return true;
  });
}

function pickByPreferredCaps(loaded: LoadedModelInfo[], preferred: Capability[]): string | null {
  if (loaded.length === 0) return null;
  if (preferred.length === 0) return loaded[0]!.modelKey;
  const scored = loaded.map((m) => {
    let score = 0;
    for (const cap of preferred) {
      if (cap === "vision" && m.vision) score += 1;
    }
    return { m, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0]!.m.modelKey;
}

export const modelRoleResolver = new ModelRoleResolverImpl();

/**
 * Удобная обёртка для dataset-v2 / Crystallizer pipeline.
 * Возвращает modelKey или null если ничего не подошло.
 */
export async function resolveCrystallizerModelKey(): Promise<ResolvedModel | null> {
  return modelRoleResolver.resolve("crystallizer");
}

/**
 * Подсмотреть какие capabilities нужны для роли (без резолва модели).
 * Используется UI для отображения требований и фильтрации dropdown'а.
 */
export function peekRoleCaps(role: ModelRole): Capability[] | undefined {
  return ROLE_REQUIRED_CAPS[role];
}

/**
 * Полная статическая мета о всех ролях для UI (Roles card в Models page).
 */
export interface RoleMeta {
  role: ModelRole;
  prefKey: string;
  fallbackKey: string | null;
  required: Capability[];
  preferred: Capability[];
}

export function getRolePrefKey(role: ModelRole): string {
  return ROLE_PREF_KEY[role];
}

export function listAllRoles(): RoleMeta[] {
  const roles: ModelRole[] = [
    "crystallizer",
    "judge",
    "vision_meta",
    "vision_ocr",
    "evaluator",
  ];
  return roles.map((r) => ({
    role: r,
    prefKey: ROLE_PREF_KEY[r],
    fallbackKey: ROLE_FALLBACKS_PREF_KEY[r],
    required: ROLE_REQUIRED_CAPS[r],
    preferred: ROLE_PREFERRED_CAPS[r],
  }));
}
