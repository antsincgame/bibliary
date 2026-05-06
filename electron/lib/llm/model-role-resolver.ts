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
import { getModelPool } from "./model-pool.js";
import { logModelAction } from "./lmstudio-actions-log.js";

export type ModelRole =
  | "crystallizer"
  | "vision_ocr"
  | "vision_illustration"
  | "evaluator"
  | "ukrainian_specialist";

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
  ukrainian_specialist: [],
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
  ukrainian_specialist: [],
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
  ukrainian_specialist: "ukrainianSpecialistModel",
};

/** CSV ключ для fallback chain. null = нет fallback chain. */
const ROLE_FALLBACKS_PREF_KEY: Record<ModelRole, string | null> = {
  crystallizer: "extractorModelFallbacks",
  vision_ocr: "visionModelFallbacks",
  vision_illustration: "visionModelFallbacks",
  evaluator: "evaluatorModelFallbacks",
  ukrainian_specialist: "ukrainianSpecialistModelFallbacks",
};

/**
 * Rate-limit для RESOLVE-PASSIVE-SKIP логов.
 *
 * v1.0.11 (2026-05-06): UI snapshot вызывает passive-resolve каждые 8 секунд
 * для каждой из 4 ролей (crystallizer/vision_ocr/vision_illustration/evaluator).
 * До v1.0.11 это давало ~30 записей/мин в lmstudio-actions.log → лог становился
 * нечитаемым (события LOAD/UNLOAD/AUTO-LOAD тонули в шуме PASSIVE-SKIP).
 *
 * Теперь логируем PASSIVE-SKIP не чаще 1 раза в 10 минут на пару (role + modelKey).
 * Этого достаточно чтобы зафиксировать факт «UI знает что модель не загружена»,
 * без дублирования. При смене модели в prefs или unload — новый ключ → новый лог.
 */
const PASSIVE_SKIP_RATE_LIMIT_MS = 10 * 60 * 1000;
const passiveSkipLastLogged = new Map<string, number>();

function shouldLogPassiveSkip(role: ModelRole, modelKey: string): boolean {
  const key = `${role}:${modelKey}`;
  const now = Date.now();
  const last = passiveSkipLastLogged.get(key);
  if (last !== undefined && now - last < PASSIVE_SKIP_RATE_LIMIT_MS) {
    return false;
  }
  passiveSkipLastLogged.set(key, now);
  return true;
}

/** Тестовый хук: сбросить rate-limit. Использовать только в тестах. */
export function _resetPassiveSkipRateLimitForTesting(): void {
  passiveSkipLastLogged.clear();
}

/** Тестовый хук v1.0.12: проверить rate-limit логику без выполнения логирования.
 * Возвращает true если лог должен быть записан (= "не undefined и не в окне"),
 * false — если rate-limit заблокировал. Side-effect: обновляет timestamp.
 * Используется ТОЛЬКО в unit-тестах. */
export function _shouldLogPassiveSkipForTesting(role: ModelRole, modelKey: string): boolean {
  return shouldLogPassiveSkip(role, modelKey);
}

/** Тестовый хук v1.0.12: получить интервал rate-limit (мс) для проверки в тестах. */
export const _PASSIVE_SKIP_RATE_LIMIT_MS_FOR_TESTING = PASSIVE_SKIP_RATE_LIMIT_MS;

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
  /** Авто-загрузка модели через pool (с VRAM management). Тесты подменяют на no-op. */
  autoLoad: (modelKey: string, role: string) => Promise<boolean>;
}

async function defaultAutoLoad(modelKey: string, role: string): Promise<boolean> {
  const startedAt = Date.now();
  logModelAction("AUTO-LOAD-START", { modelKey, role, reason: "model-role-resolver.defaultAutoLoad" });
  try {
    const handle = await getModelPool().acquire(modelKey, {
      role,
      ttlSec: 1800,
      gpuOffload: "max",
    });
    handle.release();
    logModelAction("AUTO-LOAD-OK", { modelKey, role, durationMs: Date.now() - startedAt });
    return true;
  } catch (e) {
    const errorMsg = e instanceof Error ? e.message : String(e);
    logModelAction("AUTO-LOAD-FAIL", { modelKey, role, durationMs: Date.now() - startedAt, errorMsg });
    console.warn(`[model-role-resolver] auto-load "${modelKey}" for role "${role}" failed: ${errorMsg}`);
    return false;
  }
}

const defaultDeps: ResolverDeps = {
  listLoaded: _listLoaded,
  getPrefs: async () => getPreferencesStore().getAll(),
  autoLoad: defaultAutoLoad,
};

let deps: ResolverDeps = defaultDeps;

export function _setResolverDepsForTests(overrides: Partial<ResolverDeps>): void {
  deps = { ...defaultDeps, ...overrides };
}

export function _resetResolverForTests(): void {
  deps = defaultDeps;
}

/**
 * Опции вызова `resolve()`. С v1.0.7 (autonomous heresy fix) все caller'ы
 * должны явно сообщить контекст вызова:
 *
 *   - `passive: true` — caller только смотрит ("какая модель резолвится для
 *     этой роли"), НЕ имеет права триггерить autoLoad. Используется UI
 *     snapshot'ами (model-roles:list для Models page), periodic refresh,
 *     status indicators. Если preferred модель НЕ загружена — вернётся
 *     null с записью RESOLVE-PASSIVE-SKIP в lmstudio-actions.log.
 *
 *   - `passive: false` (по умолчанию) — caller активно работает (импорт книги,
 *     OCR, evaluation, manual chat). Имеет право вызвать autoLoad через
 *     ModelPool, что грузит модель с диска в VRAM.
 *
 * Это закрывает баг v1.0.5+, когда открытие приложения автоматически
 * запускало 2-3 модели в LM Studio из-за UI snapshot'а.
 */
export interface ResolveOptions {
  passive?: boolean;
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

  async resolve(role: ModelRole, opts: ResolveOptions = {}): Promise<ResolvedModel | null> {
    const cached = this.cache.get(role);
    const now = Date.now();
    if (cached && cached.expiresAt > now) return cached.resolved;

    const resolved = await this.resolveUncached(role, opts);

    /* В пассивном режиме НЕ кешируем null-ответ — иначе кэш продержит
       "модель не загружена" 30 секунд даже после того, как пользователь
       явно загрузил её через UI. Кешируем только успешные резолвы. */
    const ttl = await this.cacheTtlMs();
    if (ttl > 0 && (resolved !== null || !opts.passive)) {
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

  private async resolveUncached(role: ModelRole, opts: ResolveOptions): Promise<ResolvedModel | null> {
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
       CSV-fallback тоже — пробуем авто-загрузить через ModelPool. Pool сам
       управляет VRAM: eviction старых моделей, OOM recovery, makeRoom.

       v1.0.7 (passive guard): если caller передал passive=true — НЕ грузим.
       Это режим "только посмотреть": UI snapshot, periodic refresh, status
       indicators. Возвращаем null, чтобы UI показал честное "не загружено"
       вместо тихого триггера загрузки гигабайтной модели. */
    if (hasExplicitPreference) {
      const wanted = prefVal!.trim();
      if (opts.passive) {
        /* v1.0.11: rate-limit логов чтобы не засорять lmstudio-actions.log
           периодическими refresh'ами UI (каждые 8 секунд). */
        if (shouldLogPassiveSkip(role, wanted)) {
          logModelAction("RESOLVE-PASSIVE-SKIP", {
            modelKey: wanted,
            role,
            reason: "passive caller would have triggered autoLoad — skipped per v1.0.7 guard (rate-limited 1/10min per role+model)",
          });
        }
        return null;
      }
      const loaded = await deps.autoLoad(wanted, role);
      if (loaded) {
        return { modelKey: wanted, source: "preference" };
      }
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
 * Language-aware резолв для извлечения концептов.
 *
 * Если книга на украинском (`lang === "uk"`) и пользователь сконфигурировал
 * `ukrainianSpecialistModel` (или fallbacks), пытаемся использовать
 * специализированную модель — она лучше понимает украинскую лексику и
 * грамматику чем generic crystallizer.
 *
 * Если ukrainian_specialist не сконфигурирован или ни одна из его моделей
 * не загружена — graceful fallback на обычный crystallizer. То есть
 * украинская книга НЕ застрянет: pipeline всегда даст какую-то модель.
 *
 * Для других языков (ru, en, de, fr, ...) — стандартный crystallizer
 * (multilingual-e5 и большинство современных LLM их обрабатывают
 * без специализации).
 */
export async function resolveCrystallizerForLanguage(
  language: string | undefined,
): Promise<ResolvedModel | null> {
  if (language === "uk") {
    /* Только если пользователь явно сконфигурировал ukrainian_specialist
       (primary или fallback chain). Иначе резолвер просто вернул бы первую
       загруженную модель — ровно ту же что для crystallizer, без специализации.
       Читаем prefs через тот же deps что и резолвер — тесты могут инжектить. */
    const prefs = await deps.getPrefs();
    const ukConfigured =
      String((prefs as Record<string, unknown>).ukrainianSpecialistModel ?? "").trim().length > 0 ||
      String((prefs as Record<string, unknown>).ukrainianSpecialistModelFallbacks ?? "").trim().length > 0;
    if (ukConfigured) {
      const ukSpecialist = await modelRoleResolver.resolve("ukrainian_specialist");
      if (ukSpecialist?.modelKey) return ukSpecialist;
    }
  }
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
    "ukrainian_specialist",
  ];
  return roles.map((r) => ({
    role: r,
    prefKey: ROLE_PREF_KEY[r],
    fallbackKey: ROLE_FALLBACKS_PREF_KEY[r],
    required: ROLE_REQUIRED_CAPS[r],
    preferred: ROLE_PREFERRED_CAPS[r],
  }));
}
