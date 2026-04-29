/**
 * Olympics model selection — weight classification + ranking + family de-dup.
 *
 * Извлечён из `olympics.ts` (Mahakala рефакторинг 2026-04-30). Содержит
 * чистую логику отбора моделей в турнир, без HTTP-вызовов и состояния:
 *   - `classifyWeight` — оценка размера модели по `paramsString`/имени
 *   - `pickModelsForOlympicsV1` — основной селектор (LM Studio v1 metadata)
 *   - `pickModelsForOlympics` — backward-compat обёртка для string[] списков
 *
 * Тесты: `tests/olympics-weights.test.ts`.
 */

import type { LmsModelInfo } from "./lms-client.js";
import type { WeightClass } from "./olympics.js";

/**
 * Classify model weight class. Uses `paramsString` from LM Studio v1 API
 * when available (e.g. "4B", "27B", "671B"); falls back to name parsing.
 */
export function classifyWeight(modelKey: string, paramsString?: string | null): WeightClass {
  let n = 0;
  if (paramsString) {
    const pm = paramsString.match(/([\d.]+)\s*B/i);
    if (pm) n = Number(pm[1]);
  }
  if (n <= 0) {
    const lower = modelKey.toLowerCase();
    const m = lower.match(/(\d+(?:\.\d+)?)\s*b\b/);
    if (!m) return "unknown";
    n = Number(m[1]);
  }
  if (!Number.isFinite(n) || n <= 0) return "unknown";
  if (n <= 1.5) return "xs";
  if (n <= 5)   return "s";
  if (n <= 12)  return "m";
  if (n <= 30)  return "l";
  return "xl";
}

/**
 * Select models for Olympics using rich v1 API metadata.
 * Uses architecture, capabilities, and params for smarter selection.
 */
export function pickModelsForOlympicsV1(
  allModels: LmsModelInfo[],
  explicit?: string[],
  maxModels = 6,
  weightClasses?: WeightClass[],
  testAll = false,
): LmsModelInfo[] {
  const eligible = allModels.filter((m) => m.type === "llm");
  if (explicit && explicit.length > 0) {
    return eligible.filter((m) => explicit.includes(m.key));
  }
  if (testAll) return eligible;

  const wantClasses = new Set<WeightClass>(weightClasses ?? ["s", "m"]);
  const withClass = eligible.map((m) => ({
    ...m,
    weight: classifyWeight(m.key, m.paramsString),
  }));

  let filtered = withClass.filter((m) => wantClasses.has(m.weight));
  if (filtered.length === 0) {
    const isWideSearch = wantClasses.has("xs") && wantClasses.has("s") && wantClasses.has("m");
    if (isWideSearch || eligible.length === 0) return eligible.slice(0, maxModels);
    return pickModelsForOlympicsV1(allModels, undefined, maxModels, ["xs", "s", "m"]);
  }

  const score = (m: typeof filtered[0]): number => {
    const lower = m.key.toLowerCase();
    let s = 0;
    if (m.architecture.includes("qwen3") || lower.includes("qwen3")) s += 3;
    else if (lower.includes("qwen")) s += 2;
    if (m.architecture.includes("gemma") || lower.includes("gemma")) s += 2;
    if (lower.includes("ministral") || lower.includes("mistral")) s += 1;
    if (lower.includes("llama")) s += 1;
    if (lower.includes("instruct") || lower.includes("-it")) s += 2;
    if (m.capabilities.trained_for_tool_use) s += 1;
    if (m.capabilities.reasoning) s += 1;
    if (lower.includes("coder") && !lower.includes("instruct")) s -= 1;
    if (lower.includes("abliterated") || lower.includes("uncensored")) s -= 5;
    if (m.loadedInstances.length > 0) s += 3;
    return s;
  };
  const ranked = [...filtered].sort((a, b) => score(b) - score(a));

  const picked: LmsModelInfo[] = [];
  const families = new Set<string>();
  for (const m of ranked) {
    const fam = m.architecture || m.publisher || m.key.split(/[\/\-_]/)[0]!;
    if (families.has(fam) && picked.length >= 2) continue;
    families.add(fam);
    picked.push(m);
    if (picked.length >= maxModels) break;
  }
  return picked;
}

/** Backward-compat wrapper for code using string[] model lists. */
export function pickModelsForOlympics(
  all: string[],
  explicit?: string[],
  maxModels = 6,
  weightClasses?: WeightClass[],
  testAll = false,
): string[] {
  const fakeInfos: LmsModelInfo[] = all.filter((m) => !/embed/i.test(m)).map((key) => ({
    key, type: "llm" as const, publisher: "", displayName: key, architecture: "",
    quantization: { name: "unknown", bits_per_weight: 4 }, sizeBytes: 0,
    paramsString: null, loadedInstances: [], maxContextLength: 0, format: "",
    capabilities: { vision: false, trained_for_tool_use: false }, description: null,
  }));
  return pickModelsForOlympicsV1(fakeInfos, explicit, maxModels, weightClasses, testAll).map((m) => m.key);
}
