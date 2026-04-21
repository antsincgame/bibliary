/**
 * Smart Suggestions — генератор советов для context-slider'а.
 *
 * Чистая логика. Принимает вычисленную рекомендацию + железо, возвращает
 * массив человекочитаемых советов с возможным one-click action.
 *
 * Список Suggestion-1..4 закреплён в плане Phase 3.0.
 */

import type { ContextRecommendation, KVDtype, ModelArch } from "./engine";

export type SuggestionSeverity = "info" | "tip" | "warn" | "good";

export interface Suggestion {
  /** Стабильный идентификатор для i18n и telemetry. */
  id: "kv-fit" | "yarn-not-needed" | "factor-too-high" | "official-supported" | "exceeds-max" | "perf-impact";
  severity: SuggestionSeverity;
  /** Параметры для подстановки в i18n-шаблон UI. */
  params?: Record<string, string | number>;
  /** Опциональное действие, которое может применить пользователь одним кликом. */
  action?: SuggestionAction;
}

export type SuggestionAction =
  | { kind: "set-kv-dtype"; dtype: KVDtype; savedGb: number }
  | { kind: "disable-yarn" }
  | { kind: "lower-target"; suggestedTokens: number };

export interface SuggestionContext {
  arch: ModelArch;
  recommendation: ContextRecommendation;
  /** Доступный VRAM для KV-cache (после вычета весов модели). null = неизвестно. */
  availableForKVGb: number | null;
}

export function buildSuggestions(ctx: SuggestionContext): Suggestion[] {
  const { arch, recommendation, availableForKVGb } = ctx;
  const out: Suggestion[] = [];

  // Suggestion-2: YaRN не нужен, target ≤ native — можно отключить scaling и получить +5-10% perf.
  if (!recommendation.yarnRequired && recommendation.targetTokens > 0) {
    out.push({
      id: "yarn-not-needed",
      severity: "info",
      params: { native: arch.nativeTokens, target: recommendation.targetTokens },
      action: { kind: "disable-yarn" },
    });
    return out;
  }

  // Suggestion-1: KV-cache в FP16 не помещается, есть лекарство (Q8_0 или Q4_0).
  if (availableForKVGb != null && recommendation.kvVariants.fp16.gb > availableForKVGb) {
    if (recommendation.kvVariants.q8_0.gb <= availableForKVGb) {
      const saved = round2(recommendation.kvVariants.fp16.gb - recommendation.kvVariants.q8_0.gb);
      out.push({
        id: "kv-fit",
        severity: "warn",
        params: {
          target: recommendation.targetTokens,
          fp16Gb: recommendation.kvVariants.fp16.gb,
          dtype: "Q8_0",
          newGb: recommendation.kvVariants.q8_0.gb,
          savedGb: saved,
        },
        action: { kind: "set-kv-dtype", dtype: "q8_0", savedGb: saved },
      });
    } else if (recommendation.kvVariants.q4_0.gb <= availableForKVGb) {
      const saved = round2(recommendation.kvVariants.fp16.gb - recommendation.kvVariants.q4_0.gb);
      out.push({
        id: "kv-fit",
        severity: "warn",
        params: {
          target: recommendation.targetTokens,
          fp16Gb: recommendation.kvVariants.fp16.gb,
          dtype: "Q4_0",
          newGb: recommendation.kvVariants.q4_0.gb,
          savedGb: saved,
        },
        action: { kind: "set-kv-dtype", dtype: "q4_0", savedGb: saved },
      });
    } else {
      // Даже Q4 не помещается — предложить уменьшить контекст.
      const safeTokens = guessSafeTokens(arch, availableForKVGb);
      out.push({
        id: "kv-fit",
        severity: "warn",
        params: {
          target: recommendation.targetTokens,
          fp16Gb: recommendation.kvVariants.fp16.gb,
          availableGb: round2(availableForKVGb),
          safeTokens,
        },
        action: { kind: "lower-target", suggestedTokens: safeTokens },
      });
    }
  }

  // Suggestion-3: factor > 4 — perf и качество могут просесть.
  if (recommendation.ropeScaling && recommendation.ropeScaling.factor > 4) {
    out.push({
      id: "factor-too-high",
      severity: "tip",
      params: { factor: recommendation.ropeScaling.factor },
    });
  }

  // Suggestion-5: target превышает officially-supported предел.
  if (recommendation.exceedsYarnMax) {
    out.push({
      id: "exceeds-max",
      severity: "warn",
      params: { target: recommendation.targetTokens, max: arch.yarnMaxTokens },
    });
  }

  // Suggestion-4: positive — модель официально поддерживает этот контекст через YaRN.
  if (
    recommendation.yarnRequired &&
    !recommendation.exceedsYarnMax &&
    recommendation.targetTokens > arch.nativeTokens
  ) {
    out.push({
      id: "official-supported",
      severity: "good",
      params: { max: arch.yarnMaxTokens, vendor: arch.vendor },
    });
  }

  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────────────

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Сколько токенов поместится в FP16 KV-cache при заданном бюджете.
 * Формула обратная estimateKVCache: ctx = bytes / (2 * L * Hkv * Hd * dtype).
 * Округляем вниз до ближайшего "красивого" значения (степень двойки).
 */
function guessSafeTokens(arch: ModelArch, budgetGb: number): number {
  const dtypeBytes = 2; // FP16
  const bytesAvailable = budgetGb * 1024 ** 3;
  const tokensRaw = bytesAvailable / (2 * arch.nLayers * arch.nKvHeads * arch.headDim * dtypeBytes);
  // Округляем вниз до ближайшей степени 2 для красоты UI.
  if (tokensRaw <= 0) return 1024;
  const pow = Math.floor(Math.log2(tokensRaw));
  return Math.max(1024, 2 ** pow);
}
