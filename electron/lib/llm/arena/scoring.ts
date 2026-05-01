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
 */

import type {
  OlympicsRole,
  OlympicsMatchResult,
  OlympicsDisciplineResult,
  OlympicsRoleAggregate,
} from "./olympics.js";

function roleToPrefKey(role: OlympicsRole): string | null {
  switch (role) {
    case "crystallizer":         return "extractorModel";
    case "vision_meta":          return "visionModelKey";
    case "vision_ocr":           return "visionModelKey";
    case "vision_illustration":  return "visionModelKey";
    case "evaluator":            return "evaluatorModel";
    case "translator":           return "translatorModel";
    case "lang_detector":        return "langDetectorModel";
    case "ukrainian_specialist": return "ukrainianSpecialistModel";
    case "vision":               return "visionModelKey";
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
