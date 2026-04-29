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
 * ВНИМАНИЕ: текущая Bibliary НЕ использует этот файл при загрузке моделей
 * (загружает с дефолтным preset из LM Studio). Этот модуль — research-результат,
 * готовый к интеграции в отдельной итерации:
 *   1. Добавить ручку «оптимизировать загрузку» в Models page
 *   2. Передавать getRoleLoadConfig(role) в lmsLoadModel()
 *   3. Тестировать на реальных моделях через Олимпиаду
 *
 * См. docs/audits/2026-04-29-lmstudio-role-tuning.md для обоснования.
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
  /* CRYSTALLIZER: главный путь delta-extractor — длинные главы (overlap +
   * thesis + chunk text), reasoning thinking-block, structured JSON. */
  crystallizer: {
    contextLength: 32_768,
    gpu: { ratio: "max" },
    flashAttention: true,        /* >8K → обязательно */
    keepModelInMemory: true,     /* часто вызывается */
    tryMmap: true,
  },

  /* EVALUATOR: короткое описание книги (≤500 chars), score 0-10 + reasoning.
   * Не нужен длинный контекст. */
  evaluator: {
    contextLength: 4_096,
    gpu: { ratio: "max" },
    flashAttention: false,       /* короткий context — gain незаметен */
    keepModelInMemory: true,     /* много быстрых вызовов */
    tryMmap: true,
  },

  /* JUDGE: бинарный A/B выбор. Минимальный контекст. */
  judge: {
    contextLength: 2_048,
    gpu: { ratio: "max" },
    flashAttention: false,
    keepModelInMemory: true,
    tryMmap: true,
  },

  /* TRANSLATOR: страница текста (до 4K input + 4K output). FA полезен. */
  translator: {
    contextLength: 8_192,
    gpu: { ratio: "max" },
    flashAttention: true,
    keepModelInMemory: false,    /* редко вызывается, не страшно если swap */
    tryMmap: true,
  },

  /* LANG_DETECTOR: один токен на выходе. Минимум всего. */
  lang_detector: {
    contextLength: 1_024,
    gpu: { ratio: 0.5 },         /* мелкая модель, GPU не нужен полностью */
    flashAttention: false,
    keepModelInMemory: false,
    tryMmap: true,
  },

  /* UKRAINIAN_SPECIALIST: генерация связного текста на укр. */
  ukrainian_specialist: {
    contextLength: 4_096,
    gpu: { ratio: "max" },
    flashAttention: false,
    keepModelInMemory: false,
    tryMmap: true,
  },

  /* VISION_META: одна картинка (обложка) → strict JSON. Короткий output. */
  vision_meta: {
    contextLength: 2_048,
    gpu: { ratio: "max" },
    flashAttention: false,
    keepModelInMemory: true,     /* batch import — много обложек подряд */
    tryMmap: true,
  },

  /* VISION_OCR: страница → plain text (может быть длинный). FA важен. */
  vision_ocr: {
    contextLength: 8_192,
    gpu: { ratio: "max" },
    flashAttention: true,
    keepModelInMemory: true,     /* OCR partially batches */
    tryMmap: true,
  },

  /* VISION_ILLUSTRATION: картинка + контекст главы → 1-3 предложения описания. */
  vision_illustration: {
    contextLength: 4_096,
    gpu: { ratio: "max" },
    flashAttention: false,
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
  /* Crystallizer: structured JSON, нужен детерминизм + достаточно для длинных
   * списков фактов и relations. */
  crystallizer:         { temperature: 0.1, topP: 0.9, maxTokens: 2048 },

  /* Evaluator: короткий JSON {score, reasoning}. */
  evaluator:            { temperature: 0.2, topP: 0.9, maxTokens: 512 },

  /* Judge: один токен (A или B). Очень детерминистично. */
  judge:                { temperature: 0.0, topP: 0.5, maxTokens: 16 },

  /* Translator: prose. Низкая температура — точность. */
  translator:           { temperature: 0.2, topP: 0.9, maxTokens: 4096 },

  /* Lang detector: один токен. Идеальный детерминизм. */
  lang_detector:        { temperature: 0.0, topP: 0.5, maxTokens: 8 },

  /* Ukrainian specialist: текст. Чуть выше для естественности. */
  ukrainian_specialist: { temperature: 0.4, topP: 0.95, maxTokens: 1024 },

  /* Vision_meta: strict JSON. Минимум температуры. */
  vision_meta:          { temperature: 0.0, topP: 0.7, maxTokens: 256 },

  /* Vision_ocr: plain text — нужна точность транскрипции. */
  vision_ocr:           { temperature: 0.0, topP: 0.7, maxTokens: 1024 },

  /* Vision_illustration: prose 1-3 предложения с контекстом. */
  vision_illustration:  { temperature: 0.3, topP: 0.9, maxTokens: 384 },
};

export function getRoleInferenceDefaults(role: ModelRole): InferenceDefaults {
  return ROLE_INFERENCE_DEFAULTS[role] ?? { temperature: 0.2, topP: 0.9, maxTokens: 1024 };
}
