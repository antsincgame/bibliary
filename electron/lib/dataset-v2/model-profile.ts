/**
 * Адаптивные профили LLM-моделей для Crystallizer pipeline.
 *
 * Каждая модель из `electron/defaults/curated-models.json` помечена тегами:
 *   - "thinking-heavy"        — Qwen3.6 / DeepSeek-R1 style; жгут <think> блоки
 *   - "non-thinking-instruct" — прямой ответ без reasoning prelude
 *   - "tool-capable-coder"    — топ для structured extraction
 *   - "small-fast"            — ≤4B; last resort
 *
 * Профиль определяет:
 *   - maxTokens budget (thinking-heavy нужен 16k+, чтобы не съесть JSON на reasoning)
 *   - useResponseFormat (включать ли constrained JSON Schema decoding)
 *   - stop sequences (закрыть `</think>` для thinking-моделей)
 *   - chatTemplateKwargs (Qwen `enable_thinking: false` где поддерживается)
 *
 * Если modelKey не найден в curated → консервативный default-профиль (4096 tokens, no responseFormat).
 * Это backwards-compat для пользовательских моделей.
 */

import { promises as fs } from "fs";
import * as path from "path";

export type ModelTag =
  | "thinking-heavy"
  | "thinking-light"
  | "non-thinking-instruct"
  | "tool-capable-coder"
  | "tool-capable"
  | "small-fast"
  | "long-context"
  | "flagship"
  | "code"
  | "chat"
  | "agent"
  | "extractor"
  | "judge"
  | "fallback";

export interface ModelProfile {
  /** Откуда взят профиль (для логов). */
  source: "thinking-heavy" | "tool-capable-coder" | "non-thinking-instruct" | "small-fast" | "default-fallback";
  /** Все теги модели из curated-models.json (если найдена). */
  tags: ModelTag[];
  /** Бюджет токенов на ОДИН response. Thinking-моделям нужно 16k+. */
  maxTokens: number;
  /** Включить ли response_format=json_schema. Forces JSON output даже для слабых моделей. */
  useResponseFormat: boolean;
  /** Stop sequences (Qwen `</think>` обрывает reasoning хвост). */
  stop?: string[];
  /** Qwen-style enable_thinking control. */
  chatTemplateKwargs?: Record<string, unknown>;
}

interface CuratedModel {
  id: string;
  modelKey: string;
  tags: string[];
}

interface CuratedModelsFile {
  models: CuratedModel[];
}

const CACHE: { models: CuratedModel[] | null } = { models: null };

/**
 * Несколько кандидатов на расположение bundled defaults — порядок важен.
 * Используется единый список путей по всему пайплайну dataset-v2.
 */
function curatedCandidates(): string[] {
  const candidates: string[] = [];
  if (process.env.BIBLIARY_DEFAULTS_DIR) {
    candidates.push(path.join(process.env.BIBLIARY_DEFAULTS_DIR, "curated-models.json"));
  }
  if (typeof __dirname !== "undefined") {
    candidates.push(path.resolve(__dirname, "..", "..", "defaults", "curated-models.json"));
  }
  candidates.push(path.resolve(process.cwd(), "electron", "defaults", "curated-models.json"));
  return candidates;
}

async function loadCurated(): Promise<CuratedModel[]> {
  if (CACHE.models) return CACHE.models;
  for (const candidate of curatedCandidates()) {
    try {
      const raw = await fs.readFile(candidate, "utf8");
      const parsed = JSON.parse(raw) as CuratedModelsFile;
      if (Array.isArray(parsed.models) && parsed.models.length > 0) {
        CACHE.models = parsed.models;
        return parsed.models;
      }
    } catch {
      /* try next */
    }
  }
  /* curated не найден — пустой список = default-fallback для всех моделей. */
  CACHE.models = [];
  return [];
}

/**
 * Подобрать профиль по modelKey. Сравнение строгое (modelKey === modelKey).
 *
 * Если модель thinking-heavy — даём большой budget и stop на `</think>`,
 * плюс пытаемся выключить thinking через chat_template_kwargs (Qwen 3.6+).
 *
 * Если non-thinking-instruct или tool-capable-coder — средний budget +
 * включаем JSON Schema decoding (модель умная, но мы хотим гарантию структуры).
 *
 * Если small-fast — низкий budget + JSON Schema (форсируем структуру у слабой модели).
 *
 * Default — 4096 токенов, без structured output (обратная совместимость).
 */
export async function getModelProfile(modelKey: string): Promise<ModelProfile> {
  const curated = await loadCurated();
  const found = curated.find((m) => m.modelKey === modelKey);
  if (!found) {
    return {
      source: "default-fallback",
      tags: [],
      maxTokens: 4096,
      useResponseFormat: false,
    };
  }
  const tags = found.tags as ModelTag[];

  if (tags.includes("thinking-heavy")) {
    return {
      source: "thinking-heavy",
      tags,
      /* 32k токенов — дать reasoning-модели возможность пройти полный
         <think>...</think> цикл И написать структурированный JSON после.
         Эмпирически: qwen3.6-35b с 16k тратит ~900 токенов на thinking
         и обрезается на stop=</think> с пустым content. 32k — безопасный
         запас для большинства глав книг. */
      maxTokens: 32768,
      /* response_format=json_schema критично для thinking-моделей: constrained
         decoding принудит модель завершить JSON-структуру после thinking. Без
         этого она может писать prose-ответ вместо JSON. */
      useResponseFormat: true,
      /* НЕ ставим stop=["</think>"]: эмпирически он обрезает thinking ДО того
         как модель начала писать content/JSON, оставляя пустой ответ. Без stop
         модель сама закроет </think> и продолжит JSON-output (constrained
         response_format её обязывает). */
      chatTemplateKwargs: { enable_thinking: false },
    };
  }
  if (tags.includes("tool-capable-coder")) {
    return {
      source: "tool-capable-coder",
      tags,
      maxTokens: 8192,
      useResponseFormat: true,
    };
  }
  if (tags.includes("non-thinking-instruct")) {
    return {
      source: "non-thinking-instruct",
      tags,
      maxTokens: 8192,
      useResponseFormat: true,
    };
  }
  if (tags.includes("small-fast")) {
    return {
      source: "small-fast",
      tags,
      maxTokens: 4096,
      useResponseFormat: true,
    };
  }
  /* В curated, но без поведенческих тегов — даём средний budget без force JSON. */
  return {
    source: "default-fallback",
    tags,
    maxTokens: 4096,
    useResponseFormat: false,
  };
}
