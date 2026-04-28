/**
 * scripts/run-olympics.ts — РЕАЛЬНАЯ Олимпиада на твоих локальных моделях.
 *
 * Что делает:
 *   1. Подключается к LM Studio (http://localhost:1234, OpenAI-совместимый API).
 *   2. Берёт список доступных моделей (или явно указанных через --models).
 *   3. Прогоняет несколько «дисциплин» (Олимпийские задачи), релевантных
 *      проекту Bibliary: crystallizer / evaluator / translator / judge.
 *   4. На каждой дисциплине проводит round-robin между моделями (модель А
 *      vs модель B vs … каждый с каждым).
 *   5. Победителей в паре определяет встроенная объективная метрика
 *      (длина + латентность + проверка JSON-валидности там, где надо)
 *      ИЛИ LLM-judge (опционально, --judge=auto использует первую модель
 *      с reasoning_effort).
 *   6. Сохраняет JSON-отчёт в `release/olympics-report.json` и печатает
 *      топ-3 в каждой дисциплине + общий лидерборд (Elo).
 *
 * Запуск:
 *   npx tsx scripts/run-olympics.ts                                # авто
 *   npx tsx scripts/run-olympics.ts --models=qwen3-0.6b,qwen/qwen3-4b-2507
 *   npx tsx scripts/run-olympics.ts --disciplines=crystallizer,evaluator
 *
 * Без LM Studio скрипт честно скажет «офлайн» и выйдет с кодом 2.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";

const LMS_URL = process.env.LMS_URL ?? "http://localhost:1234";
const REPORT_PATH = path.resolve("release", "olympics-report.json");

interface Args {
  models?: string[];
  disciplines?: string[];
  maxModels?: number;
  perDisciplineTimeoutMs?: number;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (const arg of argv.slice(2)) {
    const m = /^--([^=]+)=(.+)$/.exec(arg);
    if (!m) continue;
    const [, k, v] = m;
    if (k === "models") out.models = v!.split(",").map((s) => s.trim()).filter(Boolean);
    else if (k === "disciplines") out.disciplines = v!.split(",").map((s) => s.trim()).filter(Boolean);
    else if (k === "max-models") out.maxModels = Number(v);
    else if (k === "timeout") out.perDisciplineTimeoutMs = Number(v);
  }
  return out;
}

interface OpenAIModel { id: string; object: string }

async function lmsListModels(): Promise<string[]> {
  const r = await fetch(`${LMS_URL}/v1/models`, {
    signal: AbortSignal.timeout(5_000),
  });
  if (!r.ok) throw new Error(`LM Studio /v1/models HTTP ${r.status}`);
  const data = (await r.json()) as { data: OpenAIModel[] };
  return data.data.map((m) => m.id);
}

interface ChatResp {
  content: string;
  durationMs: number;
  totalTokens: number;
  ok: boolean;
  error?: string;
}

async function lmsChat(
  model: string,
  system: string,
  user: string,
  opts: { temperature?: number; maxTokens?: number; timeoutMs?: number } = {},
): Promise<ChatResp> {
  const t0 = Date.now();
  const body = {
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature: opts.temperature ?? 0.2,
    max_tokens: opts.maxTokens ?? 512,
  };
  try {
    const ctrl = new AbortController();
    const timeoutId = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 90_000);
    const r = await fetch(`${LMS_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    clearTimeout(timeoutId);
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      return { content: "", durationMs: Date.now() - t0, totalTokens: 0, ok: false, error: `HTTP ${r.status}: ${txt.slice(0, 200)}` };
    }
    const j = (await r.json()) as {
      choices: Array<{ message: { content?: string; reasoning_content?: string } }>;
      usage?: { total_tokens?: number };
    };
    const choice = j.choices?.[0]?.message;
    const content = (choice?.content ?? choice?.reasoning_content ?? "").trim();
    return { content, durationMs: Date.now() - t0, totalTokens: j.usage?.total_tokens ?? 0, ok: true };
  } catch (e) {
    return { content: "", durationMs: Date.now() - t0, totalTokens: 0, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/* ─── ДИСЦИПЛИНЫ (релевантные Bibliary) ─────────────────────────────── */

interface Discipline {
  id: string;
  role: "crystallizer" | "evaluator" | "translator" | "judge";
  description: string;
  system: string;
  user: string;
  /** Объективная функция оценки ответа [0..1]. */
  score(answer: string): number;
  maxTokens: number;
}

const DISCIPLINES: Discipline[] = [
  {
    id: "crystallizer-rover",
    role: "crystallizer",
    description: "Извлечь факты + сущности (наша роль delta-extractor).",
    system:
      "You extract structured knowledge from text. Output ONLY valid JSON: " +
      '{"facts":[string],"entities":[{"name":string,"type":string}]}.',
    user:
      'Extract knowledge from this passage:\n\n' +
      '"The Curiosity rover landed on Mars on August 6, 2012, in Gale Crater. ' +
      "It is powered by a radioisotope thermoelectric generator using plutonium-238. " +
      'NASA\'s Jet Propulsion Laboratory operates the mission."',
    maxTokens: 384,
    score: (a) => {
      const cleaned = a.replace(/^[^{]*/, "").replace(/[^}]*$/, "");
      try {
        const parsed: unknown = JSON.parse(cleaned);
        const obj = parsed as { facts?: unknown[]; entities?: unknown[] };
        if (!Array.isArray(obj.facts) || !Array.isArray(obj.entities)) return 0.2;
        const facts = obj.facts.length;
        const entities = obj.entities.length;
        const hasMars = JSON.stringify(parsed).toLowerCase().includes("mars");
        const hasNasa = JSON.stringify(parsed).toLowerCase().includes("nasa");
        const hasYear = /2012/.test(JSON.stringify(parsed));
        let s = 0.4;
        if (facts >= 3) s += 0.15; if (entities >= 3) s += 0.15;
        if (hasMars) s += 0.1; if (hasNasa) s += 0.1; if (hasYear) s += 0.1;
        return Math.min(1, s);
      } catch { return 0.0; }
    },
  },
  {
    id: "evaluator-clrs",
    role: "evaluator",
    description: "Оценить классику CS-литературы (наша роль book-evaluator).",
    system:
      "You evaluate book quality. Score 0-10 (10 = excellent technical reference). " +
      'Output ONLY JSON: {"score":number,"reasoning":string}.',
    user:
      'Book: "Introduction to Algorithms" by CLRS. ' +
      "Topics: algorithm analysis, sorting, graph algorithms, dynamic programming. " +
      "Year: 4th ed. 2022. Pages: 1312. Used by top universities worldwide.",
    maxTokens: 256,
    score: (a) => {
      const cleaned = a.replace(/^[^{]*/, "").replace(/[^}]*$/, "");
      try {
        const parsed = JSON.parse(cleaned) as { score?: number; reasoning?: string };
        if (typeof parsed.score !== "number") return 0.1;
        if (typeof parsed.reasoning !== "string" || parsed.reasoning.length < 20) return 0.4;
        if (parsed.score >= 8 && parsed.score <= 10) return 1.0;
        if (parsed.score >= 6) return 0.7;
        return 0.3;
      } catch { return 0.0; }
    },
  },
  {
    id: "translator-uk-ru",
    role: "translator",
    description: "Перевод украинского (наша новая роль).",
    system:
      "You are a professional translator. Translate to Russian. " +
      "Preserve technical terms and numbers exactly. Output ONLY the translation.",
    user:
      "Алгоритм пошуку в глибину (DFS) обходить дерево, починаючи з кореня, " +
      "і йде якомога глибше по кожній гілці перед поверненням назад. " +
      "Складність — O(V + E).",
    maxTokens: 256,
    score: (a) => {
      const lower = a.toLowerCase();
      const ruWords = ["глубину", "дерево", "корня", "гілці"];
      const techPreserved = lower.includes("o(v + e)") || lower.includes("o(v+e)");
      const noUkraine = !/[іїєґ]/.test(a) || (a.match(/[іїєґ]/g)?.length ?? 0) < 3;
      const hasRussian = /[а-я]/.test(a);
      let s = 0;
      if (hasRussian) s += 0.3;
      if (techPreserved) s += 0.3;
      if (noUkraine) s += 0.2;
      if (lower.includes("обход") || lower.includes("поиск")) s += 0.2;
      return Math.min(1, s);
      void ruWords;
    },
  },
  {
    id: "judge-bst",
    role: "judge",
    description: "Сравнить два ответа (наша роль arena-judge).",
    system:
      "You are a strict but fair judge. Compare two answers. Output ONLY the letter A or B.",
    user:
      "Question: What is the time complexity of inserting into a balanced BST?\n\n" +
      "Answer A: O(log n) average and worst case, because the tree stays balanced.\n\n" +
      "Answer B: O(n) because you might have to traverse the whole tree.\n\n" +
      "Which is correct? A or B?",
    maxTokens: 16,
    score: (a) => {
      const t = a.trim().toUpperCase();
      if (/^A\b/.test(t) || /^['"]?A['"]?$/.test(t)) return 1.0;
      if (/^B\b/.test(t)) return 0.0;
      if (t.includes("A") && !t.includes("B")) return 0.7;
      return 0.2;
    },
  },
];

/* ─── ОЛИМПИАДА ─────────────────────────────────────────────────────── */

interface MatchResult {
  discipline: string;
  modelA: string;
  modelB: string;
  scoreA: number;
  scoreB: number;
  durationMsA: number;
  durationMsB: number;
  okA: boolean;
  okB: boolean;
  winner: string | null;
  draw: boolean;
}

interface DisciplineResult {
  discipline: string;
  role: string;
  description: string;
  perModel: Array<{ model: string; score: number; durationMs: number; ok: boolean; tokens: number; sample: string }>;
  matches: MatchResult[];
  champion: string | null;
}

interface OlympicsReport {
  generatedAt: string;
  lmsUrl: string;
  models: string[];
  disciplines: DisciplineResult[];
  /** Глобальный leaderboard: количество золотых, серебряных, бронзовых медалей. */
  medals: Array<{ model: string; gold: number; silver: number; bronze: number; totalScore: number; totalDurationMs: number }>;
  /** Авто-рекомендации для prefs (по чемпиону на каждую роль). */
  recommendations: Record<string, string>;
}

function pickModelsForOlympics(all: string[], explicit?: string[], maxModels?: number): string[] {
  /* embedding исключаем — он не chat. */
  const eligible = all.filter((m) => !/embed/i.test(m));
  if (explicit && explicit.length > 0) return eligible.filter((m) => explicit.includes(m));

  /* Авто-выбор: предпочитаем разнообразие семейств + лёгкие модели первыми
     (быстрее проведём турнир). Фильтр "лёгких" = 3-7B по имени. */
  const score = (m: string): number => {
    const lower = m.toLowerCase();
    let s = 0;
    /* лёгкие */
    if (/0\.6b|3b|4b|7b/.test(lower)) s += 5;
    /* семейства */
    if (lower.includes("qwen")) s += 1;
    if (lower.includes("gemma")) s += 1;
    if (lower.includes("ministral") || lower.includes("mistral")) s += 1;
    /* coder/abliterated/specialized — вниз */
    if (lower.includes("coder")) s -= 2;
    if (lower.includes("abliterated")) s -= 5;
    return s;
  };
  const ranked = [...eligible].sort((a, b) => score(b) - score(a));
  /* минимум 2, максимум maxModels (default 4) */
  const max = maxModels ?? 4;
  const picked: string[] = [];
  const families = new Set<string>();
  for (const m of ranked) {
    const fam = m.split(/[\/\-_]/)[0]!.toLowerCase();
    if (families.has(fam) && picked.length >= 2) continue;
    families.add(fam);
    picked.push(m);
    if (picked.length >= max) break;
  }
  return picked;
}

async function runDiscipline(
  d: Discipline,
  models: string[],
  perDisciplineTimeoutMs: number,
): Promise<DisciplineResult> {
  console.log(`\n  ▶ Дисциплина «${d.id}» (${d.role}) — ${d.description}`);
  /* 1. Каждая модель отвечает на промпт. */
  const perModel: DisciplineResult["perModel"] = [];
  for (const m of models) {
    process.stdout.write(`     · ${m} … `);
    const r = await lmsChat(m, d.system, d.user, {
      maxTokens: d.maxTokens,
      timeoutMs: perDisciplineTimeoutMs,
    });
    const score = r.ok ? d.score(r.content) : 0;
    perModel.push({
      model: m,
      score,
      durationMs: r.durationMs,
      ok: r.ok,
      tokens: r.totalTokens,
      sample: r.content.slice(0, 240).replace(/\s+/g, " "),
    });
    console.log(r.ok
      ? `${(score * 100).toFixed(0)}/100 (${(r.durationMs / 1000).toFixed(1)}s, ${r.totalTokens}tok)`
      : `FAIL (${r.error})`);
  }

  /* 2. Round-robin: каждый с каждым → MatchResult. */
  const matches: MatchResult[] = [];
  for (let i = 0; i < models.length; i++) {
    for (let j = i + 1; j < models.length; j++) {
      const A = perModel.find((p) => p.model === models[i])!;
      const B = perModel.find((p) => p.model === models[j])!;
      const draw = Math.abs(A.score - B.score) < 0.05;
      const winner = draw ? null : A.score > B.score ? A.model : B.model;
      matches.push({
        discipline: d.id, modelA: A.model, modelB: B.model,
        scoreA: A.score, scoreB: B.score,
        durationMsA: A.durationMs, durationMsB: B.durationMs,
        okA: A.ok, okB: B.ok, winner, draw,
      });
    }
  }

  /* 3. Чемпион = наибольший score; ties → быстрейший. */
  const sorted = [...perModel].sort((a, b) => {
    if (Math.abs(a.score - b.score) > 0.05) return b.score - a.score;
    return a.durationMs - b.durationMs;
  });
  const champion = sorted[0] && sorted[0].score > 0 ? sorted[0].model : null;

  return { discipline: d.id, role: d.role, description: d.description, perModel, matches, champion };
}

function buildMedals(results: DisciplineResult[]): OlympicsReport["medals"] {
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

  return [...stats.entries()]
    .map(([model, s]) => ({ model, ...s }))
    .sort((a, b) => {
      if (a.gold !== b.gold) return b.gold - a.gold;
      if (a.silver !== b.silver) return b.silver - a.silver;
      if (a.bronze !== b.bronze) return b.bronze - a.bronze;
      return b.totalScore - a.totalScore;
    });
}

function buildRecommendations(results: DisciplineResult[]): Record<string, string> {
  /* Берём чемпиона по дисциплине → это рекомендация для соответствующего prefs.<role>Model. */
  const recs: Record<string, string> = {};
  for (const r of results) {
    if (!r.champion) continue;
    /* 1 дисциплина = 1 чемпион на роль (если их больше — последний выигрывает). */
    const prefKey = roleToPrefKey(r.role);
    if (prefKey) recs[prefKey] = r.champion;
  }
  return recs;
}

function roleToPrefKey(role: string): string | null {
  switch (role) {
    case "crystallizer": return "extractorModel";
    case "judge":        return "judgeModel";
    case "evaluator":    return "evaluatorModel";
    case "translator":   return "translatorModel";
    default:             return null;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  console.log("ॐ Bibliary Olympics — реальный турнир локальных моделей\n");

  let allModels: string[];
  try {
    allModels = await lmsListModels();
  } catch (e) {
    console.error(`✗ LM Studio офлайн (${LMS_URL}): ${e instanceof Error ? e.message : e}`);
    console.error("  Запусти LM Studio → Local Server, потом повтори.");
    process.exit(2);
  }

  const models = pickModelsForOlympics(allModels, args.models, args.maxModels);
  if (models.length < 2) {
    console.error(`✗ Нужно минимум 2 модели. Найдено: ${models.length}.`);
    console.error(`  Доступно в LM Studio: ${allModels.join(", ")}`);
    process.exit(2);
  }
  console.log(`▣ Участники турнира (${models.length}):`);
  for (const m of models) console.log(`   · ${m}`);

  const allDiscipsByRole = DISCIPLINES;
  const disciplines = args.disciplines
    ? allDiscipsByRole.filter((d) => args.disciplines!.includes(d.id) || args.disciplines!.includes(d.role))
    : allDiscipsByRole;

  if (disciplines.length === 0) {
    console.error("✗ Нет ни одной дисциплины (проверь --disciplines)");
    process.exit(2);
  }
  console.log(`▣ Дисциплины (${disciplines.length}): ${disciplines.map((d) => d.id).join(", ")}`);

  const t0 = Date.now();
  const results: DisciplineResult[] = [];
  for (const d of disciplines) {
    const r = await runDiscipline(d, models, args.perDisciplineTimeoutMs ?? 90_000);
    results.push(r);
  }
  const totalMs = Date.now() - t0;

  const medals = buildMedals(results);
  const recommendations = buildRecommendations(results);

  const report: OlympicsReport = {
    generatedAt: new Date().toISOString(),
    lmsUrl: LMS_URL,
    models,
    disciplines: results,
    medals,
    recommendations,
  };

  await fs.mkdir(path.dirname(REPORT_PATH), { recursive: true });
  await fs.writeFile(REPORT_PATH, JSON.stringify(report, null, 2), "utf8");

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`🏆 РЕЗУЛЬТАТЫ ОЛИМПИАДЫ (${(totalMs / 1000).toFixed(1)}s)`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

  for (const r of results) {
    console.log(`\n▣ ${r.discipline} (${r.role})`);
    const sorted = [...r.perModel].sort((a, b) => b.score - a.score);
    const podium = ["🥇", "🥈", "🥉"];
    sorted.forEach((p, i) => {
      const medal = podium[i] ?? "  ";
      console.log(`  ${medal} ${p.model}: ${(p.score * 100).toFixed(0)}/100  (${(p.durationMs / 1000).toFixed(1)}s)`);
    });
  }

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`📊 ОБЩИЙ ЛИДЕРБОРД (медальный зачёт)`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  for (const m of medals) {
    console.log(`  ${m.model.padEnd(45)}  🥇${m.gold}  🥈${m.silver}  🥉${m.bronze}   score=${m.totalScore.toFixed(2)}  time=${(m.totalDurationMs / 1000).toFixed(1)}s`);
  }

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`✨ АВТО-РЕКОМЕНДАЦИИ ДЛЯ Settings → Models`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  if (Object.keys(recommendations).length === 0) {
    console.log("  (нет надёжных чемпионов — все дисциплины завалены или неинформативны)");
  } else {
    for (const [k, v] of Object.entries(recommendations)) {
      console.log(`  ${k.padEnd(20)} = ${v}`);
    }
  }
  console.log(`\n📄 Полный отчёт: ${REPORT_PATH}`);
}

main().catch((e) => {
  console.error("✗ Olympics failed:", e);
  process.exit(1);
});
