/**
 * Model Role Resolver — единая точка резолва "роль → modelKey".
 *
 * РОЛИ И ИХ РЕАЛЬНОЕ ИСПОЛЬЗОВАНИЕ
 * (Iter 14.3 audit, 2026-05-04 — /omnissiah проверка):
 *
 *   crystallizer          ✅ ИСПОЛЬЗУЕТСЯ:
 *                           - md-converter.ts (text-meta fallback при слабых metadata)
 *                           - dataset-v2/delta-extractor.ts (extraction-runner)
 *
 *   vision_meta           ✅ ИСПОЛЬЗУЕТСЯ: extractMetadataFromCover (md-converter.ts)
 *                           triggers: visionMetaEnabled === true И есть cover buffer
 *
 *   vision_ocr            ✅ ИСПОЛЬЗУЕТСЯ: recognizeWithVisionLlm
 *                           triggers: страница без текстового слоя (PDF/DJVU scan)
 *
 *   vision_illustration   ✅ ИСПОЛЬЗУЕТСЯ: processIllustrations (background)
 *                           triggers: непустой illustrations.json после импорта
 *
 *   evaluator             ✅ ИСПОЛЬЗУЕТСЯ: book-evaluator.ts (post-import queue)
 *                           ⚠️  Резолв идёт через свой `pickEvaluatorModel`
 *                           вместо resolve("evaluator") — рассинхронизация
 *                           с remaining ролями (TODO: унифицировать).
 *
 *   layout_assistant      ✅ ИСПОЛЬЗУЕТСЯ: layout-assistant.ts (post-import queue)
 *                           triggers: layoutAssistantEnabled === true
 *
 *   translator            ⚠️ НЕ ИСПОЛЬЗУЕТСЯ при импорте библиотеки.
 *                           Живёт только в scanner/ingest.ts (legacy pipeline,
 *                           триггер: translateNonRussian + lang ∈ {uk,be,kk,ky,tg}).
 *                           В Олимпиаде тестируется, в импорте «декорация».
 *
 *   ukrainian_specialist  ⚠️ НЕ ИСПОЛЬЗУЕТСЯ нигде в production.
 *                           Тестируется только Олимпиадой. В будущем планируется
 *                           для UK→RU переводов и UK-генерации, но в текущем
 *                           pipeline'е роль «декорационная».
 *
 *   lang_detector         ⚠️ LLM-путь НЕ ИСПОЛЬЗУЕТСЯ. Импорт использует
 *                           `detectLanguageByRegex` (md-converter.ts:644-657).
 *                           LLM `detectLanguage(..., llmCb)` написан, но caller'ов
 *                           с llmCb в production нет. В Олимпиаде тестируется
 *                           ради будущего ambiguity-fallback'а.
 *
 * ЦЕПОЧКА РЕЗОЛВА (для каждой роли):
 *   1. preference:   prefs[<role>Model] (явный выбор пользователя)
 *   2. fallback_list: первый загруженный из CSV prefs[<role>ModelFallbacks]
 *   3. auto_detect:  эвристика по capabilities (vision_* через vision flag)
 *   4. fallback_any: первая загруженная модель
 *   5. null:         ни одной загруженной модели
 *
 * CAPABILITY FILTERING:
 *   Для ролей vision_meta / vision_ocr / vision_illustration из кандидатов
 *   отбрасываются модели без `vision: true`.
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
  | "vision_ocr"
  | "vision_illustration"
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
  vision_ocr: ["vision"],
  vision_illustration: ["vision"],
  evaluator: [],
};

/**
 * Какие capabilities предпочтительны для роли (tie-breaker при выборе из
 * списка загруженных). Кандидаты с бо́льшим числом матчей идут первыми.
 */
const ROLE_PREFERRED_CAPS: Record<ModelRole, Capability[]> = {
  crystallizer: [],
  vision_ocr: ["vision"],
  vision_illustration: ["vision"],
  evaluator: [],
};

/**
 * Какой preferences ключ хранит явный выбор пользователя для роли.
 * Все три vision-роли используют единый `visionModelKey`.
 */
const ROLE_PREF_KEY: Record<ModelRole, string> = {
  crystallizer: "extractorModel",
  vision_ocr: "visionModelKey",
  vision_illustration: "visionModelKey",
  evaluator: "evaluatorModel",
};

/** CSV ключ для fallback chain. null = нет fallback chain. */
const ROLE_FALLBACKS_PREF_KEY: Record<ModelRole, string | null> = {
  crystallizer: "extractorModelFallbacks",
  vision_ocr: "visionModelFallbacks",
  vision_illustration: "visionModelFallbacks",
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

    /* 1. Явный выбор пользователя — сначала роль-специфичный pref. */
    const prefKey = ROLE_PREF_KEY[role];
    const prefVal = (prefs as Record<string, unknown>)[prefKey];
    const hasExplicitPreference = typeof prefVal === "string" && prefVal.trim().length > 0;
    if (hasExplicitPreference) {
      const wanted = prefVal!.trim();
      if (eligible.some((m) => m.modelKey === wanted)) {
        return { modelKey: wanted, source: "preference" };
      }
    }

    /* 2. Fallback list (CSV). */
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

    /* 2.5. Если пользователь явно задал модель, но она не загружена и ни один
       CSV-fallback тоже — НЕ подменяем на произвольную loaded LLM. Возвращаем
       null, чтобы caller получил честный "модель не доступна" вместо тихой
       подмены (Qwen вместо Gemma → ошибочные результаты). */
    if (hasExplicitPreference) {
      return null;
    }

    /* 3. Auto-detect по preferred capabilities (только если preference пуст) */
    const preferred = pickByPreferredCaps(eligible, ROLE_PREFERRED_CAPS[role]);
    if (preferred) {
      return { modelKey: preferred, source: "auto_detect", usedFallback: true };
    }

    /* 4. Любая загруженная (только если preference пуст) */
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
  /* Tie-breaker: при равном score сортируем лексикографически по modelKey,
     чтобы выбор был детерминирован (LM Studio listLoaded() не гарантирует
     stable order между запросами — пользователь видел "сегодня Qwen, завтра Gemma"). */
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.m.modelKey.localeCompare(b.m.modelKey);
  });
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

export function listAllRoles(): RoleMeta[] {
  const roles: ModelRole[] = [
    "crystallizer",
    "vision_ocr",
    "vision_illustration",
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
