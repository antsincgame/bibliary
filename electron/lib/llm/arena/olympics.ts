/**
 * Bibliary Olympics — реальный турнир локальных моделей через LM Studio.
 *
 * Не зависит от Electron — pure-Node, использует прямой fetch на
 * OpenAI-совместимый API LM Studio. Запуск из приложения — через IPC-обёртку
 * в `electron/ipc/arena.ipc.ts`.
 *
 * Дисциплины подобраны под РОЛИ Bibliary: crystallizer / evaluator /
 * translator / vision_* — то есть именно те модели, которые потом используются
 * в реальной работе приложения. Роль `judge` удалена 2026-05-01 (Иt 8А
 * library-fortress) — не имела ни одного production-вызова.
 *
 * Декомпозиция (Phase 2.2 cross-platform roadmap, 2026-04-30):
 *   - Все типы / интерфейсы → `olympics-types.ts`
 *   - `computeOlympicsLoadConfig` → `olympics-load-config.ts`
 *   - LM Studio client (REST + SDK) → `lms-client.ts` (barrel)
 *   - Дисциплины + scoring + model selection — отдельные модули рядом
 *   В этом файле остался ТОЛЬКО `runOlympics` + кэш + barrel re-exports.
 */

import * as telemetry from "../../resilience/telemetry.js";
import {
  DEFAULT_LMS_URL,
  makeLogger,
  lmsListModelsV1,
  lmsListAvailableModels,
  lmsWaitForReady,
  lmsLoadModel,
  lmsHealthCheck,
  lmsUnloadAllInstancesForModel,
  lmsChat,
  estimateModelVramBytes,
  type LmsModelInfo,
} from "./lms-client.js";
import {
  OLYMPICS_DISCIPLINES,
  stripThinkingBlock,
} from "./disciplines.js";
import {
  classifyWeight,
  pickModelsForOlympics,
  pickModelsForOlympicsV1,
} from "./model-selection.js";
import {
  bradleyTerryMLE,
  buildRoleAggregates,
} from "./scoring.js";
import {
  getRoleInferenceDefaults,
} from "../role-load-config.js";
import type { ModelRole } from "../model-role-resolver.js";
import {
  computeOlympicsLoadConfig,
} from "./olympics-load-config.js";
import type {
  WeightClass,
  OlympicsOptions,
  OlympicsModelResult,
  OlympicsMatchResult,
  OlympicsDisciplineResult,
  OlympicsMedalRow,
  OlympicsRoleReason,
  OlympicsModelCapabilities,
  OlympicsReport,
} from "./olympics-types.js";

/* ─── Re-exports for backward-compat ────────────────────────────────────
   Тесты, scripts и IPC импортят символы прямо из `olympics.ts`. Сохраняем
   старый публичный API как barrel — потребители не правятся. */
export {
  lmsListModelsV1,
  lmsListAvailableModels,
  OLYMPICS_DISCIPLINES,
  classifyWeight,
  pickModelsForOlympics,
  pickModelsForOlympicsV1,
  computeOlympicsLoadConfig,
};
export type { LmsModelInfo };
export type {
  WeightClass,
  OlympicsOptions,
  OlympicsEvent,
  OlympicsModelResult,
  OlympicsMatchResult,
  OlympicsRole,
  OlympicsDisciplineResult,
  OlympicsRoleAggregate,
  OlympicsMedalRow,
  OlympicsRoleReason,
  OlympicsModelCapabilities,
  OlympicsReport,
} from "./olympics-types.js";

/* ─── Кэш результатов ─────────────────────────────────────────────────
   Если набор моделей и дисциплин не изменился с прошлого запуска —
   возвращаем кэш мгновенно. Кэш хранится в памяти процесса; при
   перезапуске или clearOlympicsCache() он сбрасывается. */
let _olympicsCache: { key: string; report: OlympicsReport } | null = null;

function makeCacheKey(models: string[], disciplineIds: string[]): string {
  return [...models].sort().join("|") + "@@" + [...disciplineIds].sort().join("|");
}

function makeModelFingerprint(infos: LmsModelInfo[]): string {
  return infos
    .map((m) => [
      m.key,
      m.paramsString ?? "",
      m.sizeBytes || 0,
      m.architecture || "",
      m.capabilities.vision ? "vision" : "",
      m.capabilities.reasoning ? "reasoning" : "",
      m.capabilities.trained_for_tool_use ? "tools" : "",
    ].join(":"))
    .sort()
    .join("|");
}

/** Очистить кэш результатов олимпиады (IPC: arena:clear-olympics-cache). */
export function clearOlympicsCache(): void {
  _olympicsCache = null;
}


export async function runOlympics(opts: OlympicsOptions = {}): Promise<OlympicsReport> {
  const lmsUrl = opts.lmsUrl ?? DEFAULT_LMS_URL;
  const t0 = Date.now();
  const log = makeLogger(opts.onProgress);

  log("info", "Olympics starting", { lmsUrl });

  let allModelInfos: LmsModelInfo[];
  try {
    allModelInfos = await lmsListModelsV1(lmsUrl);
  } catch (e) {
    throw new Error(`LM Studio офлайн (${lmsUrl}): ${e instanceof Error ? e.message : e}`);
  }

  log("info", `found ${allModelInfos.length} LLM models in catalog`);

  const visionCapableKeys = new Set(
    allModelInfos.filter((m) => m.capabilities.vision).map((m) => m.key),
  );
  const reasoningCapableKeys = new Set(
    allModelInfos.filter((m) => m.capabilities.reasoning).map((m) => m.key),
  );

  /* ── Probe pool: расширенный пул для PROBE-фазы (Arena-Lite EMNLP 2025).
   *
   * КРИТИЧЕСКИЙ FIX (Шерлок v0.4.8): probe-фаза ДО фикса работала на уже
   * capped пуле (selectedInfos === maxModels), поэтому условие
   * `selectedInfos.length > maxModels` было ВСЕГДА false в типичном
   * Lightning-сценарии и probe просто не запускался.
   *
   * Решение: получаем расширенный пул (×3 от maxModels или 24, что больше)
   * БЕЗ применения cap'а, прогоняем probe на нём, затем передаём survivors
   * как `explicit` обратно в picker для финального cap + family-dedup.
   *
   * Если maxModels не задан или testAll=true или есть explicit `opts.models` —
   * probe не нужен (пользователь уже сам определил пул). */
  const PROBE_POOL_MULTIPLIER = 3;
  const probeShouldRun = !!(
    !opts.testAll
    && (!opts.models || opts.models.length === 0)
    && opts.maxModels && opts.maxModels > 0
  );
  const probePoolCap = probeShouldRun
    ? Math.max(opts.maxModels! * PROBE_POOL_MULTIPLIER, 24)
    : (opts.maxModels ?? 6);
  const probePool = pickModelsForOlympicsV1(
    allModelInfos,
    opts.models,
    probePoolCap,
    opts.weightClasses,
    opts.testAll,
  );

  /* selectedInfos и models объявляются как `let` — после probe-фазы они
   * могут быть пересобраны через второй вызов picker'а с survivors как
   * explicit-list. */
  let selectedInfos: LmsModelInfo[] = probeShouldRun && probePool.length > opts.maxModels!
    ? probePool  // временно держим расширенный пул для probe-фазы
    : pickModelsForOlympicsV1(
        allModelInfos,
        opts.models,
        opts.maxModels,
        opts.weightClasses,
        opts.testAll,
      );
  let models = selectedInfos.map((m) => m.key);
  if (models.length < 2) {
    const wc = (opts.weightClasses ?? ["s", "m"]).join(",");
    throw new Error(
      `Нужно минимум 2 модели в весовых классах [${wc}]. Найдено: ${models.length}. ` +
      `Доступно в LM Studio: ${allModelInfos.length} LLM. ` +
      `Загрузи 2+ моделей нужного класса.`,
    );
  }

  log("info", `selected ${models.length} models for Olympics`, {
    models,
    visionCount: visionCapableKeys.size,
    reasoningCount: reasoningCapableKeys.size,
    probeShouldRun,
    probePoolSize: probePool.length,
  });

  let targetDisciplines = opts.disciplines
    ? OLYMPICS_DISCIPLINES.filter((d) => opts.disciplines!.includes(d.id) || opts.disciplines!.includes(d.role))
    : OLYMPICS_DISCIPLINES;
  if (opts.roles) {
    const wantRoles = new Set(opts.roles);
    targetDisciplines = targetDisciplines.filter((d) => wantRoles.has(d.role));
  }
  const cacheKey = makeCacheKey(models, targetDisciplines.map((d) => d.id)) + "@@" + makeModelFingerprint(selectedInfos);
  if (_olympicsCache && _olympicsCache.key === cacheKey) {
    log("info", "cache hit — returning cached report");
    opts.onProgress?.({ type: "olympics.done", durationMs: 0 });
    return { ..._olympicsCache.report, totalDurationMs: 0 };
  }
  const modelWeightClass: Record<string, WeightClass> = {};
  const modelInfoMap = new Map<string, LmsModelInfo>();
  for (const info of selectedInfos) {
    modelWeightClass[info.key] = classifyWeight(info.key, info.paramsString);
    modelInfoMap.set(info.key, info);
  }

  const disciplines = targetDisciplines;
  if (disciplines.length === 0) {
    throw new Error(`Нет ни одной дисциплины (запрошено: ${opts.disciplines?.join(", ") ?? "—"})`);
  }

  /* ────────────────────────────────────────────────────────────────────
     SEQUENTIAL LOAD → TEST → UNLOAD  (fixes BSOD 0x000000FD)

     Previous approach loaded ALL models at once, exhausting VRAM+RAM
     and crashing the OS with page file congestion.

     New approach: first clean selected loaded instances, then for each
     model we
       1. Load it
       2. Run ALL disciplines for that model
       3. Unload it immediately to free VRAM
       4. Health-check LM Studio before loading next model

     This means max 1 selected model loaded at a time. Results are
     accumulated per-discipline across models and matched into pairwise
     results at the end.
     ──────────────────────────────────────────────────────────────────── */

  const initiallyLoadedSelected = selectedInfos.filter((m) => m.loadedInstances.length > 0);
  if (initiallyLoadedSelected.length > 0) {
    log("warn", "cleaning selected pre-loaded models before Olympics", {
      models: initiallyLoadedSelected.map((m) => ({
        key: m.key,
        instances: m.loadedInstances.map((x) => x.id),
        estimatedGB: Number((estimateModelVramBytes(m) / 1024 / 1024 / 1024).toFixed(2)),
      })),
    });
    opts.onProgress?.({
      type: "olympics.vram_guard",
      action: "cleanup_preloaded_selected_models",
      estimatedGB: Number(
        (initiallyLoadedSelected.reduce((sum, m) => sum + estimateModelVramBytes(m), 0) / 1024 / 1024 / 1024).toFixed(2),
      ),
      limitGB: 0,
    });
    for (const info of initiallyLoadedSelected) {
      await lmsUnloadAllInstancesForModel(
        lmsUrl,
        info.key,
        log,
        info.loadedInstances.map((x) => x.id),
      );
    }
    await new Promise((res) => setTimeout(res, 2_000));
  }

  opts.onProgress?.({ type: "olympics.start", models, disciplines: disciplines.map((d) => d.id) });
  telemetry.logEvent({ type: "olympics.run", phase: "start", models, disciplines: disciplines.map((d) => d.id) });

  /* SDK transport toggle (default REST). При SDK ошибке runtime fallback. */
  const transport: "rest" | "sdk" = opts.useLmsSDK === true ? "sdk" : "rest";
  if (transport === "sdk") {
    log("info", "LM Studio SDK transport ENABLED", {
      hint: "load/unload через @lmstudio/sdk client.llm.load() — full LLMLoadModelConfig",
    });
  }

  /* ── Probe phase (Arena-Lite EMNLP 2025 / Active Evaluation ICML 2025) ──
   * Быстрый pre-selection probe: один запрос `lang-detect-en` (16 tokens) на
   * каждую модель. Модели со score < PROBE_CUTOFF исключаются из полного
   * прогона — экономит 30–50% времени при наличии "сломанных" моделей.
   *
   * Probe запускается когда задан maxModels-cap И есть запас моделей сверх
   * cap'а — то есть НА РАСШИРЕННОМ пуле (probePool, см. выше), который
   * специально не закаплен. После probe survivors отдаются в picker как
   * `explicit`-list для финальной фильтрации (family-dedup + cap). */
  const probeDiscipline = OLYMPICS_DISCIPLINES.find((d) => d.id === "lang-detect-en");
  const PROBE_CUTOFF = 0.4;
  const probeScores = new Map<string, number>();

  if (probeShouldRun && probeDiscipline && probePool.length > opts.maxModels!) {
    log("info", `PROBE PHASE: testing ${selectedInfos.length} models with "${probeDiscipline.id}" (cutoff=${PROBE_CUTOFF}, target_max=${opts.maxModels})`);
    for (const info of selectedInfos) {
      if (opts.signal?.aborted) break;
      const probeLoadResult = await lmsLoadModel(lmsUrl, info.key, log, opts.signal, undefined, transport);
      if (!probeLoadResult.ok) {
        probeScores.set(info.key, 0);
        await lmsUnloadAllInstancesForModel(lmsUrl, info.key, log, [], transport);
        continue;
      }
      await lmsWaitForReady(lmsUrl, info.key, log, 8_000, opts.signal);
      const pr = await lmsChat(lmsUrl, info.key, probeDiscipline.system, probeDiscipline.user, {
        temperature: 0.2,
        maxTokens: probeDiscipline.maxTokens,
        timeoutMs: 15_000,
        signal: opts.signal,
        postProcess: stripThinkingBlock,
      });
      const ps = pr.ok ? probeDiscipline.score(pr.content) : 0;
      probeScores.set(info.key, ps);
      log("info", `PROBE: ${info.key} → score=${(ps * 100).toFixed(0)}/100 (${pr.durationMs}ms)`, { ok: pr.ok });
      await lmsUnloadAllInstancesForModel(lmsUrl, info.key, log, probeLoadResult.instanceId ? [probeLoadResult.instanceId] : [], transport);
      await new Promise((res) => setTimeout(res, 800));
    }
    const sortedByProbe = [...probeScores.entries()].sort((a, b) => b[1] - a[1]);
    /* Survivors: те, что прошли cutoff. Финальный cap применяется через
     * второй вызов picker'а — он добавит family-dedup и финальный rank. */
    const survivors = sortedByProbe.filter(([, s]) => s >= PROBE_CUTOFF).map(([k]) => k);
    const eliminated = sortedByProbe.filter(([k]) => !survivors.includes(k));
    if (eliminated.length > 0) {
      log("info", `PROBE ELIMINATED ${eliminated.length} models: ${eliminated.map(([k, s]) => `${k}(${(s * 100).toFixed(0)})`).join(", ")}`);
    } else {
      log("info", `PROBE: all ${probeScores.size} models passed cutoff ${PROBE_CUTOFF}`);
    }

    /* Применяем cap+family-dedup к survivors. Если все провалили cutoff —
     * fallback: top-K по probe-score (всегда оставляем хоть кого-то для
     * прогона, иначе турнир пустой). */
    const finalKeys = survivors.length >= 2
      ? survivors
      : sortedByProbe.slice(0, Math.max(opts.maxModels!, 2)).map(([k]) => k);

    selectedInfos = pickModelsForOlympicsV1(
      allModelInfos,
      finalKeys,
      opts.maxModels,
      opts.weightClasses,
      opts.testAll,
    );
    /* Picker возвращает по explicit-list — может вернуть < maxModels (если
     * family-dedup сработал агрессивно). Это OK. */
    if (selectedInfos.length < 2) {
      throw new Error(
        `После probe-фазы осталось только ${selectedInfos.length} моделей (cutoff=${PROBE_CUTOFF}). ` +
        `Загрузи модели получше или подними cutoff в коде.`,
      );
    }
    models = selectedInfos.map((m) => m.key);
    log("info", `PROBE PHASE done: selected ${models.length} models for full Olympics: ${models.join(", ")}`);
  }

  /* Per-role tuning toggle (default off — legacy 2048/temp=0.2). */
  const roleLoadConfigEnabled = opts.roleLoadConfigEnabled === true;
  if (roleLoadConfigEnabled) {
    log("info", "per-role load config ENABLED", {
      hint: "models will load with role-specific contextLength and FA",
    });
  }

  /* Accumulate per-discipline results across the model loop. */
  const disciplineResults = new Map<string, OlympicsModelResult[]>();
  for (const d of disciplines) disciplineResults.set(d.id, []);

  /* ── Adaptive elimination state (Arena-Lite EMNLP 2025) ──
   * Per-role: track leader score. If current model trails leader by ≥ GAP on
   * first discipline of a role → skip remaining disciplines of that role.
   * Saves 20-40% of inference time when there's a clear frontrunner.
   * Only active in Lightning mode (conservative = don't eliminate in Standard). */
  const ADAPTIVE_GAP = 0.35;
  const roleLeaderScore = new Map<string, number>();
  const adaptiveSkips = { count: 0, savedMs: 0 };

  let skippedModels = 0;

  /* Pre-compute roles per model (vision-capability-aware) to choose load config. */
  const rolesByModel = new Map<string, ModelRole[]>();
  for (const info of selectedInfos) {
    const isVision = visionCapableKeys.has(info.key);
    const rolesForModel = new Set<ModelRole>();
    for (const d of disciplines) {
      const role = d.role as ModelRole;
      const isVisionDisc = role === "vision_meta" || role === "vision_ocr"
        || role === "vision_illustration" || (d.role === "vision");
      if (isVisionDisc && !isVision) continue;
      /* Skip legacy "vision" — not in ModelRole type. */
      if (d.role === "vision") continue;
      rolesForModel.add(role);
    }
    rolesByModel.set(info.key, [...rolesForModel]);
  }

  for (const modelInfo of selectedInfos) {
    if (opts.signal?.aborted) break;

    const modelKey = modelInfo.key;
    let instanceId: string | null = null;

    /* ── Step 1: Load model ── */
    if (!await lmsHealthCheck(lmsUrl, log)) {
      log("error", "LM Studio не отвечает — пропускаем модель", { modelKey });
      skippedModels++;
      continue;
    }

    opts.onProgress?.({ type: "olympics.model.loading", model: modelKey });
    const rolesForModel = rolesByModel.get(modelKey) ?? [];
    const modelLoadConfig = computeOlympicsLoadConfig(rolesForModel, roleLoadConfigEnabled);
    const loadResult = await lmsLoadModel(lmsUrl, modelKey, log, opts.signal, modelLoadConfig, transport);
    if (!loadResult.ok) {
      log("warn", `не удалось загрузить — чистим возможный поздний load и пропускаем`, { modelKey, reason: loadResult.reason });
      await lmsUnloadAllInstancesForModel(lmsUrl, modelKey, log, [], transport);
      opts.onProgress?.({ type: "olympics.model.load_failed", model: modelKey, reason: loadResult.reason });
      skippedModels++;
      continue;
    }
    instanceId = loadResult.instanceId;
    opts.onProgress?.({ type: "olympics.model.loaded", model: modelKey, loadTimeMs: loadResult.loadTimeMs });

    await lmsWaitForReady(lmsUrl, modelKey, log, 12_000, opts.signal);

    /* ── Step 2: Run ALL disciplines for this model ── */
    try {
      for (const d of disciplines) {
        if (opts.signal?.aborted) break;

        /* Vision-дисциплины (legacy `vision` + современные `vision_meta`/
         * `vision_ocr`/`vision_illustration`) с image_url требуют
         * мультимодальную модель. Текстовая модель на image_url отдаст
         * пустой/ошибочный ответ. Фильтруем все 4 роли. */
        const isVisionRole = d.role === "vision" || d.role === "vision_meta"
          || d.role === "vision_ocr" || d.role === "vision_illustration";
        const isVisionDiscipline = isVisionRole && !!d.imageUrl;
        if (isVisionDiscipline && !visionCapableKeys.has(modelKey)) continue;

        /* ── Adaptive elimination (Arena-Lite EMNLP 2025) ──
         * If Lightning mode is active AND current role already has a strong
         * leader AND this model already scored poorly on a previous discipline
         * of the same role → skip this discipline to save time.
         *
         * Check: find model's avg score across completed disciplines of d.role.
         * If leader_score - model_avg ≥ ADAPTIVE_GAP → skip. */
        if (opts.maxModels && opts.maxModels > 0) {
          const leaderScore = roleLeaderScore.get(d.role) ?? 0;
          if (leaderScore > 0.3) {
            const modelResultsForRole = disciplines
              .filter((dd) => dd.role === d.role && dd.id !== d.id)
              .flatMap((dd) => (disciplineResults.get(dd.id) ?? []).filter((r) => r.model === modelKey));
            if (modelResultsForRole.length > 0) {
              const modelAvg = modelResultsForRole.reduce((s, r) => s + r.score, 0) / modelResultsForRole.length;
              if (leaderScore - modelAvg >= ADAPTIVE_GAP) {
                log("info", `ADAPTIVE SKIP: ${d.id} for ${modelKey} (leader=${(leaderScore * 100).toFixed(0)}, model=${(modelAvg * 100).toFixed(0)}, gap=${((leaderScore - modelAvg) * 100).toFixed(0)})`);
                adaptiveSkips.count++;
                continue;
              }
            }
          }
        }

        opts.onProgress?.({
          type: "olympics.discipline.start",
          discipline: d.id,
          role: d.role,
          whyImportant: d.whyImportant,
          thinkingFriendly: d.thinkingFriendly,
          maxTokens: d.maxTokens,
        });

        const isReasoning = reasoningCapableKeys.has(modelKey);
        const useReasoning = isReasoning && d.role === "crystallizer";
        /* Per-role inference defaults — only when feature flag enabled.
         * Otherwise legacy: temp=0.6 для reasoning crystallizer, 0.2 иначе. */
        let temperature: number;
        let topP: number | undefined;
        if (roleLoadConfigEnabled && d.role !== "vision") {
          const inf = getRoleInferenceDefaults(d.role as ModelRole);
          temperature = useReasoning ? Math.max(inf.temperature, 0.6) : inf.temperature;
          topP = inf.topP;
        } else {
          temperature = useReasoning ? 0.6 : 0.2;
          topP = undefined;
        }

        /* Thinking/reasoning модели (Qwen3, GLM-4, DeepSeek-R1) вставляют
         * <think>…</think> блок ПЕРЕД ответом, расходуя ~60-80% max_tokens.
         * Без overhead модель с maxTokens=16 тратит ВСЕ токены на <think> и
         * не успевает сгенерировать ответ → score=0. Множитель 4x даёт запас
         * для thinking + полноценного ответа. */
        const thinkingOverhead = isReasoning ? 4 : 1;
        const effectiveMaxTokens = Math.min(d.maxTokens * thinkingOverhead, 4096);

        const r = await lmsChat(lmsUrl, modelKey, d.system, d.user, {
          temperature,
          topP,
          maxTokens: effectiveMaxTokens,
          timeoutMs: opts.perDisciplineTimeoutMs ?? 90_000,
          signal: opts.signal,
          imageUrl: d.imageUrl,
          postProcess: stripThinkingBlock,
        });
        const s = r.ok ? d.score(r.content) : 0;
        /* Для thinking-friendly дисциплин (LiteCoST: complex extraction)
         * не штрафуем модель за длительность — медленный thinking-вывод
         * = норма, а не недостаток. Efficiency = score (без деления на время). */
        const efficiency = d.thinkingFriendly
          ? s
          : (r.durationMs > 0 ? (s * 1000) / r.durationMs : 0);
        const result: OlympicsModelResult = {
          model: modelKey,
          weightClass: classifyWeight(modelKey, modelInfo.paramsString),
          score: s,
          durationMs: r.durationMs,
          ok: r.ok,
          tokens: r.totalTokens,
          sample: r.content.slice(0, 240).replace(/\s+/g, " "),
          error: r.error,
          efficiency,
        };
        disciplineResults.get(d.id)!.push(result);

        /* Update role leader score for adaptive elimination. */
        const currentLeader = roleLeaderScore.get(d.role) ?? 0;
        if (s > currentLeader) roleLeaderScore.set(d.role, s);

        if (s === 0 && r.ok) {
          log("warn", `${d.id} → ${modelKey}: score=0 при ok=true! content(${r.content.length}ch): "${r.content.slice(0, 120)}"`, {
            tokens: r.totalTokens, isReasoning, effectiveMaxTokens, originalMaxTokens: d.maxTokens,
          });
        }
        log("debug", `${d.id} → ${modelKey}: score=${s.toFixed(2)} ${r.durationMs}ms tokens=${r.totalTokens} content=${r.content.length}ch`, {
          ok: r.ok, tokens: r.totalTokens, sample: r.content.slice(0, 80),
        });
        opts.onProgress?.({
          type: "olympics.model.done",
          discipline: d.id,
          role: d.role,
          model: modelKey,
          score: s,
          durationMs: r.durationMs,
          tokens: r.totalTokens,
          promptTokens: r.promptTokens,
          completionTokens: r.completionTokens,
          sample: r.content.slice(0, 240).replace(/\s+/g, " "),
          ok: r.ok,
          error: r.error,
        });
      }

    /* ── Step 3: Always unload model to free VRAM ── */
    } finally {
      await lmsUnloadAllInstancesForModel(lmsUrl, modelKey, log, instanceId ? [instanceId] : [], transport);
      opts.onProgress?.({ type: "olympics.model.unloaded", model: modelKey });
      await new Promise((res) => setTimeout(res, 1500));
    }
  }

  if (skippedModels > 0) {
    log("warn", `skipped ${skippedModels} models due to load failures`);
  }

  /* ── Build discipline results with pairwise matches ── */
  const results: OlympicsDisciplineResult[] = [];
  for (const d of disciplines) {
    const perModel = disciplineResults.get(d.id) ?? [];

    const matches: OlympicsMatchResult[] = [];
    for (let i = 0; i < perModel.length; i++) {
      for (let j = i + 1; j < perModel.length; j++) {
        const A = perModel[i];
        const B = perModel[j];
        const draw = Math.abs(A.score - B.score) < 0.05;
        const winner = draw ? null : A.score > B.score ? A.model : B.model;
        matches.push({
          discipline: d.id, modelA: A.model, modelB: B.model,
          scoreA: A.score, scoreB: B.score, winner, draw,
        });
      }
    }

    const sorted = [...perModel].sort((a, b) => {
      if (Math.abs(a.score - b.score) > 0.05) return b.score - a.score;
      return a.durationMs - b.durationMs;
    });
    const champion = sorted[0] && sorted[0].score > 0 ? sorted[0].model : null;

    const championScore = sorted[0]?.score ?? 0;
    let optimum: string | null = null;
    if (championScore > 0) {
      const acceptable = perModel.filter((p) => p.ok && p.score >= championScore * 0.7);
      const byEff = [...acceptable].sort((a, b) => b.efficiency - a.efficiency);
      optimum = byEff[0]?.model ?? null;
    }

    results.push({
      discipline: d.id, role: d.role, description: d.description,
      perModel, matches, champion, optimum,
      thinkingFriendly: d.thinkingFriendly === true,
    });
    opts.onProgress?.({ type: "olympics.discipline.done", discipline: d.id, champion });
  }

  /* Медальный зачёт. */
  const stats = new Map<string, { gold: number; silver: number; bronze: number; totalScore: number; totalDurationMs: number }>();
  const ensure = (m: string) => {
    if (!stats.has(m)) stats.set(m, { gold: 0, silver: 0, bronze: 0, totalScore: 0, totalDurationMs: 0 });
    return stats.get(m)!;
  };
  for (const r of results) {
    const sorted = [...r.perModel].sort((a, b) => {
      if (Math.abs(a.score - b.score) > 0.05) return b.score - a.score;
      return a.durationMs - b.durationMs;
    });
    if (sorted[0]) ensure(sorted[0].model).gold++;
    if (sorted[1]) ensure(sorted[1].model).silver++;
    if (sorted[2]) ensure(sorted[2].model).bronze++;
    for (const p of r.perModel) {
      const s = ensure(p.model);
      s.totalScore += p.score;
      s.totalDurationMs += p.durationMs;
    }
  }
  const medals: OlympicsMedalRow[] = [...stats.entries()]
    .map(([model, s]) => ({ model, ...s }))
    .sort((a, b) => {
      if (a.gold !== b.gold) return b.gold - a.gold;
      if (a.silver !== b.silver) return b.silver - a.silver;
      if (a.bronze !== b.bronze) return b.bronze - a.bronze;
      return b.totalScore - a.totalScore;
    });

  /* Bradley-Terry MLE across ALL matches for global ranking (am-ELO, ICML 2025). */
  const allMatches = results.flatMap((r) => r.matches);
  const btScores = bradleyTerryMLE(allMatches, models);

  /* ── Per-role aggregation (am-ELO architecture) ──
     For each model, average results across all disciplines of a role.
     btScores переданы явно — используются как тайbreaker при одинаковом
     avgScore, чтобы порядок в списке совпадал с реальным турнирным рейтингом. */
  const roleAggregates = buildRoleAggregates(results, btScores);

  const recommendations: Record<string, string> = {};
  const recommendationsByScore: Record<string, string> = {};
  const roleReasons: OlympicsRoleReason[] = [];

  for (const agg of roleAggregates) {
    if (agg.optimum)  recommendations[agg.prefKey]        = agg.optimum;
    if (agg.champion) recommendationsByScore[agg.prefKey] = agg.champion;

    const reason: OlympicsRoleReason = { prefKey: agg.prefKey };
    if (agg.optimum) {
      const stats = agg.perModel.find((p) => p.model === agg.optimum);
      reason.optimumModel = agg.optimum;
      reason.optimumScore = stats?.avgScore;
      reason.optimumReason = agg.optimumReason ?? undefined;
      reason.optimumDiscipline = agg.disciplines.join(" + ");
    }
    if (agg.champion) {
      const stats = agg.perModel.find((p) => p.model === agg.champion);
      reason.championModel = agg.champion;
      reason.championScore = stats?.avgScore;
      reason.championReason = agg.championReason ?? undefined;
      reason.championDiscipline = agg.disciplines.join(" + ");
    }
    roleReasons.push(reason);
  }

  /* Предупреждения — показываются в UI. */
  const warnings: string[] = [];
  if (models.length === 1)        warnings.push("few_models_1");
  else if (models.length === 2)   warnings.push("few_models_2");
  else if (models.length === 3)   warnings.push("few_models_3");

  if (allModelInfos.length < 4) warnings.push("recommend_download");

  /* Дисциплины где все модели провалились. */
  for (const r of results) {
    if (!r.champion && !r.optimum) {
      warnings.push(`all_failed:${r.discipline}`);
    }
  }

  /* Роли без рекомендации — отдельно. */
  for (const agg of roleAggregates) {
    if (!agg.champion && !agg.optimum) {
      warnings.push(`role_no_winner:${agg.role}`);
    }
  }

  const totalDurationMs = Date.now() - t0;

  log("info", `Olympics finished in ${(totalDurationMs / 1000).toFixed(1)}s`, {
    modelsRun: models.length - skippedModels,
    skippedModels,
    disciplineCount: results.length,
    goldWinners: medals.filter((m) => m.gold > 0).map((m) => m.model),
  });
  telemetry.logEvent({
    type: "olympics.run",
    phase: "done",
    models,
    disciplines: disciplines.map((d) => d.id),
    durationMs: totalDurationMs,
    skippedModels,
  });

  opts.onProgress?.({ type: "olympics.done", durationMs: totalDurationMs });

  const modelCapabilities: Record<string, OlympicsModelCapabilities> = {};
  for (const info of selectedInfos) {
    modelCapabilities[info.key] = {
      vision: info.capabilities.vision,
      reasoning: !!info.capabilities.reasoning,
      toolUse: info.capabilities.trained_for_tool_use,
      architecture: info.architecture,
      paramsString: info.paramsString,
      sizeBytes: info.sizeBytes,
      maxContextLength: info.maxContextLength,
      format: info.format,
      loaded: info.loadedInstances.length > 0,
    };
  }

  const report: OlympicsReport = {
    generatedAt: new Date().toISOString(),
    lmsUrl,
    models,
    modelWeightClass,
    modelCapabilities,
    disciplines: results,
    roleAggregates,
    medals,
    btScores: Object.fromEntries(btScores),
    recommendations,
    recommendationsByScore,
    roleReasons,
    warnings,
    availableModelCount: allModelInfos.length,
    disciplineCount: results.length,
    totalDurationMs,
  };

  /* ── EcoTune-style auto-tune (EMNLP 2025) ──
   * Deterministic analysis of Olympics results → per-role inference param
   * suggestions. No LLM required (arXiv 2603.24647: classical CMA-ES + 0.8B
   * beats pure LLM). We use observed scores/tokens/durations to compute
   * optimal temperature, top_p, max_tokens per role. */
  try {
    const { computeAutoTuneSuggestions } = await import("./olympics-auto-tune.js");
    report.autoTuneSuggestions = computeAutoTuneSuggestions(report);
    if (report.autoTuneSuggestions.length > 0) {
      log("info", `EcoTune: ${report.autoTuneSuggestions.length} role tune suggestions`, {
        suggestions: report.autoTuneSuggestions.map((s) => ({
          role: s.role, temp: s.suggestedTemperature, maxTok: s.suggestedMaxTokens, conf: s.confidence,
        })),
      });
    }
  } catch (err) {
    log("warn", "EcoTune auto-tune failed (non-fatal)", { error: err instanceof Error ? err.message : String(err) });
  }

  /* Attach probe + adaptive elimination stats for transparency. */
  if (probeScores.size > 0) {
    report.probeStats = {
      totalProbed: probeScores.size,
      eliminated: probeScores.size - models.length,
      cutoff: PROBE_CUTOFF,
      scores: Object.fromEntries(probeScores),
    };
  }
  if (adaptiveSkips.count > 0) {
    report.adaptiveElimination = { skippedDisciplines: adaptiveSkips.count };
  }

  _olympicsCache = { key: cacheKey, report };
  return report;
}
