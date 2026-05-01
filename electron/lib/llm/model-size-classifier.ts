/**
 * Model Size Classifier — определяет «весовую категорию» LLM по оценочной VRAM.
 *
 * Зачем нужно:
 *   ImportTaskScheduler решает в какой lane (light/medium/heavy) поставить
 *   задачу. ModelPool использует weight для приоритезации eviction (heavy
 *   модели первые претенденты на освобождение места).
 *
 * Категории (порог по estimated VRAM, MB):
 *   - light:  <= 8 GB  — small/quantized модели типа qwen3-4b, gemma-3-2b.
 *             Можно держать несколько одновременно. Загрузка дешёвая.
 *   - medium: 8..16 GB — типичные 7B-13B модели в Q4_K_M. Ограниченный
 *             параллелизм, но не катастрофа если две одновременно.
 *   - heavy:  > 16 GB  — 22B+ модели типа Qwen3.6-35B-A3B, qwen3-vl-32b.
 *             Strict 1 concurrent в heavy lane, OOM recovery срабатывает
 *             первой стратегией eviction.
 *
 * Источник vramMB: estimateVramMBForModel из model-pool.ts (sizeBytes ×1.3,
 * либо парсинг paramsString/modelKey).
 */

export type ModelWeight = "light" | "medium" | "heavy";

/** Граничные значения, MB. Изменения требуют пересмотра scheduler-стратегий. */
export const LIGHT_MAX_MB = 8 * 1024;
export const MEDIUM_MAX_MB = 16 * 1024;

/**
 * Классификация по estimated VRAM (MB).
 *
 *   classifyByVramMB(4096)  === "light"   // qwen3-4b
 *   classifyByVramMB(9000)  === "medium"  // qwen3-7b Q8
 *   classifyByVramMB(20000) === "heavy"   // qwen3.6-35b
 */
export function classifyByVramMB(vramMB: number): ModelWeight {
  if (!Number.isFinite(vramMB) || vramMB <= 0) {
    /* unknown размер — консервативная оценка как medium (не блокируем,
       но и не пускаем в light lane без ограничений). */
    return "medium";
  }
  if (vramMB <= LIGHT_MAX_MB) return "light";
  if (vramMB <= MEDIUM_MAX_MB) return "medium";
  return "heavy";
}

/** Пороговые числа для UI/диагностики. */
export function describeWeight(weight: ModelWeight): string {
  switch (weight) {
    case "light":  return `light (≤ ${LIGHT_MAX_MB / 1024} GB)`;
    case "medium": return `medium (${LIGHT_MAX_MB / 1024}..${MEDIUM_MAX_MB / 1024} GB)`;
    case "heavy":  return `heavy (> ${MEDIUM_MAX_MB / 1024} GB)`;
  }
}

/**
 * Сортировочный приоритет для eviction: heavy > medium > light.
 * Используется в makeRoom для выбора жертвы при недостатке VRAM.
 *
 * Чем больше число — тем более агрессивно эвиктится (heavy первая).
 */
export function evictionPriority(weight: ModelWeight): number {
  switch (weight) {
    case "heavy":  return 3;
    case "medium": return 2;
    case "light":  return 1;
  }
}
