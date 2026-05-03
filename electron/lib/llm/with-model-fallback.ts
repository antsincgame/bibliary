/**
 * Quality-based model fallback wrapper.
 *
 * Когда нужен:
 *   Резолвер ролей (`model-role-resolver`) выбирает модель ДО запроса —
 *   но не реагирует на **содержимое** ответа. Если первая модель отдала
 *   невалидный JSON / пустой `content` / зацикленный reasoning_content,
 *   логичнее попробовать следующую модель из CSV-fallbacks роли.
 *
 * Что делает:
 *   1. Получает список моделей-кандидатов: явный prefKey (preference)
 *      + распарсенный CSV из prefKeyFallbacks.
 *   2. Фильтрует по реально загруженным в LM Studio.
 *   3. Запускает `task(modelKey)` по очереди, пока не получит «успех»
 *      (по predicate-проверке либо по отсутствию throw).
 *   4. Возвращает первый успешный результат + метаданные о попытках.
 *
 * Важно: НЕ заменяет role-resolver (там логика выбора по capability,
 * preference, autodetect). Этот wrapper строится поверх — для случаев,
 * когда мы уже выполнили запрос и **видим**, что результат плохой.
 *
 * Используется в:
 *   - delta-extractor (если первая модель вернула пустой DeltaKnowledge)
 *   - book-evaluator (если zod-валидация провалилась)
 *   - vision-meta (если описание = пусто)
 */

import { getPreferencesStore, type Preferences } from "../preferences/store.js";
import { listLoaded } from "../../lmstudio-client.js";
import {
  ROLE_REQUIRED_CAPS_INTERNAL,
  type ModelRole,
} from "./model-role-resolver-internals.js";

export interface FallbackAttempt<T> {
  modelKey: string;
  ok: boolean;
  durationMs: number;
  result?: T;
  error?: string;
  /** Если задан isAcceptable, и он вернул false — попытка считается «неприемлемой». */
  rejectedByPredicate?: boolean;
}

export interface FallbackResult<T> {
  modelKey: string | null;
  result: T | null;
  attempts: FallbackAttempt<T>[];
  totalDurationMs: number;
}

export interface FallbackOptions<T> {
  /** Роль (для извлечения cap-фильтров и pref ключей). */
  role: ModelRole;
  /** Сама работа: получить результат от модели по modelKey. */
  task: (modelKey: string) => Promise<T>;
  /**
   * Опциональный predicate качества. Если возвращает `false` — мы считаем
   * результат «плохим» и пробуем следующую модель. Если не задан, любой
   * результат без throw считается успехом.
   */
  isAcceptable?: (result: T) => boolean;
  /** Optional: явный override списка моделей (минует prefs). */
  models?: string[];
  /** Optional: для тестов и UI. */
  onAttempt?: (attempt: FallbackAttempt<T>) => void;
  /** Аборт всей цепочки. */
  signal?: AbortSignal;
}

const PREF_KEYS: Record<ModelRole, { primary: string; fallback: string | null }> = {
  crystallizer:         { primary: "extractorModel",           fallback: "extractorModelFallbacks" },
  vision_meta:          { primary: "visionModelKey",           fallback: "visionModelFallbacks" },
  vision_ocr:           { primary: "visionModelKey",           fallback: "visionModelFallbacks" },
  vision_illustration:  { primary: "visionModelKey",           fallback: "visionModelFallbacks" },
  evaluator:            { primary: "evaluatorModel",           fallback: "evaluatorModelFallbacks" },
  ukrainian_specialist: { primary: "ukrainianSpecialistModel", fallback: "ukrainianSpecialistModelFallbacks" },
  lang_detector:        { primary: "langDetectorModel",        fallback: "langDetectorModelFallbacks" },
  translator:           { primary: "translatorModel",          fallback: "translatorModelFallbacks" },
  layout_assistant:     { primary: "layoutAssistantModel",     fallback: "layoutAssistantModelFallbacks" },
};

/**
 * Собирает упорядоченный список кандидатов из prefs + список загруженных
 * в LM Studio (отфильтрованный по capability требованиям роли).
 */
async function buildCandidates(role: ModelRole, prefs: Preferences, override?: string[]): Promise<string[]> {
  if (override && override.length > 0) return [...override];

  const keys = PREF_KEYS[role];
  const primary = (prefs as Record<string, unknown>)[keys.primary];
  const fbVal = keys.fallback ? (prefs as Record<string, unknown>)[keys.fallback] : "";

  const candidates: string[] = [];
  if (typeof primary === "string" && primary.trim()) candidates.push(primary.trim());
  if (typeof fbVal === "string" && fbVal.trim()) {
    for (const c of fbVal.split(",").map((s) => s.trim()).filter(Boolean)) {
      if (!candidates.includes(c)) candidates.push(c);
    }
  }

  /* Пересечение со списком реально загруженных, с фильтром capability. */
  let loaded: import("../../lmstudio-client.js").LoadedModelInfo[] = [];
  try {
    loaded = await listLoaded();
  } catch {
    /* Если LM Studio offline — оставляем кандидатов как есть; task всё равно
       упадёт в свой fallback. */
    return candidates;
  }

  /* Если ни один кандидат не загружен — добавим первую загруженную модель,
     удовлетворяющую capability. Лучше что-то, чем ничего. */
  return filterOrderedCandidatesAgainstLoadedSync(role, candidates, loaded);
}

/**
 * Упорядоченный список ключей → только загруженные в LM Studio и с нужными caps.
 * Если пересечение пустое — одна auto-модель с ролью (как в buildCandidates).
 * При ошибке listLoaded возвращает кандидатов как есть.
 */
export async function filterOrderedCandidatesAgainstLoaded(
  role: ModelRole,
  orderedCandidates: string[],
): Promise<string[]> {
  if (orderedCandidates.length === 0) return [];
  let loaded: import("../../lmstudio-client.js").LoadedModelInfo[] = [];
  try {
    loaded = await listLoaded();
  } catch {
    return [...orderedCandidates];
  }
  return filterOrderedCandidatesAgainstLoadedSync(role, orderedCandidates, loaded);
}

function filterOrderedCandidatesAgainstLoadedSync(
  role: ModelRole,
  orderedCandidates: string[],
  loaded: import("../../lmstudio-client.js").LoadedModelInfo[],
): string[] {
  const requiredCaps = ROLE_REQUIRED_CAPS_INTERNAL[role] ?? [];
  const ok = (key: string): boolean => {
    const m = loaded.find((x) => x.modelKey === key);
    if (!m) return false;
    for (const cap of requiredCaps) if (cap === "vision" && !m.vision) return false;
    return true;
  };
  const filtered = orderedCandidates.filter(ok);
  if (filtered.length === 0) {
    const auto = loaded.find((m) => requiredCaps.every((c) => c !== "vision" || m.vision));
    if (auto) return [auto.modelKey];
  }
  return filtered;
}

/**
 * Запускает задачу с автоматическим fallback на следующую модель из chain.
 *
 * @example
 *   const r = await withModelFallback({
 *     role: "crystallizer",
 *     task: async (modelKey) => {
 *       const resp = await chatWithPolicy(modelKey, prompt);
 *       return JSON.parse(resp.content);
 *     },
 *     isAcceptable: (json) => Array.isArray(json?.delta_knowledge) && json.delta_knowledge.length > 0,
 *   });
 */
export async function withModelFallback<T>(opts: FallbackOptions<T>): Promise<FallbackResult<T>> {
  const t0 = Date.now();
  /* Если явно передан непустой override — НЕ дёргаем prefs/listLoaded.
     Это упрощает unit-тесты и нужно для случаев «уже знаю что хочу». */
  let candidates: string[];
  if (opts.models && opts.models.length > 0) {
    candidates = [...opts.models];
  } else {
    let prefs: Preferences;
    try {
      prefs = await getPreferencesStore().getAll();
    } catch {
      /* Без prefs (тестовая среда / ранний bootstrap) — пустой результат. */
      return { modelKey: null, result: null, attempts: [], totalDurationMs: 0 };
    }
    candidates = await buildCandidates(opts.role, prefs, undefined);
  }

  if (candidates.length === 0) {
    return { modelKey: null, result: null, attempts: [], totalDurationMs: 0 };
  }

  const attempts: FallbackAttempt<T>[] = [];
  for (const modelKey of candidates) {
    if (opts.signal?.aborted) break;
    const ts = Date.now();
    try {
      const result = await opts.task(modelKey);
      const durationMs = Date.now() - ts;
      const accepted = opts.isAcceptable ? opts.isAcceptable(result) : true;
      const attempt: FallbackAttempt<T> = {
        modelKey,
        ok: accepted,
        durationMs,
        /* Всегда сохраняем результат — потребителям нужен последний ChunkResult
           даже при rejectedByPredicate (например delta-extractor). */
        result,
        rejectedByPredicate: opts.isAcceptable ? !accepted : false,
      };
      attempts.push(attempt);
      opts.onAttempt?.(attempt);
      if (accepted) {
        return { modelKey, result, attempts, totalDurationMs: Date.now() - t0 };
      }
      /* В лог: чтобы было видно почему скипнули. */
      console.warn(`[withModelFallback] ${opts.role}: model "${modelKey}" rejected by predicate, trying next`);
    } catch (e) {
      const durationMs = Date.now() - ts;
      const error = e instanceof Error ? e.message : String(e);
      const attempt: FallbackAttempt<T> = { modelKey, ok: false, durationMs, error };
      attempts.push(attempt);
      opts.onAttempt?.(attempt);
      console.warn(`[withModelFallback] ${opts.role}: model "${modelKey}" failed (${error}), trying next`);
    }
  }

  return { modelKey: null, result: null, attempts, totalDurationMs: Date.now() - t0 };
}
