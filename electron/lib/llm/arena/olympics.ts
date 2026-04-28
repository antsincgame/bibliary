/**
 * Bibliary Olympics — реальный турнир локальных моделей через LM Studio.
 *
 * Не зависит от Electron — pure-Node, использует прямой fetch на
 * OpenAI-совместимый API LM Studio. CLI-обёртка живёт в
 * `scripts/run-olympics.ts`, IPC-обёртка в `electron/ipc/arena.ipc.ts`.
 *
 * Дисциплины подобраны под РОЛИ Bibliary: crystallizer / evaluator /
 * translator / judge — то есть именно те модели, которые потом используются
 * в реальной работе приложения.
 */

const DEFAULT_LMS_URL = "http://localhost:1234";

/**
 * Весовые категории моделей. Оценка по числовому маркеру в имени
 * («3b» / «9b» / «27b» / …). Если маркера нет — модель попадает в `unknown`.
 *
 *   XS  ≤ 1B      —  тестовые крошки (qwen3-0.6b)
 *   S   1-5B      —  бытовые роли (extractor / translator / lang-detect)
 *   M   5-12B     —  стандарт качества (judge / evaluator / code-summary)
 *   L   12-30B    —  тяжёлая генерация / vision-meta
 *   XL  30B+      —  full-power (только когда железо позволяет)
 */
export type WeightClass = "xs" | "s" | "m" | "l" | "xl" | "unknown";

export interface OlympicsOptions {
  /** Адрес LM Studio. По умолчанию http://localhost:1234. */
  lmsUrl?: string;
  /** Явный список моделей. Если не задан — авто-выбор лёгких моделей. */
  models?: string[];
  /** Идентификаторы дисциплин для прогона. По умолчанию — все. */
  disciplines?: string[];
  /** Максимум моделей при авто-выборе. Default 4. */
  maxModels?: number;
  /** Таймаут на одну дисциплину для одной модели. Default 90 сек. */
  perDisciplineTimeoutMs?: number;
  /**
   * Фильтр по весовой категории. По умолчанию `"s"` — самый безопасный
   * для слабого железа. Передай `["s", "m"]` чтобы прогнать обе категории.
   */
  weightClasses?: WeightClass[];
  /** Прогресс-каллбэк. */
  onProgress?: (e: OlympicsEvent) => void;
  /** Abort. */
  signal?: AbortSignal;
}

export type OlympicsEvent =
  | { type: "olympics.start"; models: string[]; disciplines: string[] }
  | { type: "olympics.discipline.start"; discipline: string; role: string }
  | { type: "olympics.model.done"; discipline: string; model: string; score: number; durationMs: number; ok: boolean; error?: string }
  | { type: "olympics.discipline.done"; discipline: string; champion: string | null }
  | { type: "olympics.done"; durationMs: number };

export interface OlympicsModelResult {
  model: string;
  weightClass: WeightClass;
  score: number;
  durationMs: number;
  ok: boolean;
  tokens: number;
  sample: string;
  error?: string;
  /** Pareto-метрика: score за единицу времени. score=1 за 5s → efficiency=200. */
  efficiency: number;
}

export interface OlympicsMatchResult {
  discipline: string;
  modelA: string;
  modelB: string;
  scoreA: number;
  scoreB: number;
  winner: string | null;
  draw: boolean;
}

export interface OlympicsDisciplineResult {
  discipline: string;
  role: "crystallizer" | "evaluator" | "translator" | "judge";
  description: string;
  perModel: OlympicsModelResult[];
  matches: OlympicsMatchResult[];
  /** Кто набрал больше всего score. */
  champion: string | null;
  /**
   * ОПТИМАЛЬНАЯ модель = best efficiency среди тех, кто набрал не менее 70%
   * от score чемпиона. Это «не сильнейшая, а та, что нужна на практике».
   */
  optimum: string | null;
}

export interface OlympicsMedalRow {
  model: string;
  gold: number;
  silver: number;
  bronze: number;
  totalScore: number;
  totalDurationMs: number;
}

export interface OlympicsReport {
  generatedAt: string;
  lmsUrl: string;
  models: string[];
  /** Карта model → весовая категория (для UI и анализа). */
  modelWeightClass: Record<string, WeightClass>;
  disciplines: OlympicsDisciplineResult[];
  medals: OlympicsMedalRow[];
  /**
   * Авто-рекомендации: ключ — pref-name (extractorModel/judgeModel/...),
   * значение — modelKey. По умолчанию это OPTIMUM, а не CHAMPION.
   */
  recommendations: Record<string, string>;
  /** Pure-CHAMPION-рекомендации (победившие по score любой ценой). */
  recommendationsByScore: Record<string, string>;
  totalDurationMs: number;
}

/* ─── ДИСЦИПЛИНЫ ─────────────────────────────────────────────────────── */

interface Discipline {
  id: string;
  role: OlympicsDisciplineResult["role"];
  description: string;
  system: string;
  user: string;
  score(answer: string): number;
  maxTokens: number;
}

export const OLYMPICS_DISCIPLINES: Discipline[] = [
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
        const ej = JSON.stringify(parsed).toLowerCase();
        let s = 0.4;
        if (obj.facts.length >= 3) s += 0.15;
        if (obj.entities.length >= 3) s += 0.15;
        if (ej.includes("mars")) s += 0.1;
        if (ej.includes("nasa")) s += 0.1;
        if (/2012/.test(ej)) s += 0.1;
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
      const techPreserved = lower.includes("o(v + e)") || lower.includes("o(v+e)");
      const noUkraine = !/[іїєґ]/.test(a) || (a.match(/[іїєґ]/g)?.length ?? 0) < 3;
      const hasRussian = /[а-я]/.test(a);
      let s = 0;
      if (hasRussian) s += 0.3;
      if (techPreserved) s += 0.3;
      if (noUkraine) s += 0.2;
      if (lower.includes("обход") || lower.includes("поиск")) s += 0.2;
      return Math.min(1, s);
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

  /* ─── НОВЫЕ ДИСЦИПЛИНЫ ДЛЯ FALLBACK CHAIN ─────────────────────────── */

  {
    /* Описание примера кода — кейс bundle-import: cpp-книга + сотни .cpp файлов
       рядом. LLM должна за 2-3 предложения объяснить что делает код. */
    id: "code-summary-cpp",
    role: "crystallizer", /* sidecar describer тоже идёт через crystallizer */
    description: "Описать пример C++ кода (sidecar для bundle-import).",
    system:
      "You are a code reviewer. In 2-3 sentences explain what this C++ code does. " +
      "Be concise and technical. No markdown.",
    user:
      "```cpp\n" +
      "#include <vector>\n" +
      "#include <algorithm>\n" +
      "void quicksort(std::vector<int>& v, int lo, int hi) {\n" +
      "  if (lo >= hi) return;\n" +
      "  int pivot = v[(lo + hi) / 2];\n" +
      "  int i = lo, j = hi;\n" +
      "  while (i <= j) {\n" +
      "    while (v[i] < pivot) i++;\n" +
      "    while (v[j] > pivot) j--;\n" +
      "    if (i <= j) std::swap(v[i++], v[j--]);\n" +
      "  }\n" +
      "  quicksort(v, lo, j);\n" +
      "  quicksort(v, i, hi);\n" +
      "}\n" +
      "```",
    maxTokens: 200,
    score: (a) => {
      const lower = a.toLowerCase();
      let s = 0;
      if (lower.length > 30 && lower.length < 1500) s += 0.2; /* разумная длина */
      if (lower.includes("quicksort") || lower.includes("quick sort") || lower.includes("быстр")) s += 0.3;
      if (lower.includes("pivot") || lower.includes("опорн")) s += 0.2;
      if (lower.includes("recurs") || lower.includes("рекурс")) s += 0.15;
      if (lower.includes("partition") || lower.includes("разби") || lower.includes("разделя")) s += 0.15;
      return Math.min(1, s);
    },
  },

  {
    /* HTML-extraction: извлечь полезный текст из скачанного фрагмента сайта.
       Важно для bundle-import (книга + downloaded examples-files). */
    id: "html-extract",
    role: "crystallizer",
    description: "Извлечь чистый текст из HTML (без тегов, скриптов, CSS).",
    system:
      "Extract the visible main content as plain text. Skip <script>, <style>, " +
      "navigation menus, ads. Output ONLY the cleaned text.",
    user:
      "<!DOCTYPE html><html><head><title>Tutorial</title>" +
      "<script>var x = 1;</script><style>body{color:red}</style></head>" +
      "<body><nav>Menu | Home | About</nav>" +
      "<main><h1>Binary Search</h1>" +
      "<p>Binary search is an algorithm with O(log n) complexity. " +
      "It works on sorted arrays by halving the search range.</p></main>" +
      "<footer>(c) 2024</footer></body></html>",
    maxTokens: 256,
    score: (a) => {
      const lower = a.toLowerCase();
      let s = 0;
      if (!a.includes("<")) s += 0.25; /* нет tags — хорошо */
      if (!lower.includes("<script") && !lower.includes("<style")) s += 0.15;
      if (lower.includes("binary search") || lower.includes("бинарн")) s += 0.25;
      if (lower.includes("o(log n)") || lower.includes("o(log")) s += 0.2;
      if (!lower.includes("menu") && !lower.includes("(c) 2024")) s += 0.15; /* убрал navigation/footer */
      return Math.min(1, s);
    },
  },

  {
    /* Lang detection — должно быть быстро, для роли lang_detector. */
    id: "lang-detect-mixed",
    role: "judge", /* решение как «pick: ru | uk | en» — это judge */
    description: "Определить язык текста (наша роль lang_detector).",
    system:
      "You detect language. Output ONLY a single word: ru, uk, en, or de.",
    user:
      "Text: 'Алгоритм пошуку в глибину обходить дерево'. What language?",
    maxTokens: 8,
    score: (a) => {
      const t = a.trim().toLowerCase().replace(/[^a-z]/g, "");
      if (t === "uk") return 1.0;
      if (t.startsWith("uk")) return 0.85;
      if (t === "ru") return 0.2; /* частая ошибка из-за кириллицы */
      return 0.0;
    },
  },
];

/* ─── LM Studio API ──────────────────────────────────────────────────── */

interface ChatResp {
  content: string;
  durationMs: number;
  totalTokens: number;
  ok: boolean;
  error?: string;
}

export async function lmsListAvailableModels(lmsUrl: string = DEFAULT_LMS_URL): Promise<string[]> {
  const r = await fetch(`${lmsUrl}/v1/models`, { signal: AbortSignal.timeout(5_000) });
  if (!r.ok) throw new Error(`LM Studio /v1/models HTTP ${r.status}`);
  const data = (await r.json()) as { data: Array<{ id: string }> };
  return data.data.map((m) => m.id).filter((id) => !/embed/i.test(id));
}

async function lmsChat(
  lmsUrl: string,
  model: string,
  system: string,
  user: string,
  opts: { temperature?: number; maxTokens?: number; timeoutMs?: number; signal?: AbortSignal },
): Promise<ChatResp> {
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timeoutId = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 90_000);
  const onAbort = (): void => ctrl.abort();
  opts.signal?.addEventListener("abort", onAbort);
  try {
    const r = await fetch(`${lmsUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature: opts.temperature ?? 0.2,
        max_tokens: opts.maxTokens ?? 512,
      }),
      signal: ctrl.signal,
    });
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
  } finally {
    clearTimeout(timeoutId);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}

/* ─── Core ───────────────────────────────────────────────────────────── */

/**
 * Классифицирует модель по «весовой категории» на основе количества
 * параметров, выведенного из имени. Без guess-работы: если маркера нет —
 * вернёт `unknown`, а вызывающий должен решить, что с этим делать.
 */
export function classifyWeight(modelKey: string): WeightClass {
  const lower = modelKey.toLowerCase();
  /* match: 0.6b / 3b / 7b / 9b / 27b / 30b / 35b — десятичная или целая. */
  const m = lower.match(/(\d+(?:\.\d+)?)\s*b\b/);
  if (!m) return "unknown";
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return "unknown";
  if (n <= 1.5) return "xs";
  if (n <= 5)   return "s";
  if (n <= 12)  return "m";
  if (n <= 30)  return "l";
  return "xl";
}

export function pickModelsForOlympics(
  all: string[],
  explicit?: string[],
  maxModels = 4,
  weightClasses?: WeightClass[],
): string[] {
  const eligible = all.filter((m) => !/embed/i.test(m));
  if (explicit && explicit.length > 0) return eligible.filter((m) => explicit.includes(m));

  /* Default = только S — безопасно даже на слабом железе. */
  const wantClasses = new Set<WeightClass>(weightClasses ?? ["s"]);

  const filtered = eligible.filter((m) => wantClasses.has(classifyWeight(m)));
  if (filtered.length === 0) {
    /* Fallback: если в нужном классе нет моделей, добираем из ближайшего. */
    return pickModelsForOlympics(all, undefined, maxModels, ["xs", "s", "m"]);
  }

  /* Внутри класса — приоритет по семейству и качеству. */
  const score = (m: string): number => {
    const lower = m.toLowerCase();
    let s = 0;
    if (lower.includes("qwen3")) s += 3;
    else if (lower.includes("qwen")) s += 2;
    if (lower.includes("gemma")) s += 1;
    if (lower.includes("ministral") || lower.includes("mistral")) s += 1;
    if (lower.includes("instruct") || lower.includes("-it")) s += 2;
    if (lower.includes("coder")) s -= 1; /* код-специалист: не идёт на translator */
    if (lower.includes("abliterated")) s -= 5; /* uncensored — не для еverydays */
    return s;
  };
  const ranked = [...filtered].sort((a, b) => score(b) - score(a));

  /* Семейная диверсификация: чтобы в категории не оказалось 4 разных
     qwen3 одинаковой массы. */
  const picked: string[] = [];
  const families = new Set<string>();
  for (const m of ranked) {
    const fam = m.toLowerCase().split(/[\/\-_]/)[0]!;
    if (families.has(fam) && picked.length >= 2) continue;
    families.add(fam);
    picked.push(m);
    if (picked.length >= maxModels) break;
  }
  return picked;
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

export async function runOlympics(opts: OlympicsOptions = {}): Promise<OlympicsReport> {
  const lmsUrl = opts.lmsUrl ?? DEFAULT_LMS_URL;
  const t0 = Date.now();

  let allModels: string[];
  try {
    allModels = await lmsListAvailableModels(lmsUrl);
  } catch (e) {
    throw new Error(`LM Studio офлайн (${lmsUrl}): ${e instanceof Error ? e.message : e}`);
  }

  const models = pickModelsForOlympics(
    allModels,
    opts.models,
    opts.maxModels,
    opts.weightClasses,
  );
  if (models.length < 2) {
    const wc = (opts.weightClasses ?? ["s"]).join(",");
    throw new Error(
      `Нужно минимум 2 модели в весовых классах [${wc}]. Найдено: ${models.length}. ` +
      `Доступно в LM Studio: ${allModels.join(", ")}. ` +
      `Загрузи 2+ моделей нужного класса (см. classifyWeight).`,
    );
  }
  const modelWeightClass: Record<string, WeightClass> = {};
  for (const m of models) modelWeightClass[m] = classifyWeight(m);

  const disciplines = opts.disciplines
    ? OLYMPICS_DISCIPLINES.filter((d) => opts.disciplines!.includes(d.id) || opts.disciplines!.includes(d.role))
    : OLYMPICS_DISCIPLINES;
  if (disciplines.length === 0) {
    throw new Error(`Нет ни одной дисциплины (запрошено: ${opts.disciplines?.join(", ") ?? "—"})`);
  }

  opts.onProgress?.({ type: "olympics.start", models, disciplines: disciplines.map((d) => d.id) });

  const results: OlympicsDisciplineResult[] = [];
  for (const d of disciplines) {
    if (opts.signal?.aborted) throw new Error("Olympics aborted");
    opts.onProgress?.({ type: "olympics.discipline.start", discipline: d.id, role: d.role });
    const perModel: OlympicsModelResult[] = [];
    for (const m of models) {
      if (opts.signal?.aborted) throw new Error("Olympics aborted");
      const r = await lmsChat(lmsUrl, m, d.system, d.user, {
        maxTokens: d.maxTokens,
        timeoutMs: opts.perDisciplineTimeoutMs ?? 90_000,
        signal: opts.signal,
      });
      const s = r.ok ? d.score(r.content) : 0;
      const efficiency = r.durationMs > 0 ? (s * 1000) / r.durationMs : 0;
      perModel.push({
        model: m,
        weightClass: classifyWeight(m),
        score: s,
        durationMs: r.durationMs,
        ok: r.ok,
        tokens: r.totalTokens,
        sample: r.content.slice(0, 240).replace(/\s+/g, " "),
        error: r.error,
        efficiency,
      });
      opts.onProgress?.({ type: "olympics.model.done", discipline: d.id, model: m, score: s, durationMs: r.durationMs, ok: r.ok, error: r.error });
    }

    const matches: OlympicsMatchResult[] = [];
    for (let i = 0; i < models.length; i++) {
      for (let j = i + 1; j < models.length; j++) {
        const A = perModel.find((p) => p.model === models[i])!;
        const B = perModel.find((p) => p.model === models[j])!;
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

    /* Optimum: лучший efficiency среди тех, кто набрал ≥70% от score чемпиона.
       Это и есть «оптимальный для бабушек» — почти как чемпион, но в N раз
       быстрее. Если score чемпиона = 0 (все провалились) — optimum = null. */
    const championScore = sorted[0]?.score ?? 0;
    let optimum: string | null = null;
    if (championScore > 0) {
      const acceptable = perModel.filter((p) => p.ok && p.score >= championScore * 0.7);
      const byEff = [...acceptable].sort((a, b) => b.efficiency - a.efficiency);
      optimum = byEff[0]?.model ?? null;
    }

    results.push({ discipline: d.id, role: d.role, description: d.description, perModel, matches, champion, optimum });
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

  /* Авто-рекомендации:
       primary  → optimum (score/время) — это и есть «бабушкин выбор»
       byScore  → champion (max score)  — для тех, кто хочет «лучшее любой ценой» */
  const recommendations: Record<string, string> = {};
  const recommendationsByScore: Record<string, string> = {};
  for (const r of results) {
    const prefKey = roleToPrefKey(r.role);
    if (!prefKey) continue;
    if (r.optimum)  recommendations[prefKey]        = r.optimum;
    if (r.champion) recommendationsByScore[prefKey] = r.champion;
  }

  const totalDurationMs = Date.now() - t0;
  opts.onProgress?.({ type: "olympics.done", durationMs: totalDurationMs });

  return {
    generatedAt: new Date().toISOString(),
    lmsUrl,
    models,
    modelWeightClass,
    disciplines: results,
    medals,
    recommendations,
    recommendationsByScore,
    totalDurationMs,
  };
}
