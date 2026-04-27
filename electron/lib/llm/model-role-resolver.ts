/**
 * Model Role Resolver — единая точка резолва "роль → modelKey".
 *
 * РОЛИ:
 *   chat            — обычный пользовательский чат
 *   agent           — агент с tool-calling
 *   crystallizer    — extractor для dataset-v2 (delta knowledge extraction)
 *   judge           — критик генераций / pre-flight оценка
 *   vision_meta     — извлечение метаданных книги из обложки
 *   vision_ocr      — vision-based OCR страниц книг
 *   evaluator       — book pre-flight evaluator (quality scoring)
 *   arena_judge     — судья в arena cycle (compare two answers)
 *
 * ЦЕПОЧКА РЕЗОЛВА (для каждой роли):
 *   1. preference:      prefs[<role>Model] (явный выбор пользователя)
 *   2. fallback_list:   первый загруженный из CSV prefs[<role>ModelFallbacks]
 *   3. cascade:         только для arena_judge → judge → crystallizer → chat
 *                       (ищет первую загруженную из цепочки ролей)
 *   4. arena_top_elo:   топ-Elo из arena-ratings.json (если файл существует)
 *   5. profile_builtin: BIG builtin profile — только для crystallizer
 *   6. auto_detect:     эвристика по capabilities (vision_*, agent через tool flag)
 *   7. fallback_any:    первая загруженная модель (всегда что-то возвращает,
 *                       если хоть одна модель загружена)
 *   8. null:            ни одной загруженной модели
 *
 * CAPABILITY FILTERING:
 *   Для ролей vision_meta/vision_ocr из кандидатов отбрасываются модели без
 *   `vision: true`. Для роли agent рекомендуется (но не enforced) tool-use.
 *
 * КЭШ:
 *   Резолвед результаты кешируются в памяти на `prefs.modelRoleCacheTtlMs`
 *   (default 30 секунд). Кэш инвалидируется через `invalidate()` —
 *   например при изменении prefs или unload модели.
 */

import { listLoaded as _listLoaded, type LoadedModelInfo } from "../../lmstudio-client.js";
import { getPreferencesStore, type Preferences } from "../preferences/store.js";
import { readRatingsFile as _readRatingsFile, type ArenaRatingsFile } from "./arena/ratings-store.js";

export type ModelRole =
  | "chat"
  | "agent"
  | "crystallizer"
  | "judge"
  | "vision_meta"
  | "vision_ocr"
  | "evaluator"
  | "arena_judge";

export type Capability = "vision" | "tool";

export type ResolvedModelSource =
  | "preference"
  | "fallback_list"
  | "arena_top_elo"
  | "profile_builtin"
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
  chat: [],
  agent: [],            /* tool — рекомендация, не requirement */
  crystallizer: [],
  judge: [],
  vision_meta: ["vision"],
  vision_ocr: ["vision"],
  evaluator: [],
  arena_judge: [],
};

/**
 * Какие capabilities предпочтительны для роли (используются как tie-breaker
 * при выборе из списка загруженных). Кандидаты с большим числом матчей
 * preferred caps идут первыми.
 */
const ROLE_PREFERRED_CAPS: Record<ModelRole, Capability[]> = {
  chat: [],
  agent: ["tool"],
  crystallizer: [],
  judge: [],
  vision_meta: ["vision"],
  vision_ocr: ["vision"],
  evaluator: [],
  arena_judge: [],
};

/**
 * Какой preferences ключ хранит явный выбор пользователя для роли.
 * Для unsupported ролей (агрегатные / синонимы) используется fallback.
 */
const ROLE_PREF_KEY: Record<ModelRole, string> = {
  chat: "chatModel",
  agent: "agentModel",
  crystallizer: "extractorModel",
  judge: "judgeModel",
  vision_meta: "visionModelKey",
  vision_ocr: "visionModelKey",
  evaluator: "evaluatorModel",
  arena_judge: "arenaJudgeModelKey",
};

/**
 * CSV ключ для fallback chain. Для arena_judge fallback идёт
 * через cascade судья → judge → extractor → chat (см. resolveCascade).
 */
const ROLE_FALLBACKS_PREF_KEY: Record<ModelRole, string | null> = {
  chat: "chatModelFallbacks",
  agent: "agentModelFallbacks",
  crystallizer: "extractorModelFallbacks",
  judge: "judgeModelFallbacks",
  vision_meta: "visionModelFallbacks",
  vision_ocr: "visionModelFallbacks",
  evaluator: "evaluatorModelFallbacks",
  arena_judge: null,
};

/**
 * Cascade: для arena_judge — пробуем judge → extractor → chat если своя
 * настройка пуста. Для остальных ролей — null (нет cascade).
 */
const ROLE_CASCADE: Partial<Record<ModelRole, ModelRole[]>> = {
  arena_judge: ["judge", "crystallizer", "chat"],
};

interface CacheEntry {
  resolved: ResolvedModel | null;
  expiresAt: number;
}

/**
 * Injectable dependencies — позволяют unit-тестам подменить LM Studio / prefs / ratings
 * без запуска реального Electron/LM Studio.
 *
 * Контракт: deps подменяются ТОЛЬКО через `_setResolverDepsForTests` и сбрасываются
 * через `_resetResolverForTests`. В production используются реальные impl.
 */
interface ResolverDeps {
  listLoaded: () => Promise<LoadedModelInfo[]>;
  getPrefs: () => Promise<Preferences>;
  readRatings: () => Promise<ArenaRatingsFile>;
  getProfileById: (id: string) => Promise<{ modelKey: string } | null>;
}

const defaultDeps: ResolverDeps = {
  listLoaded: _listLoaded,
  getPrefs: async () => getPreferencesStore().getAll(),
  readRatings: _readRatingsFile,
  getProfileById: async (id) => {
    try {
      const { getProfileStore } = await import("../profiles/store.js");
      return getProfileStore().getById(id);
    } catch {
      return null;
    }
  },
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

    /* 3. Cascade на другие роли (для arena_judge) */
    const cascade = ROLE_CASCADE[role];
    if (cascade) {
      for (const fallbackRole of cascade) {
        const r = await this.resolveUncached(fallbackRole);
        if (r && eligible.some((m) => m.modelKey === r.modelKey)) {
          return { modelKey: r.modelKey, source: r.source, usedFallback: true };
        }
      }
    }

    /* 4. Arena top-Elo для этой роли */
    const fromArena = await topByElo(role, eligible);
    if (fromArena) {
      return { modelKey: fromArena, source: "arena_top_elo", usedFallback: true };
    }

    /* 5. Built-in profile (только для crystallizer — BIG) */
    if (role === "crystallizer") {
      const builtin = await tryBuiltinProfile("BIG", eligible);
      if (builtin) {
        return { modelKey: builtin, source: "profile_builtin", usedFallback: true };
      }
    }

    /* 6. Auto-detect по preferred capabilities */
    const preferred = pickByPreferredCaps(eligible, ROLE_PREFERRED_CAPS[role]);
    if (preferred) {
      return { modelKey: preferred, source: "auto_detect", usedFallback: true };
    }

    /* 7. Любая загруженная (не пройдёт capability filter если eligible пуст) */
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
      if (cap === "tool" && !m.trainedForToolUse) return false;
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
      if (cap === "tool" && m.trainedForToolUse) score += 1;
    }
    return { m, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0]!.m.modelKey;
}

async function topByElo(role: ModelRole, eligible: LoadedModelInfo[]): Promise<string | null> {
  if (eligible.length === 0) return null;
  try {
    const file = await deps.readRatings();
    const ratings = file.roles[role];
    if (!ratings) return null;
    let bestKey: string | null = null;
    let bestElo = -Infinity;
    for (const m of eligible) {
      const e = ratings[m.modelKey];
      if (typeof e === "number" && e > bestElo) {
        bestElo = e;
        bestKey = m.modelKey;
      }
    }
    return bestKey;
  } catch {
    return null;
  }
}

async function tryBuiltinProfile(profileId: string, eligible: LoadedModelInfo[]): Promise<string | null> {
  try {
    const profile = await deps.getProfileById(profileId);
    if (!profile) return null;
    if (eligible.some((m) => m.modelKey === profile.modelKey)) {
      return profile.modelKey;
    }
    return null;
  } catch {
    return null;
  }
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
 * Возвращает label, иконку и required/preferred capabilities.
 */
export interface RoleMeta {
  role: ModelRole;
  prefKey: string;
  fallbackKey: string | null;
  required: Capability[];
  preferred: Capability[];
}

/**
 * Вернуть preferences-ключ для роли (используется в arena auto-promote).
 * Позволяет избежать дублирования между model-role-resolver и run-cycle.
 */
export function getRolePrefKey(role: ModelRole): string {
  return ROLE_PREF_KEY[role];
}

export function listAllRoles(): RoleMeta[] {
  const roles: ModelRole[] = [
    "chat",
    "agent",
    "crystallizer",
    "judge",
    "vision_meta",
    "vision_ocr",
    "evaluator",
    "arena_judge",
  ];
  return roles.map((r) => ({
    role: r,
    prefKey: ROLE_PREF_KEY[r],
    fallbackKey: ROLE_FALLBACKS_PREF_KEY[r],
    required: ROLE_REQUIRED_CAPS[r],
    preferred: ROLE_PREFERRED_CAPS[r],
  }));
}
