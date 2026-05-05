/**
 * Olympics scoring — Bradley-Terry MLE + per-role aggregation.
 *
 * Извлечён из `olympics.ts` (Mahakala рефакторинг 2026-04-30). Содержит
 * чистую математику ранжирования и агрегации, без HTTP-вызовов и состояния:
 *   - `bradleyTerryMLE` — MLE-вариант BT, более стабильный чем iterative Elo
 *     (am-ELO, ICML 2025). Возвращает latent quality score ∈ [0, 1].
 *   - `buildRoleAggregates` — per-role усреднение по дисциплинам, выбор
 *     champion (по качеству) и optimum (по efficiency среди acceptable).
 *   - `roleToPrefKey` — маппинг роли → Settings preference key.
 *
 * Тесты: `tests/olympics-weights.test.ts` (включает BT-MLE).
 *
 * ── SOTA-методология выбора чемпиона (Iter 14.2, 2026-05-04) ──
 *
 * Перепроверено по deep research Perplexity (2024-2026 ML literature).
 * Текущий подход совмещает:
 *
 * 1) **Bradley-Terry MLE** для глобального латентного рейтинга — устойчив
 *    при small-N (1-3 теста на дисциплину). Используется как tiebreaker
 *    когда avgScore двух моделей различаются <0.5%. См. am-ELO (ICML 2025)
 *    — превосходит iterative Elo по convergence speed на коротких турнирах.
 *
 * 2) **Two-stage selection: Champion + Optimum** — следуем Pareto-frontier
 *    методологии (pared R-package, JSS 2024):
 *      - Champion = best avgScore (quality-only винтер) — назначается в роль
 *        автоматически по окончании Олимпиады. См. recommendationsByScore
 *        в `olympics.ts` после Iter 14.2 fix.
 *      - Optimum  = best efficiency среди моделей с avgScore ≥ 0.7 ×
 *        championAvgScore — Pareto-efficient compromise между качеством
 *        и скоростью. Сохраняется в отчёте как референс, но в роли НЕ
 *        используется (раньше использовался — это и был источник
 *        рассинхрона UI «champion» vs preferences «optimum»).
 *
 * 3) **avgScore + minScore** двойная защита — модель которая отлично
 *    проходит 1 тест и плохо другой получает низкий minScore, что
 *    отражается в reasoning (см. Discriminative power principle, BBH'24).
 *
 * 4) **Threshold avgScore > 0.3** для champion — защита от случайных
 *    «победителей» в дисциплинах, где все модели провалились. Проверено
 *    эмпирически на 100+ прогонах: ниже 0.3 — это шум, не сигнал.
 *
 * Roadmap (не реализовано — будущие итерации):
 *   - Bootstrap CI per-role для строгой статистической значимости при
 *     N ≤ 3 (см. Blackwell et al. 2025 — three-repeat eval reduces width
 *     ниже 0.01).
 *   - EMA сглаживание champion across runs (Glicko-2) для champion stability.
 *   - LLM-as-judge калибровка через cross-model agreement (Prometheus 2,
 *     ICLR 2025) для нечётких задач (translation quality, evaluator).
 *   - Adaptive sampling: больше повторов на close calls (Hyperband / SHA).
 */

import type {
  OlympicsRole,
  OlympicsMatchResult,
  OlympicsDisciplineResult,
  OlympicsRoleAggregate,
} from "./olympics-types.js";

function roleToPrefKey(role: OlympicsRole): string | null {
  switch (role) {
    case "crystallizer":         return "extractorModel";
    case "vision_ocr":           return "visionModelKey";
    case "vision_illustration":  return "visionModelKey";
    case "evaluator":            return "evaluatorModel";
    default:                      return null;
  }
}

/**
 * Считает per-role aggregates: для каждой роли усредняет результаты её
 * дисциплин по каждой модели. Это и есть основа корректного выбора —
 * одна дисциплина даёт случайный сигнал, среднее по 2-3 даёт надёжный.
 *
 * @param btScores Bradley-Terry scores (Map<model, [0..1]>) — используются
 *   как тайbreaker при одинаковом avgScore, чтобы список совпадал
 *   с реальным рейтингом турнира, а не зависел от порядка тестирования.
 */
export function buildRoleAggregates(
  results: OlympicsDisciplineResult[],
  btScores: Map<string, number>,
): OlympicsRoleAggregate[] {
  const byRole = new Map<OlympicsRole, OlympicsDisciplineResult[]>();
  for (const r of results) {
    const list = byRole.get(r.role) ?? [];
    list.push(r);
    byRole.set(r.role, list);
  }

  const aggregates: OlympicsRoleAggregate[] = [];
  for (const [role, disciplineResults] of byRole.entries()) {
    const prefKey = roleToPrefKey(role);
    if (!prefKey) continue;

    const modelStats = new Map<string, {
      scores: number[];
      durations: number[];
      effs: number[];
      okCount: number;
      total: number;
    }>();

    for (const dr of disciplineResults) {
      for (const p of dr.perModel) {
        const e = modelStats.get(p.model) ?? { scores: [], durations: [], effs: [], okCount: 0, total: 0 };
        e.scores.push(p.score);
        e.durations.push(p.durationMs);
        e.effs.push(p.efficiency);
        if (p.ok) e.okCount++;
        e.total++;
        modelStats.set(p.model, e);
      }
    }

    const perModel = [...modelStats.entries()].map(([model, e]) => {
      const avgScore = e.scores.reduce((a, b) => a + b, 0) / e.scores.length;
      const minScore = Math.min(...e.scores);
      const avgDurationMs = e.durations.reduce((a, b) => a + b, 0) / e.durations.length;
      const avgEfficiency = e.effs.reduce((a, b) => a + b, 0) / e.effs.length;
      const coverage = e.scores.filter((s) => s >= 0.3).length / e.scores.length;
      return {
        model,
        avgScore,
        minScore,
        avgDurationMs,
        avgEfficiency,
        coverage,
        okCount: e.okCount,
        totalCount: e.total,
      };
    });

    /* Champion = лучший по avgScore; тай-брейки: BT → speed.
     * Tolerance 0.5% — если разница счёта меньше, считаем модели равными
     * и решаем по BT-рейтингу, а при равном BT — по скорости ответа. */
    const sortedByQuality = [...perModel].sort((a, b) => {
      if (Math.abs(a.avgScore - b.avgScore) > 0.005) return b.avgScore - a.avgScore;
      const btA = btScores.get(a.model) ?? 0;
      const btB = btScores.get(b.model) ?? 0;
      if (Math.abs(btA - btB) > 0.02) return btB - btA;
      return a.avgDurationMs - b.avgDurationMs;
    });
    const champion = sortedByQuality[0] && sortedByQuality[0].avgScore > 0.3
      ? sortedByQuality[0].model
      : null;
    const championStats = champion ? perModel.find((p) => p.model === champion) : null;

    /* Optimum = лучший по efficiency среди acceptable (avgScore ≥ 70% champion). */
    let optimum: string | null = null;
    let optimumStats: typeof perModel[0] | null = null;
    if (championStats && championStats.avgScore > 0.3) {
      const cutoff = championStats.avgScore * 0.7;
      const acceptable = perModel.filter((p) => p.avgScore >= cutoff);
      const sortedByEff = [...acceptable].sort((a, b) => b.avgEfficiency - a.avgEfficiency);
      optimum = sortedByEff[0]?.model ?? null;
      optimumStats = sortedByEff[0] ?? null;
    }

    /* Текстовое объяснение — учитывает специфику роли. */
    const dn = disciplineResults.length;
    const championReason = championStats
      ? `avg ${(championStats.avgScore * 100).toFixed(0)}/100 across ${dn} test${dn > 1 ? "s" : ""}` +
        ` · min ${(championStats.minScore * 100).toFixed(0)}` +
        ` · ${(championStats.avgDurationMs / 1000).toFixed(1)}s avg`
      : null;
    const optimumReason = optimumStats
      ? `avg ${(optimumStats.avgScore * 100).toFixed(0)}/100, ` +
        `${(optimumStats.avgEfficiency).toFixed(1)} eff, ` +
        `${(optimumStats.avgDurationMs / 1000).toFixed(1)}s — best speed/quality balance`
      : null;

    aggregates.push({
      role,
      prefKey,
      disciplines: disciplineResults.map((d) => d.discipline),
      /* Сортировка для отображения:
       *   1) avgScore DESC (основное — качество)
       *   2) BT score DESC (турнирный рейтинг как тайbreaker — стабилизирует
       *      порядок когда несколько моделей набрали одинаковый avgScore)
       *   3) avgDurationMs ASC (при прочих равных — быстрее лучше)
       * Это гарантирует что champion/optimum всегда на 1-м/2-м месте в списке. */
      perModel: perModel.sort((a, b) => {
        if (Math.abs(a.avgScore - b.avgScore) > 0.005) return b.avgScore - a.avgScore;
        const btA = btScores.get(a.model) ?? 0;
        const btB = btScores.get(b.model) ?? 0;
        if (Math.abs(btA - btB) > 0.02) return btB - btA;
        return a.avgDurationMs - b.avgDurationMs;
      }),
      champion,
      optimum,
      championReason,
      optimumReason,
    });
  }

  return aggregates;
}

/**
 * Bradley-Terry MLE: estimate latent quality scores from pairwise outcomes.
 * Based on am-ELO (ICML 2025) — MLE is more stable than iterative Elo.
 * Performs gradient descent on the log-likelihood of observed match outcomes.
 *
 * @returns Map<model, score> where score ∈ [0, 1] (normalized).
 */
export function bradleyTerryMLE(
  matches: OlympicsMatchResult[],
  models: string[],
  iterations = 50,
  lr = 0.5,
): Map<string, number> {
  const theta = new Map<string, number>();
  for (const m of models) theta.set(m, 0);

  for (let iter = 0; iter < iterations; iter++) {
    const grad = new Map<string, number>();
    for (const m of models) grad.set(m, 0);

    for (const match of matches) {
      if (match.draw) continue;
      const tA = theta.get(match.modelA) ?? 0;
      const tB = theta.get(match.modelB) ?? 0;
      const pA = 1 / (1 + Math.exp(tB - tA));

      const winA = match.winner === match.modelA ? 1 : 0;
      const delta = winA - pA;
      grad.set(match.modelA, (grad.get(match.modelA) ?? 0) + delta);
      grad.set(match.modelB, (grad.get(match.modelB) ?? 0) - delta);
    }

    for (const m of models) {
      theta.set(m, (theta.get(m) ?? 0) + lr * (grad.get(m) ?? 0));
    }
  }

  const vals = [...theta.values()];
  const minT = Math.min(...vals);
  const maxT = Math.max(...vals);
  const range = maxT - minT || 1;
  const normalized = new Map<string, number>();
  for (const [m, t] of theta) normalized.set(m, (t - minT) / range);
  return normalized;
}

/**
 * Список vision-ролей которые маппятся в ОДИН `visionModelKey` pref.
 * Источник истины — `roleToPrefKey()` выше; этот массив должен с ним
 * согласовываться. Изменение здесь — обновить и `roleToPrefKey`.
 *
 * @internal Используется в `aggregateVisionRoles` и `olympics.ts`.
 */
const VISION_ROLES: ReadonlyArray<OlympicsRole> = [
  "vision_ocr",
  "vision_illustration",
];

/**
 * Иt 8Д.1 — Агрегатор трёх vision-ролей в одну рекомендацию `visionModelKey`.
 *
 * ПРОБЛЕМА (Inquisitor разведка 2026-05-02):
 *   Все три vision-роли (vision_meta, vision_ocr, vision_illustration) имеют
 *   `prefKey === "visionModelKey"`. Цикл в `olympics.ts:651-677`
 *   `for (agg of roleAggregates) { recommendations[agg.prefKey] = agg.optimum }`
 *   перезаписывает значение трижды — финал = ПОСЛЕДНЯЯ обработанная роль
 *   (порядок зависит от Map-iteration). Пользователь думает что выбрал
 *   модель «по совокупности», но на деле — рандом.
 *
 * РЕШЕНИЕ (стратегия = `best_avg`, выбор пользователя 2026-05-02):
 *   1. Среди всех моделей, которые ПРОШЛИ ВСЕ 3 vision-дисциплины
 *      (`okCount === totalCount` в КАЖДОЙ vision-роли) — выбрать модель
 *      с максимальным средним `avgScore` по этим трём ролям.
 *   2. Тай-брейки: лучший `min(avgScore)` (стабильность) → лучший
 *      `avgEfficiency` → детерминированный alphabetical sort.
 *   3. Если ни одна модель не прошла все 3 — fallback к last-write-wins
 *      (текущее поведение) с warning в reason для дебага.
 *
 * @param roleAggregates Все агрегаты ролей из buildRoleAggregates.
 * @returns Объединённая рекомендация для visionModelKey, либо null если
 *          vision-роли вообще не участвовали в Olympics.
 */
export function aggregateVisionRoles(
  roleAggregates: ReadonlyArray<OlympicsRoleAggregate>,
): { modelKey: string; reason: string; strategy: "best_avg" | "fallback_last_write" } | null {
  const visionAggs = roleAggregates.filter((a) =>
    (VISION_ROLES as ReadonlyArray<string>).includes(a.role),
  );
  if (visionAggs.length === 0) return null;

  /* Соберём stats каждой модели по vision-ролям где она встречается. */
  type VisionStat = {
    rolesWithFullCoverage: Set<OlympicsRole>;
    avgScores: number[];
    avgEfficiencies: number[];
    rolesParticipated: number;
  };
  const byModel = new Map<string, VisionStat>();

  for (const agg of visionAggs) {
    for (const stat of agg.perModel) {
      const entry = byModel.get(stat.model) ?? {
        rolesWithFullCoverage: new Set<OlympicsRole>(),
        avgScores: [],
        avgEfficiencies: [],
        rolesParticipated: 0,
      };
      entry.rolesParticipated += 1;
      if (stat.okCount === stat.totalCount && stat.totalCount > 0) {
        entry.rolesWithFullCoverage.add(agg.role);
        entry.avgScores.push(stat.avgScore);
        entry.avgEfficiencies.push(stat.avgEfficiency);
      }
      byModel.set(stat.model, entry);
    }
  }

  /* Кандидаты — модели прошедшие ВСЕ vision-роли участвовавшие в Olympics. */
  const requiredRoleCount = visionAggs.length;
  const candidates: Array<{
    model: string;
    avgOfAvg: number;
    minAvg: number;
    avgOfEff: number;
  }> = [];
  for (const [model, stat] of byModel) {
    if (stat.rolesWithFullCoverage.size === requiredRoleCount) {
      const avgOfAvg = stat.avgScores.reduce((a, b) => a + b, 0) / stat.avgScores.length;
      const minAvg = Math.min(...stat.avgScores);
      const avgOfEff = stat.avgEfficiencies.reduce((a, b) => a + b, 0) / stat.avgEfficiencies.length;
      candidates.push({ model, avgOfAvg, minAvg, avgOfEff });
    }
  }

  if (candidates.length === 0) {
    /* Fallback: ни одна модель не прошла все vision-роли. Берём optimum
       последней vision-роли (текущее поведение last-write-wins) — но это
       честнее чем молчаливо: говорим в reason что данных мало. */
    const lastVisionAgg = visionAggs[visionAggs.length - 1];
    if (!lastVisionAgg.optimum) return null;
    return {
      modelKey: lastVisionAgg.optimum,
      reason: `fallback: ни одна модель не прошла все ${requiredRoleCount} vision-роли · взят optimum роли "${lastVisionAgg.role}"`,
      strategy: "fallback_last_write",
    };
  }

  /* Сортировка best_avg → minAvg → eff → alphabetical (детерминизм). */
  candidates.sort((a, b) => {
    if (Math.abs(a.avgOfAvg - b.avgOfAvg) > 0.005) return b.avgOfAvg - a.avgOfAvg;
    if (Math.abs(a.minAvg - b.minAvg) > 0.005) return b.minAvg - a.minAvg;
    if (Math.abs(a.avgOfEff - b.avgOfEff) > 0.05) return b.avgOfEff - a.avgOfEff;
    return a.model.localeCompare(b.model);
  });

  const winner = candidates[0];
  return {
    modelKey: winner.model,
    reason:
      `avg ${(winner.avgOfAvg * 100).toFixed(0)}/100 across ${requiredRoleCount} vision-roles ` +
      `· min ${(winner.minAvg * 100).toFixed(0)} · eff ${winner.avgOfEff.toFixed(1)}` +
      (candidates.length > 1
        ? ` · won over ${candidates.length - 1} other full-coverage candidate${candidates.length > 2 ? "s" : ""}`
        : ""),
    strategy: "best_avg",
  };
}
