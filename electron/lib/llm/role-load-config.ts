/**
 * Per-role LM Studio load configs — оптимальные параметры загрузки модели
 * под каждую роль pipeline'а.
 *
 * Источник: https://lmstudio.ai/docs/typescript/api-reference/llm-load-model-config
 *
 * Доступные параметры load:
 *   - contextLength    — длина контекста в токенах (главный driver RAM)
 *   - gpu.ratio        — 0..1 | "max" | "off" (доля слоёв на GPU)
 *   - flashAttention   — true для длинных контекстов (≥8K), снижает RAM/ускоряет
 *   - keepModelInMemory — не свопить в диск (важно для часто вызываемых ролей)
 *   - tryMmap          — memory-mapped загрузка (быстрый cold start)
 *   - offload_kv_cache_to_gpu — KV cache в GPU memory (для длинных контекстов)
 *
 * ВАЖНО про SDK vs REST:
 *   LM Studio даёт ДВА разных API контракта:
 *     - REST `/api/v1/models/load` — принимает ТОЛЬКО:
 *         model, context_length, flash_attention, echo_load_config
 *     - TypeScript SDK `@lmstudio/sdk` — принимает rich config (gpu, mmap,
 *       keepInMemory и т.д.)
 *
 *   Bibliary Olympics ходит по REST, поэтому из этого файла В HTTP body
 *   попадают ТОЛЬКО `contextLength` и `flashAttention`. Поля `gpu`,
 *   `keepModelInMemory`, `tryMmap` оставлены в `LMSLoadConfig` как
 *   forward-compatible blueprint для будущего SDK-route.
 *
 *   См. docs/audits/2026-04-29-lmstudio-role-tuning.md и
 *   regression-тест `tests/olympics-lifecycle.test.ts` ("ТОЛЬКО валидные
 *   REST-поля").
 */

import type { ModelRole } from "./model-role-resolver.js";

/**
 * Load-config совместимый с lmstudio @lmstudio/sdk:
 *   client.llm.load(modelKey, { config: <LMSLoadConfig> })
 */
export interface LMSLoadConfig {
  /** Длина контекста в токенах. */
  contextLength?: number;
  /** GPU offload: "max" — всё в GPU, "off" — все слои на CPU, 0..1 — пропорция. */
  gpu?: { ratio: "max" | "off" | number };
  /** FlashAttention — ОБЯЗАТЕЛЬНО для длинных контекстов (≥8K), даёт x2 speedup. */
  flashAttention?: boolean;
  /** Не свопить модель в диск (для часто вызываемых ролей). */
  keepModelInMemory?: boolean;
  /** Memory-mapped загрузка (быстрый cold start, но может тормозить если модель >RAM). */
  tryMmap?: boolean;
}

/**
 * Производственные load-configs per role.
 *
 * Принципы:
 *   - contextLength = max(input + output) разумного использования + margin 20%
 *   - flashAttention = true когда contextLength ≥ 8K (заметный gain) или
 *     роль обрабатывает длинные тексты
 *   - keepModelInMemory = true для часто вызываемых ролей (crystallizer/evaluator/
 *     vision_*), чтобы избежать swap-thrashing при batch import
 *   - gpu = "max" по умолчанию (Bibliary local-first, GPU должен быть полностью
 *     загружен). Если RAM/VRAM критичен — оставить unset (LM Studio сам подберёт)
 */
export const ROLE_LOAD_CONFIG: Record<ModelRole, LMSLoadConfig> = {
  crystallizer: {
    contextLength: 32_768,
    gpu: { ratio: "max" },
    flashAttention: true,
    keepModelInMemory: true,
    tryMmap: true,
  },
  evaluator: {
    contextLength: 4_096,
    gpu: { ratio: "max" },
    flashAttention: false,
    keepModelInMemory: true,
    tryMmap: true,
  },
  vision_ocr: {
    contextLength: 8_192,
    gpu: { ratio: "max" },
    flashAttention: true,
    keepModelInMemory: true,
    tryMmap: true,
  },
  vision_illustration: {
    contextLength: 4_096,
    gpu: { ratio: "max" },
    flashAttention: false,
    keepModelInMemory: true,
    tryMmap: true,
  },
  ukrainian_specialist: {
    /* Тот же профиль что crystallizer — роль работает как специализированный
     * crystallizer для украинских книг (длинные chunks, structured extraction). */
    contextLength: 32_768,
    gpu: { ratio: "max" },
    flashAttention: true,
    keepModelInMemory: true,
    tryMmap: true,
  },
};

/**
 * Get the recommended LM Studio load configuration for a given role.
 *
 * Если role нет в маппинге (legacy), вернёт безопасный дефолт.
 */
export function getRoleLoadConfig(role: ModelRole): LMSLoadConfig {
  return ROLE_LOAD_CONFIG[role] ?? {
    contextLength: 4_096,
    gpu: { ratio: "max" },
    keepModelInMemory: false,
    tryMmap: true,
  };
}

/**
 * Inference-time defaults — параметры на каждый predict() запрос
 * (НЕ load-time). Передаются в `complete()`/`chat()`.
 *
 * Эти значения уже используются в olympics.ts через maxTokens у дисциплины
 * и system prompt; здесь — research-blueprint для будущей унификации.
 */
export interface InferenceDefaults {
  /** Креативность 0-2. Более низкая → детерминизм. */
  temperature: number;
  /** Top-p sampling. */
  topP: number;
  /** Максимум токенов на ответ. */
  maxTokens: number;
}

export const ROLE_INFERENCE_DEFAULTS: Record<ModelRole, InferenceDefaults> = {
  crystallizer:         { temperature: 0.1, topP: 0.9, maxTokens: 2048 },
  evaluator:            { temperature: 0.2, topP: 0.9, maxTokens: 512 },
  vision_ocr:           { temperature: 0.0, topP: 0.7, maxTokens: 1024 },
  vision_illustration:  { temperature: 0.3, topP: 0.9, maxTokens: 384 },
  ukrainian_specialist: { temperature: 0.1, topP: 0.9, maxTokens: 2048 },
};

export function getRoleInferenceDefaults(role: ModelRole): InferenceDefaults {
  return ROLE_INFERENCE_DEFAULTS[role] ?? { temperature: 0.2, topP: 0.9, maxTokens: 1024 };
}
