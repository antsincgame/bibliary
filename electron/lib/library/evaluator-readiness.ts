/**
 * Преfetch проверки готовности Book Evaluator перед импортом.
 *
 * Симметрично OCR Capabilities — отвечает на вопрос «успеет ли evaluator
 * оценить книги или они посыпятся в `failed`». Используется preflight'ом
 * вместе с `getOcrCapabilities()`.
 *
 * Логика выбора модели зеркалит `pickEvaluatorModel`:
 *   1. preferred (из prefs.evaluatorModel) — если в loaded → reading=preferred
 *   2. fallbacks CSV — первый в loaded → reading=fallback
 *   3. Любая другая loaded LLM (если evaluatorAllowFallback=true)
 *   4. Иначе ready=false с конкретной причиной
 *
 * Не вызывает loadModel — preflight read-only.
 */

import { listLoaded } from "../../lmstudio-client.js";
import { readPipelinePrefsOrNull } from "../preferences/store.js";

export interface EvaluatorReadiness {
  /** Хотя бы какая-то LLM-модель будет использована для оценки. */
  ready: boolean;
  /** modelKey что юзер указал в prefs.evaluatorModel (если задан). */
  preferred?: string;
  /** modelKey которая фактически будет использована (preferred / fallback / auto-pick). */
  willUse?: string;
  /** Источник выбора willUse — какой механизм сработал. */
  source?: "preferred" | "fallback" | "auto-pick";
  /**
   * Если ready=false — точная причина.
   * - "preferred-not-loaded" — preferred задан, но не загружен, и fallback запрещён/тоже не работает
   * - "no-llm-loaded" — в LM Studio вообще нет загруженных LLM
   * - "lm-studio-unreachable" — listLoaded() упал
   */
  reason?: string;
  /** Включена ли политика smart-fallback в prefs (false = строгий выбор preferred). */
  fallbackPolicyEnabled: boolean;
}

const CSV_FALLBACK_SEPARATOR = /[\s,;]+/;

export async function getEvaluatorReadiness(): Promise<EvaluatorReadiness> {
  const prefs = await readPipelinePrefsOrNull();
  const preferred = prefs?.evaluatorModel?.trim() ?? "";
  const fallbacksRaw = prefs?.evaluatorModelFallbacks?.trim() ?? "";
  const fallbacks = fallbacksRaw
    ? fallbacksRaw.split(CSV_FALLBACK_SEPARATOR).map((s) => s.trim()).filter(Boolean)
    : [];
  /* prefs.evaluatorAllowFallback — новое поле, default true.
     Если поле не существует (старые prefs) — считаем true. */
  const fallbackPolicyEnabled = prefs?.evaluatorAllowFallback ?? true;

  let loaded;
  try {
    loaded = await listLoaded();
  } catch (err) {
    return {
      ready: false,
      preferred: preferred || undefined,
      reason: `lm-studio-unreachable: ${err instanceof Error ? err.message : String(err)}`,
      fallbackPolicyEnabled,
    };
  }

  /* Фильтруем embedder-модели — они не подходят для chat-инференса. */
  const llms = loaded.filter((m) => !looksLikeEmbedder(m.modelKey));
  const llmKeys = new Set(llms.map((m) => m.modelKey));

  /* 1. preferred. */
  if (preferred && llmKeys.has(preferred)) {
    return {
      ready: true,
      preferred,
      willUse: preferred,
      source: "preferred",
      fallbackPolicyEnabled,
    };
  }

  /* 2. CSV fallbacks. */
  for (const candidate of fallbacks) {
    if (llmKeys.has(candidate)) {
      return {
        ready: true,
        preferred: preferred || undefined,
        willUse: candidate,
        source: "fallback",
        fallbackPolicyEnabled,
      };
    }
  }

  /* 3. auto-pick.
     Гейт strict-mode в picker'е (allowAnyLoadedFallback=false) применяется ТОЛЬКО
     когда preferred задан (см. book-evaluator-model-picker.ts). Без preferred —
     picker всё равно делает auto-pick; поэтому здесь зеркалим то же условие:
     любая loaded LLM означает ready=true независимо от fallbackPolicyEnabled. */
  if ((fallbackPolicyEnabled || !preferred) && llms.length > 0) {
    /* Простая эвристика — первая loaded LLM. Picker сделает scoring и может
       выбрать другую; здесь preflight просто сообщает «что-то будет». */
    const first = llms[0]!.modelKey;
    return {
      ready: true,
      preferred: preferred || undefined,
      willUse: first,
      source: "auto-pick",
      fallbackPolicyEnabled,
    };
  }

  /* 4. ничего не подходит. */
  if (preferred && !llmKeys.has(preferred)) {
    return {
      ready: false,
      preferred,
      reason: "preferred-not-loaded",
      fallbackPolicyEnabled,
    };
  }
  return {
    ready: false,
    reason: "no-llm-loaded",
    fallbackPolicyEnabled,
  };
}

function looksLikeEmbedder(modelKey: string): boolean {
  const k = modelKey.toLowerCase();
  return k.includes("embed") || k.includes("nomic-embed");
}
