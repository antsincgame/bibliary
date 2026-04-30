/**
 * Сборка LM Studio load config для Олимпиады.
 *
 * Олимпиада грузит модель ОДИН раз и прогоняет на ней все дисциплины,
 * которые попадают под её capability-фильтр. Поэтому config выбирается как
 * "максимально-требовательный" среди всех ролей, которые модель будет играть.
 *
 * Извлечено из `olympics.ts` (Phase 2.2 cross-platform roadmap, 2026-04-30).
 */

import { getRoleLoadConfig, type LMSLoadConfig } from "../role-load-config.js";
import type { ModelRole } from "../model-role-resolver.js";

/**
 * Compute the LM Studio load config for a single Olympics run of `modelKey`.
 *
 *   contextLength = max по всем ролям (crystallizer = 32K → cover all)
 *   flashAttention = true если хоть одна роль требует
 *   keepModelInMemory = true если хоть одна роль требует
 *
 * Если `enabled === false` — возвращаем legacy-config (2048, FA=true) чтобы
 * сохранить backward-compat с пользователями где per-role tuning отключён.
 */
export function computeOlympicsLoadConfig(
  rolesToRun: ModelRole[],
  enabled: boolean,
): LMSLoadConfig {
  if (!enabled || rolesToRun.length === 0) {
    return { contextLength: 2048, flashAttention: true };
  }
  const configs = rolesToRun.map((r) => getRoleLoadConfig(r));
  const maxCtx = Math.max(...configs.map((c) => c.contextLength ?? 2048));
  const anyFA = configs.some((c) => c.flashAttention === true);
  const anyKeepInMem = configs.some((c) => c.keepModelInMemory === true);
  const anyMmap = configs.some((c) => c.tryMmap === true);
  /* GPU ratio: если хоть одна роль хочет "max" — берём max; иначе максимум
   * среди числовых; "off" игнорируем — Олимпиаде нужен GPU для адекватного
   * замера efficiency. */
  let gpu: LMSLoadConfig["gpu"] = { ratio: "max" };
  const hasMax = configs.some((c) => c.gpu?.ratio === "max");
  if (!hasMax) {
    const numeric = configs
      .map((c) => c.gpu?.ratio)
      .filter((r): r is number => typeof r === "number");
    if (numeric.length > 0) gpu = { ratio: Math.max(...numeric) };
  }
  return {
    contextLength: maxCtx,
    flashAttention: anyFA,
    keepModelInMemory: anyKeepInMem,
    tryMmap: anyMmap,
    gpu,
  };
}
