/**
 * Heuristic auto-configuration of model→task assignment.
 *
 * Когда у пользователя в LM Studio загружено несколько моделей (типичный
 * случай: 3B instruct + 14B reasoning + 7B vision), Bibliary автоматически
 * раскидывает их по задачам:
 *
 *   reader      ← маленькая быстрая instruct модель (3-7B без reasoning markers)
 *   extractor   ← большая reasoning модель (14B+ или с маркерами r1/thinking/qwq)
 *   vision-ocr  ← vision-capable модель (LoadedModelInfo.vision === true)
 *
 * Если ни одна не подходит точно — fallback по размеру (smallest для reader,
 * largest для extractor). Если только одна модель загружена — она идёт на
 * extractor (важнее качество для dataset чем скорость для evaluation).
 *
 * **Pure-logic функция** — принимает loaded models, возвращает рекомендации.
 * Никаких side-effects: caller сам решает сохранять ли в prefs.
 */

import type { LoadedModelInfo } from "../../lmstudio-client.js";

export type Task = "reader" | "extractor" | "vision-ocr";

export interface ModelAssignments {
  reader: string | null;
  extractor: string | null;
  "vision-ocr": string | null;
}

export interface AssignmentReason {
  task: Task;
  modelKey: string | null;
  reason: string;
}

export interface AutoConfigResult {
  assignments: ModelAssignments;
  reasons: AssignmentReason[];
}

/**
 * Reasoning markers — модели обученные под chain-of-thought.
 * Дают +8-12 quality points для structured extraction (LiteCoST).
 */
const REASONING_MARKERS: ReadonlyArray<string> = [
  "r1", "reasoning", "thinking", "qwq", "deepseek-r1",
  "qwen3-thinking", "qwq-32b", "o1-", "o3-",
  "glm-4.7-air-reasoning", "magnum-thinking",
];

/**
 * Small/fast model markers — обычно 3-7B instruct без heavy reasoning.
 */
const SMALL_FAST_MARKERS: ReadonlyArray<string> = [
  "mini", "small", "lite", "flash", "turbo",
  "3b", "1.5b", "1b", "2b",
];

function lowerKey(m: LoadedModelInfo): string {
  return (m.modelKey || m.identifier || "").toLowerCase();
}

function isVision(m: LoadedModelInfo): boolean {
  return m.vision === true;
}

function isReasoning(m: LoadedModelInfo): boolean {
  const key = lowerKey(m);
  return REASONING_MARKERS.some((marker) => key.includes(marker));
}

function isSmallFast(m: LoadedModelInfo): boolean {
  const key = lowerKey(m);
  if (SMALL_FAST_MARKERS.some((marker) => key.includes(marker))) return true;
  /* Fallback по размеру параметров через regex: 3B / 7B markers без B = false. */
  const paramMatch = key.match(/(\d+(?:\.\d+)?)b\b/);
  if (paramMatch) {
    const params = Number.parseFloat(paramMatch[1]);
    if (Number.isFinite(params) && params <= 7) return true;
  }
  return false;
}

function isLargeReasoning(m: LoadedModelInfo): boolean {
  if (isReasoning(m)) return true;
  const key = lowerKey(m);
  const paramMatch = key.match(/(\d+(?:\.\d+)?)b\b/);
  if (paramMatch) {
    const params = Number.parseFloat(paramMatch[1]);
    if (Number.isFinite(params) && params >= 13) return true;
  }
  return false;
}

/**
 * Извлекает примерный размер модели в B-параметрах из имени.
 * Например `qwen3-14b-thinking` → 14, `llama-3-8b-instruct` → 8.
 * Если нет — return null.
 */
function extractParamCount(m: LoadedModelInfo): number | null {
  const key = lowerKey(m);
  const match = key.match(/(\d+(?:\.\d+)?)b\b/);
  if (!match) return null;
  const n = Number.parseFloat(match[1]);
  return Number.isFinite(n) ? n : null;
}

/**
 * Главная функция: распределяет 0..N загруженных моделей по 3 задачам.
 *
 * Алгоритм:
 *   1. **vision-ocr**: первая модель с `vision: true`. Если несколько — берём
 *      ту что больше (по B-параметрам), потому что для OCR важнее качество.
 *   2. **extractor**: первая reasoning-модель. Если нет — самая большая
 *      нон-vision (≥13B приоритет, иначе любая non-vision largest).
 *   3. **reader**: маленькая non-vision non-reasoning. Если все большие —
 *      берём smallest non-vision что осталось после extractor.
 *
 * Если только одна модель — она идёт на extractor. Reader fallback'ится
 * на ту же модель (resolver сам это сделает через preference→fallback).
 */
export function autoConfigureTasks(loaded: LoadedModelInfo[]): AutoConfigResult {
  const reasons: AssignmentReason[] = [];
  const assignments: ModelAssignments = {
    reader: null,
    extractor: null,
    "vision-ocr": null,
  };

  if (loaded.length === 0) {
    reasons.push({ task: "reader", modelKey: null, reason: "no models loaded in LM Studio" });
    reasons.push({ task: "extractor", modelKey: null, reason: "no models loaded" });
    reasons.push({ task: "vision-ocr", modelKey: null, reason: "no models loaded" });
    return { assignments, reasons };
  }

  /* Edge case: одна модель → ставим её на extractor (главная задача).
   * Reader/vision-ocr остаются null — model-resolver fallback'нется на эту
   * единственную модель когда задача поднимется. */
  if (loaded.length === 1) {
    const only = loaded[0]!;
    assignments.extractor = only.modelKey;
    reasons.push({
      task: "extractor",
      modelKey: only.modelKey,
      reason: "only one model loaded — assigned to extractor (most important task)",
    });
    if (isVision(only)) {
      assignments["vision-ocr"] = only.modelKey;
      reasons.push({
        task: "vision-ocr",
        modelKey: only.modelKey,
        reason: "single model is vision-capable — also assigned to OCR",
      });
    }
    return { assignments, reasons };
  }

  /* Step 1: vision-ocr. */
  const visionModels = loaded.filter(isVision);
  if (visionModels.length > 0) {
    /* Сортируем: больше B-параметров = лучше OCR. Если параметры неизвестны,
     * стабильный порядок (по индексу в loaded). */
    const sorted = [...visionModels].sort((a, b) => {
      const ap = extractParamCount(a) ?? 0;
      const bp = extractParamCount(b) ?? 0;
      return bp - ap;
    });
    const pick = sorted[0]!;
    assignments["vision-ocr"] = pick.modelKey;
    reasons.push({
      task: "vision-ocr",
      modelKey: pick.modelKey,
      reason: `vision-capable model${visionModels.length > 1 ? ` (largest of ${visionModels.length})` : ""}`,
    });
  } else {
    reasons.push({
      task: "vision-ocr",
      modelKey: null,
      reason: "no vision-capable model loaded — DJVU OCR will use system OCR (Win.Media.Ocr / macOS Vision)",
    });
  }

  /* Pool для reader/extractor: исключаем vision-only (но vision-capable модели
   * типа Qwen-VL могут работать как text — пока считаем их primarily-vision). */
  const textPool = loaded.filter((m) => !isVision(m));
  if (textPool.length === 0) {
    /* Все модели vision-only. Используем их же для reader/extractor — vision
     * модели обычно умеют чистый текст тоже. */
    reasons.push({
      task: "reader",
      modelKey: null,
      reason: "only vision-capable models loaded; reader+extractor will fallback to vision model via resolver",
    });
    reasons.push({
      task: "extractor",
      modelKey: null,
      reason: "only vision-capable models loaded",
    });
    return { assignments, reasons };
  }

  /* Step 2: extractor — reasoning > large > any. */
  const reasoningModels = textPool.filter(isReasoning);
  let extractorPick: LoadedModelInfo | null = null;
  if (reasoningModels.length > 0) {
    /* Reasoning-маркеры есть — берём самую большую из них (если N>1). */
    const sorted = [...reasoningModels].sort((a, b) => {
      const ap = extractParamCount(a) ?? 0;
      const bp = extractParamCount(b) ?? 0;
      return bp - ap;
    });
    extractorPick = sorted[0]!;
    reasons.push({
      task: "extractor",
      modelKey: extractorPick.modelKey,
      reason: `reasoning-capable model${reasoningModels.length > 1 ? ` (largest of ${reasoningModels.length} reasoning candidates)` : ""}`,
    });
  } else {
    /* Нет reasoning — берём largest по B-параметрам. */
    const largeModels = textPool.filter(isLargeReasoning); /* ≥13B счётом */
    const candidates = largeModels.length > 0 ? largeModels : textPool;
    const sorted = [...candidates].sort((a, b) => {
      const ap = extractParamCount(a) ?? 0;
      const bp = extractParamCount(b) ?? 0;
      return bp - ap;
    });
    extractorPick = sorted[0]!;
    const params = extractParamCount(extractorPick);
    reasons.push({
      task: "extractor",
      modelKey: extractorPick.modelKey,
      reason: params
        ? `largest text model (~${params}B params); no reasoning-tuned model loaded`
        : "first text model; no reasoning-tuned model loaded and size unknown",
    });
  }
  assignments.extractor = extractorPick.modelKey;

  /* Step 3: reader — small/fast не extractor. */
  const remainingText = textPool.filter((m) => m.modelKey !== extractorPick!.modelKey);
  if (remainingText.length === 0) {
    /* Только одна text-модель — extractor её занял. Reader не назначаем
     * (resolver fallback'нет на extractor через первую загруженную). */
    reasons.push({
      task: "reader",
      modelKey: null,
      reason: "no separate small model — reader will fallback to extractor via resolver",
    });
    return { assignments, reasons };
  }

  const fastModels = remainingText.filter(isSmallFast);
  let readerPick: LoadedModelInfo | null;
  if (fastModels.length > 0) {
    /* Маленькая fast — берём smallest по B. */
    const sorted = [...fastModels].sort((a, b) => {
      const ap = extractParamCount(a) ?? 999;
      const bp = extractParamCount(b) ?? 999;
      return ap - bp;
    });
    readerPick = sorted[0]!;
    const params = extractParamCount(readerPick);
    reasons.push({
      task: "reader",
      modelKey: readerPick.modelKey,
      reason: params
        ? `small fast model (~${params}B params)`
        : "small/fast-marked model",
    });
  } else {
    /* Нет явно маленьких — берём smallest из remaining. */
    const sorted = [...remainingText].sort((a, b) => {
      const ap = extractParamCount(a) ?? 999;
      const bp = extractParamCount(b) ?? 999;
      return ap - bp;
    });
    readerPick = sorted[0]!;
    reasons.push({
      task: "reader",
      modelKey: readerPick.modelKey,
      reason: "smallest available text model (no fast-marked candidates)",
    });
  }
  assignments.reader = readerPick.modelKey;

  return { assignments, reasons };
}

/**
 * Конвертирует AutoConfigResult в `Partial<Preferences>` для прямой записи
 * через preferences.set(). Поля null НЕ включаются — caller контролирует
 * хочет ли он перетереть существующие значения пустотой.
 */
export function toPreferenceUpdates(result: AutoConfigResult): {
  readerModel?: string;
  extractorModel?: string;
  visionOcrModel?: string;
} {
  const out: { readerModel?: string; extractorModel?: string; visionOcrModel?: string } = {};
  if (result.assignments.reader) out.readerModel = result.assignments.reader;
  if (result.assignments.extractor) out.extractorModel = result.assignments.extractor;
  if (result.assignments["vision-ocr"]) out.visionOcrModel = result.assignments["vision-ocr"];
  return out;
}
