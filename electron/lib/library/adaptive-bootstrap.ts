/**
 * Adaptive scheduling bootstrap — production wiring of AIMD + memory probe.
 *
 * Phalanx Risk Mitigation (Google review):
 *   - minConcurrency = 1 жёстко на heavy/medium lanes (защита от lazy V8 GC).
 *   - Soft decrease (-1 per pressure event), не мультипликатив 0.5.
 *   - global.gc() try перед force decrease (если запущен с --expose-gc).
 *   - Memory probe gate by activeImports counter — не работает вне импорта.
 *   - VRAM probe — раз в 30s, кэширует ошибки, отключается после первого fail.
 *
 * Lifecycle:
 *   - `beginImport()` инкремент counter; если первый — старт probe + attach AIMD
 *   - `endImport()` декремент; если последний — стоп probe + detach AIMD
 */

import { AimdController } from "../llm/aimd-controller.js";
import { getImportScheduler } from "./import-task-scheduler.js";
import { startMemoryProbe, stopMemoryProbe } from "../resilience/memory-probe.js";
import { readPipelinePrefsOrNull } from "../preferences/store.js";

const HEAVY_AIMD_NAME = "scheduler.heavy";
const MEDIUM_AIMD_NAME = "scheduler.medium";

interface State {
  active: number;
  controllers: { heavy: AimdController | null; medium: AimdController | null };
}

const STATE: State = {
  active: 0,
  controllers: { heavy: null, medium: null },
};

export function isAdaptiveActive(): boolean {
  return STATE.active > 0;
}

/**
 * Caller вызывает при старте импорта (begin), перед import-pool spinning up.
 * Idempotent — несколько активных импортов держат probes alive до последнего.
 */
export async function beginImport(): Promise<void> {
  STATE.active += 1;
  if (STATE.active > 1) return;
  let prefs;
  try {
    prefs = await readPipelinePrefsOrNull();
  } catch {
    prefs = null;
  }
  if (prefs?.adaptiveSchedulingEnabled === false) return;

  const scheduler = getImportScheduler();
  const heavyInitial = Math.max(1, prefs?.schedulerHeavyConcurrency ?? 1);
  const mediumInitial = Math.max(1, prefs?.schedulerMediumConcurrency ?? 3);

  /* AIMD heavy: minLimit=1 (Phalanx — никогда не глохнем),
     maxLimit=heavyInitial * 2 (но ≤ 4, что уже cap в schema). */
  const heavyCtl = new AimdController({
    name: HEAVY_AIMD_NAME,
    initialLimit: heavyInitial,
    minLimit: 1,
    maxLimit: Math.min(4, heavyInitial * 2),
    successRateThreshold: 0.92,
    latencyP95Threshold: 90_000,
    onLimitChange: (newLimit) => scheduler.setLimit("heavy", newLimit),
  });
  const mediumCtl = new AimdController({
    name: MEDIUM_AIMD_NAME,
    initialLimit: mediumInitial,
    minLimit: 1,
    maxLimit: Math.min(8, mediumInitial * 2),
    successRateThreshold: 0.95,
    latencyP95Threshold: 60_000,
    onLimitChange: (newLimit) => scheduler.setLimit("medium", newLimit),
  });
  scheduler.attachAimd("heavy", heavyCtl);
  scheduler.attachAimd("medium", mediumCtl);
  STATE.controllers.heavy = heavyCtl;
  STATE.controllers.medium = mediumCtl;

  /* Memory probe: RAM 5s / VRAM 30s. on pressure → forceDecrease на heavy
     (тяжелее всего давит на VRAM/RAM), и medium как опцию. */
  startMemoryProbe({
    onPressure: (kind) => {
      const heavy = STATE.controllers.heavy;
      const medium = STATE.controllers.medium;
      if (kind === "vram") {
        heavy?.forceDecreaseOnPressure();
      } else {
        /* RAM/RSS — давим medium и heavy симметрично. */
        heavy?.forceDecreaseOnPressure();
        medium?.forceDecreaseOnPressure();
      }
    },
  });
}

export function endImport(): void {
  if (STATE.active <= 0) return;
  STATE.active -= 1;
  if (STATE.active > 0) return;

  const scheduler = getImportScheduler();
  scheduler.detachAimd("heavy");
  scheduler.detachAimd("medium");
  STATE.controllers.heavy = null;
  STATE.controllers.medium = null;
  stopMemoryProbe();
}

/* For tests. */
export function _resetAdaptiveStateForTests(): void {
  STATE.active = 0;
  STATE.controllers.heavy = null;
  STATE.controllers.medium = null;
}
