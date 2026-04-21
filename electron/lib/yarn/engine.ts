/**
 * YaRN Engine — чистая логика расширения контекста.
 *
 * Без файловых операций, без зависимостей кроме типов и БД моделей.
 * Все функции детерминированы и тестируемы.
 *
 * Источники формул:
 *  - YaRN paper (Peng et al., 2023) — factor = target / native
 *  - flozi.net 2026 KV cache calculator — bytes = 2 * L * Hkv * Hd * ctx * dtype
 *  - dev.to plasmon_imp 2026 — Q4_0 KV cache → 0.5 байт/элемент, Q8_0 → 1 байт
 */

import nativeDb from "./native-contexts.json";

// ─────────────────────────────────────────────────────────────────────────────
// Типы
// ─────────────────────────────────────────────────────────────────────────────

export type KVDtype = "fp16" | "q8_0" | "q4_0";

export interface ModelArch {
  modelKey: string;
  displayName: string;
  /** Параметры модели в миллиардах. Для MoE — total. */
  params: number;
  /** Активные параметры для MoE. Опционально. */
  activeParams?: number;
  /** Нативный максимум контекста. */
  nativeTokens: number;
  /** Официальный YaRN-потолок. Превышение возможно, но качество не гарантируется. */
  yarnMaxTokens: number;
  /** Количество transformer-блоков. Используется в формуле KV-cache. */
  nLayers: number;
  /** KV heads (с GQA обычно меньше attention heads). */
  nKvHeads: number;
  /** Размерность каждой головы. */
  headDim: number;
  family: "qwen2" | "qwen3" | "llama3" | "mistral" | "gemma" | "phi3" | "deepseek" | "unknown";
  /** Размер каждого weight'а в байтах для FP16. */
  dtypeBytes: number;
  moe: boolean;
  vendor: string;
}

export interface RopeScalingConfig {
  rope_type: "yarn";
  factor: number;
  original_max_position_embeddings: number;
}

export interface KVCacheEstimate {
  /** Байт. */
  bytes: number;
  /** Гигабайт (округлено до 0.01). */
  gb: number;
  /** Какой dtype использован. */
  dtype: KVDtype;
}

export interface ContextRecommendation {
  /** Целевое значение контекста в токенах. */
  targetTokens: number;
  /** Нужен ли YaRN. False, если target ≤ native. */
  yarnRequired: boolean;
  /** Конфиг YaRN. null, если YaRN не требуется. */
  ropeScaling: RopeScalingConfig | null;
  /** Превышает ли target официальный yarnMaxTokens (warning). */
  exceedsYarnMax: boolean;
  /** Оценка KV-cache при оптимальном dtype. */
  kvEstimate: KVCacheEstimate;
  /** Все три варианта KV-cache, чтобы UI мог показать сравнение. */
  kvVariants: Record<KVDtype, KVCacheEstimate>;
}

// ─────────────────────────────────────────────────────────────────────────────
// БД моделей
// ─────────────────────────────────────────────────────────────────────────────

interface NativeDbShape {
  models: ModelArch[];
  fallback: Omit<ModelArch, "modelKey">;
}

const DB = nativeDb as NativeDbShape;

/**
 * Возвращает архитектуру модели по ключу. Если модель не в БД — возвращает
 * `fallback` с проставленным `modelKey`. Поиск регистронезависимый и устойчив
 * к различиям в разделителях (`qwen/qwen3-8b` ≡ `Qwen/Qwen3-8B`).
 */
export function getModelArch(modelKey: string): ModelArch {
  const norm = normalizeModelKey(modelKey);
  for (const m of DB.models) {
    if (normalizeModelKey(m.modelKey) === norm) return m;
  }
  return { ...DB.fallback, modelKey };
}

export function listKnownModels(): ModelArch[] {
  return [...DB.models];
}

function normalizeModelKey(key: string): string {
  return key.toLowerCase().replace(/[\s_]+/g, "-");
}

// ─────────────────────────────────────────────────────────────────────────────
// Расчёт RoPE scaling
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Возвращает rope_scaling JSON для LM Studio model card.
 *
 * Возвращает `null`, когда YaRN не нужен:
 *  - target ≤ native (модель уже умеет столько)
 *  - target ≤ 0 (некорректный ввод)
 *
 * Иначе — `{ rope_type: "yarn", factor, original_max_position_embeddings }`.
 *
 * Factor округляется вверх до ближайшего "хорошего" значения {1.5, 2, 3, 4, 6, 8},
 * это снижает деградацию качества — Qwen team рекомендует целые / полуцелые factor.
 */
export function computeRopeScaling(target: number, native: number): RopeScalingConfig | null {
  if (!Number.isFinite(target) || !Number.isFinite(native)) return null;
  if (target <= 0 || native <= 0) return null;
  if (target <= native) return null;

  const rawFactor = target / native;
  const factor = snapFactor(rawFactor);

  return {
    rope_type: "yarn",
    factor,
    original_max_position_embeddings: native,
  };
}

const FACTOR_STEPS = [1.5, 2, 3, 4, 6, 8, 12, 16] as const;

function snapFactor(raw: number): number {
  for (const step of FACTOR_STEPS) {
    if (raw <= step) return step;
  }
  // Сверх 16× — возвращаем как есть (необычный сценарий, пользователь явно знает)
  return Math.ceil(raw * 2) / 2;
}

/**
 * Достаточен ли нативный контекст модели для запроса?
 * Используется UI чтобы решать — показывать YaRN-секцию или нет.
 */
export function isYarnNeeded(target: number, native: number): boolean {
  return target > native;
}

// ─────────────────────────────────────────────────────────────────────────────
// KV-cache estimator
// ─────────────────────────────────────────────────────────────────────────────

const DTYPE_BYTES: Record<KVDtype, number> = {
  fp16: 2,
  q8_0: 1,
  q4_0: 0.5,
};

/**
 * Оценка размера KV-cache в байтах.
 *
 *   bytes = 2 × n_layers × n_kv_heads × head_dim × context × dtype_bytes
 *
 * Множитель 2 — отдельные тензоры K и V. Используется GQA-friendly формула
 * (n_kv_heads, не n_attention_heads), поэтому Llama3-8B и Qwen3-8B оба дают
 * правильный результат.
 *
 * Batch=1 (single-user inference); для multi-user умножьте на батч.
 */
export function estimateKVCache(arch: ModelArch, contextTokens: number, dtype: KVDtype = "fp16"): KVCacheEstimate {
  const dtypeBytes = DTYPE_BYTES[dtype];
  const bytes = 2 * arch.nLayers * arch.nKvHeads * arch.headDim * Math.max(0, contextTokens) * dtypeBytes;
  const gb = Math.round((bytes / 1024 ** 3) * 100) / 100;
  return { bytes, gb, dtype };
}

// ─────────────────────────────────────────────────────────────────────────────
// Smart-recommendation: какой dtype выбрать?
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Подбирает наиболее качественный KV-dtype, при котором всё помещается в VRAM.
 *
 * Приоритет: fp16 > q8_0 > q4_0. Если даже q4_0 не помещается — возвращает q4_0
 * (UI должен показать warning «не помещается, понадобится offload»).
 *
 * `availableForKV` = свободный VRAM минус веса модели и system overhead.
 */
export function recommendKVDtype(arch: ModelArch, contextTokens: number, availableForKVGb: number): KVDtype {
  if (availableForKVGb <= 0) return "q4_0";

  const fp16 = estimateKVCache(arch, contextTokens, "fp16").gb;
  if (fp16 <= availableForKVGb) return "fp16";

  const q8 = estimateKVCache(arch, contextTokens, "q8_0").gb;
  if (q8 <= availableForKVGb) return "q8_0";

  return "q4_0";
}

// ─────────────────────────────────────────────────────────────────────────────
// Полная рекомендация — единая точка входа для UI
// ─────────────────────────────────────────────────────────────────────────────

export interface RecommendOptions {
  modelKey: string;
  targetTokens: number;
  /** VRAM, доступный для KV-cache (после вычета весов). null/undefined = неизвестно, выбираем fp16. */
  availableForKVGb?: number;
}

/**
 * Универсальный entry-point для context-slider.
 *
 * Принимает желаемый context, возвращает всю информацию для UI:
 *  - нужен ли YaRN
 *  - какой rope_scaling JSON (или null)
 *  - какой KV-dtype оптимален
 *  - размеры всех вариантов dtype для compare-display
 *  - превышает ли потолок официального тестирования
 */
export function recommend(opts: RecommendOptions): ContextRecommendation {
  const arch = getModelArch(opts.modelKey);
  const targetTokens = Math.max(0, Math.floor(opts.targetTokens));

  const ropeScaling = computeRopeScaling(targetTokens, arch.nativeTokens);
  const yarnRequired = ropeScaling !== null;

  const kvVariants: Record<KVDtype, KVCacheEstimate> = {
    fp16: estimateKVCache(arch, targetTokens, "fp16"),
    q8_0: estimateKVCache(arch, targetTokens, "q8_0"),
    q4_0: estimateKVCache(arch, targetTokens, "q4_0"),
  };

  const dtype = opts.availableForKVGb != null
    ? recommendKVDtype(arch, targetTokens, opts.availableForKVGb)
    : "fp16";

  return {
    targetTokens,
    yarnRequired,
    ropeScaling,
    exceedsYarnMax: targetTokens > arch.yarnMaxTokens,
    kvEstimate: kvVariants[dtype],
    kvVariants,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Task presets — человеко-читаемые сценарии для slider'а
// ─────────────────────────────────────────────────────────────────────────────

export interface TaskPreset {
  id: "chat" | "document" | "book" | "codex" | "library";
  /** Иконка-emoji. Используется в UI. */
  icon: string;
  /** Целевой контекст в токенах. */
  tokens: number;
  /** Примерный объём в страницах (для подписи в UI). */
  approxPages: number;
}

export const TASK_PRESETS: ReadonlyArray<TaskPreset> = [
  { id: "chat", icon: "💬", tokens: 8_192, approxPages: 16 },
  { id: "document", icon: "📄", tokens: 32_768, approxPages: 60 },
  { id: "book", icon: "📖", tokens: 131_072, approxPages: 250 },
  { id: "codex", icon: "📚", tokens: 262_144, approxPages: 500 },
  { id: "library", icon: "🏛", tokens: 1_048_576, approxPages: 2000 },
];

/**
 * Выбирает preset, наиболее близкий к target (точное совпадение или больший).
 * Для UI: пользователь двинул слайдер на 100K → подсветится "book" (128K).
 */
export function presetForTokens(target: number): TaskPreset | null {
  for (const p of TASK_PRESETS) {
    if (p.tokens >= target) return p;
  }
  return TASK_PRESETS[TASK_PRESETS.length - 1] ?? null;
}
