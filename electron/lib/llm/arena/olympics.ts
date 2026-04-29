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
  /** Максимум моделей при авто-выборе. Default 6. */
  maxModels?: number;
  /** Таймаут на одну дисциплину для одной модели. Default 90 сек. */
  perDisciplineTimeoutMs?: number;
  /**
   * Фильтр по весовой категории. По умолчанию `["s","m"]` — стандарт
   * качества для большинства ролей. Передай `["s","m","l"]` если железо
   * позволяет (16GB+ VRAM).
   */
  weightClasses?: WeightClass[];
  /** Тестировать ВСЕ доступные модели (игнорирует weightClasses + maxModels). */
  testAll?: boolean;
  /** Фильтр по ролям — запускать только дисциплины этих ролей. Пустой = все. */
  roles?: OlympicsRole[];
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

/**
 * Все роли пайплайна Bibliary, для которых есть смысл калибровать модель.
 * Список синхронизирован с PIPELINE_ROLES в renderer/models/models-page.js
 * и pref-ключами в preferences-store.
 */
export type OlympicsRole =
  | "crystallizer"
  | "evaluator"
  | "translator"
  | "judge"
  | "lang_detector"
  | "ukrainian_specialist"
  | "vision";

export interface OlympicsDisciplineResult {
  discipline: string;
  role: OlympicsRole;
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

/**
 * Агрегат для одной РОЛИ по нескольким её дисциплинам — основа выбора модели.
 * Для каждой модели усредняются результаты по всем дисциплинам этой роли.
 */
export interface OlympicsRoleAggregate {
  role: OlympicsRole;
  prefKey: string;
  disciplines: string[];
  /** Усреднённые показатели каждой модели по всем дисциплинам этой роли. */
  perModel: Array<{
    model: string;
    avgScore: number;        // 0..1
    minScore: number;        // 0..1 — худшее из дисциплин (показывает стабильность)
    avgDurationMs: number;
    avgEfficiency: number;
    coverage: number;        // 0..1 — доля дисциплин где score > 0.3
    okCount: number;
    totalCount: number;
  }>;
  /** Лучшая по avgScore (стабильное качество во всех дисциплинах). */
  champion: string | null;
  /** Лучшая по efficiency среди acceptable (avgScore ≥ 70% от champion). */
  optimum: string | null;
  /** Текстовое объяснение почему именно эта модель — для UI. */
  championReason: string | null;
  optimumReason: string | null;
}

export interface OlympicsMedalRow {
  model: string;
  gold: number;
  silver: number;
  bronze: number;
  totalScore: number;
  totalDurationMs: number;
}

/**
 * Причина выбора модели для роли — показывается в UI рядом с рекомендацией.
 * Содержит человекочитаемое объяснение откуда взялся оптимум/чемпион.
 */
export interface OlympicsRoleReason {
  /** pref-key роли (extractorModel / judgeModel / ...) */
  prefKey: string;
  /** Лучшая дисциплина, где выбрана optimum-модель */
  optimumDiscipline?: string;
  /** Модель-оптимум и краткое объяснение (score, efficiency) */
  optimumModel?: string;
  optimumReason?: string;
  /** Лучшая дисциплина, где выбран champion */
  championDiscipline?: string;
  optimumScore?: number;
  championModel?: string;
  championScore?: number;
  championReason?: string;
}

export interface OlympicsReport {
  generatedAt: string;
  lmsUrl: string;
  models: string[];
  /** Карта model → весовая категория (для UI и анализа). */
  modelWeightClass: Record<string, WeightClass>;
  disciplines: OlympicsDisciplineResult[];
  /**
   * Агрегаты по ролям — основа рекомендаций. Каждая роль здесь
   * собирает все свои дисциплины и усредняет per-model результаты.
   */
  roleAggregates: OlympicsRoleAggregate[];
  medals: OlympicsMedalRow[];
  /**
   * Авто-рекомендации: ключ — pref-name (extractorModel/judgeModel/...),
   * значение — modelKey. По умолчанию это OPTIMUM, а не CHAMPION.
   */
  recommendations: Record<string, string>;
  /** Pure-CHAMPION-рекомендации (победившие по score любой ценой). */
  recommendationsByScore: Record<string, string>;
  /** Причины выбора для каждой роли — объяснение в UI. */
  roleReasons: OlympicsRoleReason[];
  /**
   * Предупреждения: мало моделей, нет чемпиона и т.д.
   * Показываются в UI под кнопкой и в результатах.
   */
  warnings: string[];
  /** Сколько моделей доступно в LM Studio до фильтрации (для UX «скачай больше»). */
  availableModelCount: number;
  /** Сколько дисциплин запущено (для UI и i18n-сабтайтла). */
  disciplineCount: number;
  totalDurationMs: number;
}

/* ─── ДИСЦИПЛИНЫ ─────────────────────────────────────────────────────── */

interface Discipline {
  id: string;
  role: OlympicsRole;
  description: string;
  system: string;
  user: string;
  score(answer: string): number;
  maxTokens: number;
  /** Краткое объяснение почему этот тест важен для роли (для UI explain). */
  whyImportant?: string;
  /** Base64 data-URI картинки для мультимодальной дисциплины (vision). */
  imageUrl?: string;
}

/* Helper: безопасный парсинг JSON с очисткой markdown-обёрток. */
function tryParseJson(answer: string): unknown | null {
  const cleaned = answer
    .replace(/```(?:json)?\s*/gi, "")
    .replace(/```\s*$/g, "")
    .replace(/^[^{[]*/, "")
    .replace(/[^}\]]*$/, "");
  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

export const OLYMPICS_DISCIPLINES: Discipline[] = [
  {
    id: "crystallizer-rover",
    role: "crystallizer",
    description: "Извлечь факты + сущности (наша роль delta-extractor).",
    whyImportant:
      "Кристаллизатор — основа dataset-генерации. Тест проверяет: 1) валидность JSON-структуры; 2) полноту извлечения (4 факта в источнике); 3) корректную типизацию сущностей; 4) отсутствие галлюцинаций.",
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
      const parsed = tryParseJson(a);
      if (!parsed || typeof parsed !== "object") return 0;
      const obj = parsed as { facts?: unknown[]; entities?: unknown[] };
      if (!Array.isArray(obj.facts) || !Array.isArray(obj.entities)) return 0.15;

      let s = 0.2;
      const factCount = obj.facts.length;
      /* В источнике 4 ключевых факта: дата, место, источник питания, оператор.
         Точная полнота: 4+ → +0.15, 3 → +0.10, 2 → +0.05, 1 → 0. */
      if (factCount >= 4) s += 0.15;
      else if (factCount === 3) s += 0.10;
      else if (factCount === 2) s += 0.05;

      const entCount = obj.entities.length;
      /* Ожидаемые сущности: Curiosity, Mars, Gale Crater, NASA, JPL, plutonium-238 (6).
         Достаточно 4+ для зачёта. */
      if (entCount >= 4) s += 0.15;
      else if (entCount >= 3) s += 0.10;
      else if (entCount >= 2) s += 0.05;

      const allText = JSON.stringify(parsed).toLowerCase();
      /* Конкретные факты-якоря — каждый по +0.075. */
      if (allText.includes("mars")) s += 0.075;
      if (allText.includes("nasa") || allText.includes("jpl") || allText.includes("jet propulsion")) s += 0.075;
      if (/\b2012\b|august\s*6/.test(allText)) s += 0.075;
      if (allText.includes("gale crater") || allText.includes("gale")) s += 0.075;
      if (allText.includes("plutonium") || allText.includes("rtg") || allText.includes("radioisotope")) s += 0.075;
      if (allText.includes("curiosity")) s += 0.075;

      /* Штрафы за галлюцинации (фактов, которых нет в источнике): */
      if (/spirit|opportunity|perseverance/.test(allText)) s -= 0.15; /* другие роверы */
      if (/2003|2008|2020|2021/.test(allText)) s -= 0.15; /* неверные годы */

      /* Штраф за пустые/мусорные сущности. */
      const validEntities = obj.entities.filter((e: unknown) => {
        if (!e || typeof e !== "object") return false;
        const en = e as { name?: unknown; type?: unknown };
        return typeof en.name === "string" && en.name.length >= 2 && typeof en.type === "string";
      });
      if (entCount > 0 && validEntities.length / entCount < 0.5) s -= 0.15;

      return Math.max(0, Math.min(1, s));
    },
  },
  {
    id: "evaluator-clrs",
    role: "evaluator",
    description: "Оценить классику CS-литературы (high-end).",
    whyImportant:
      "CLRS — общепризнанная классика, эталон оценки 9-10. Если модель ставит ≤6 — она недооценивает референсы и засорит датасет шумовыми книгами. Тест на «верхнюю планку».",
    system:
      "You evaluate book quality. Score 0-10 (10 = excellent technical reference). " +
      'Output ONLY JSON: {"score":number,"reasoning":string}.',
    user:
      'Book: "Introduction to Algorithms" by CLRS. ' +
      "Topics: algorithm analysis, sorting, graph algorithms, dynamic programming. " +
      "Year: 4th ed. 2022. Pages: 1312. Used by top universities worldwide.",
    maxTokens: 256,
    score: (a) => {
      const parsed = tryParseJson(a) as { score?: number; reasoning?: string } | null;
      if (!parsed || typeof parsed.score !== "number") return 0;

      let s = 0;
      /* CLRS — общепризнанная 9-10. Узкое окно. */
      if (parsed.score >= 9 && parsed.score <= 10)      s += 0.6;
      else if (parsed.score === 8)                       s += 0.4;
      else if (parsed.score === 7)                       s += 0.2;
      else                                                s += 0.0; /* недооценка классики — серьёзный fail */

      if (typeof parsed.reasoning === "string") {
        const r = parsed.reasoning.toLowerCase();
        if (r.length >= 30) s += 0.15;
        if (r.length >= 80) s += 0.05;
        /* Содержательное обоснование: упомянул хотя бы 1 ключевой факт. */
        if (/algorithm|алгоритм|computer science|cs|university|универс|reference|стандарт/.test(r)) s += 0.10;
        if (/clrs|cormen|leiserson|rivest|stein/.test(r)) s += 0.10;
      }

      return Math.max(0, Math.min(1, s));
    },
  },
  {
    id: "evaluator-noise",
    role: "evaluator",
    description: "Отсеять шумовую книгу (low-end).",
    whyImportant:
      "Без проверки на «нижнюю планку» оценщик пропустит мотивашки и поваренные книги в технический датасет. Тест проверяет, что модель ставит 1-3 за non-CS noise.",
    system:
      "You evaluate book quality for a TECHNICAL knowledge base. Score 0-10. " +
      'Output ONLY JSON: {"score":number,"reasoning":string}.',
    user:
      'Book: "10 Days to a Better You: Manifest Your Dreams Through Crystal Energy". ' +
      "Topics: chakras, manifestation, positive thinking. " +
      "Year: 2024. Pages: 89. Self-published.",
    maxTokens: 200,
    score: (a) => {
      const parsed = tryParseJson(a) as { score?: number; reasoning?: string } | null;
      if (!parsed || typeof parsed.score !== "number") return 0;

      let s = 0;
      /* Шум для технической базы знаний — должно быть 1-3. */
      if (parsed.score >= 1 && parsed.score <= 3)        s += 0.6;
      else if (parsed.score === 4 || parsed.score === 0) s += 0.3;
      else if (parsed.score === 5)                        s += 0.15;
      else                                                s += 0.0; /* ≥6 — модель пропускает шум */

      if (typeof parsed.reasoning === "string" && parsed.reasoning.length >= 20) s += 0.2;
      if (typeof parsed.reasoning === "string") {
        const r = parsed.reasoning.toLowerCase();
        if (/non[\s-]?technical|self[\s-]?help|mot|noise|шум|нетехни|self[\s-]?publ|low\s*qual/.test(r)) s += 0.2;
      }

      return Math.max(0, Math.min(1, s));
    },
  },
  {
    id: "evaluator-midrange",
    role: "evaluator",
    description: "Оценить средне-качественную книгу (mid-range 5-7).",
    whyImportant:
      "Evaluator должен различать 3 уровня: шум (1-3), среднее (5-7), эталон (9-10). Без теста на середину шкалы оценщик может пропускать нишевые, но полезные книги или, наоборот, завышать посредственные.",
    system:
      "You evaluate book quality for a TECHNICAL knowledge base. Score 0-10. " +
      'Output ONLY JSON: {"score":number,"reasoning":string}.',
    user:
      'Book: "Git & GitHub Visual Guide" by Bloomfield B., Ocean D., Skylark A., Celis V. ' +
      "Topics: git basics, branching, pull requests, GitHub Actions. " +
      "Year: 2024. Pages: 210. Visual step-by-step format. " +
      "Aimed at beginners. Published by small publisher.",
    maxTokens: 200,
    score: (a) => {
      const parsed = tryParseJson(a) as { score?: number; reasoning?: string } | null;
      if (!parsed || typeof parsed.score !== "number") return 0;

      let s = 0;
      /* Ожидаем 5-7: полезная нишевая книга, не шум и не классика. */
      if (parsed.score >= 5 && parsed.score <= 7)         s += 0.6;
      else if (parsed.score === 4 || parsed.score === 8)  s += 0.3;
      else if (parsed.score === 3 || parsed.score === 9)  s += 0.1;
      else                                                 s += 0.0;

      if (typeof parsed.reasoning === "string") {
        const r = parsed.reasoning.toLowerCase();
        if (r.length >= 30) s += 0.15;
        if (r.length >= 80) s += 0.05;
        if (/beginner|начинающ|visual|step|introduction|вводн/.test(r)) s += 0.10;
        if (/niche|narrow|basics|базов|git/.test(r)) s += 0.10;
      }

      return Math.max(0, Math.min(1, s));
    },
  },
  {
    id: "translator-uk-ru",
    role: "translator",
    description: "Перевод UK→RU с техническими терминами.",
    whyImportant:
      "Переводчик должен: 1) полностью убрать укр.буквы (іїєґ); 2) сохранить точно «O(V + E)» и обозначения; 3) дать живой русский, не машинный кальк. Без этих свойств — мусор в датасете.",
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
      const ukChars = (a.match(/[іїєґІЇЄҐ]/g)?.length ?? 0);
      const ruChars = (a.match(/[а-яА-Я]/g)?.length ?? 0);
      const totalText = a.replace(/[^а-яёїєґіА-ЯЁЇЄҐІ]/gi, "").length;

      let s = 0;
      /* 1. Полное русскоязычие — украинские буквы должны исчезнуть. */
      if (totalText >= 30 && ruChars / totalText >= 0.95 && ukChars === 0) s += 0.30;
      else if (ukChars <= 2)                                                s += 0.15;
      else if (ukChars <= 5)                                                s += 0.05;

      /* 2. Сохранение технических обозначений — точная буквенная копия. */
      if (lower.includes("o(v + e)") || lower.includes("o(v+e)")) s += 0.25;
      else if (lower.includes("o(v") && lower.includes("e)"))      s += 0.10;

      /* 3. Аббревиатура DFS — must be preserved. */
      if (a.includes("DFS")) s += 0.15;

      /* 4. Корректные русские термины (не калька). */
      if (/обход|обходит/.test(lower))       s += 0.10;
      if (/поиск\s+в\s+глубин/.test(lower))   s += 0.10;
      if (/(сложность|время|complexity)/.test(lower)) s += 0.05;
      if (/(дерев|корн|ветв|узел|узл)/.test(lower))    s += 0.05;

      /* Штрафы. */
      if (lower.length < 50)                  s -= 0.20;
      if (lower.length > 600)                 s -= 0.10; /* раздул, не должен быть в N раз длиннее */
      if (/обходить|починаючи|якомога/.test(a)) s -= 0.15; /* остаточные укр.слова — кальки */

      return Math.max(0, Math.min(1, s));
    },
  },
  {
    id: "ukrainian-uk-write",
    role: "ukrainian_specialist",
    description: "Написать связный текст на украинском.",
    whyImportant:
      "Украинская роль активируется когда исходник на укр. Тест: модель должна СОЗДАТЬ грамотный укр.текст, не подменив на русский и сохранив укр.орфографию (іїєґ).",
    system:
      "Ти — мовний спеціаліст з української. Пиши лише українською мовою. " +
      "Дотримуйся української орфографії (літери і, ї, є, ґ).",
    user:
      "Поясни одним абзацом (3-4 речення), що таке алгоритм Дейкстри: " +
      "де застосовується, яка складність, які обмеження.",
    maxTokens: 320,
    score: (a) => {
      const ukChars = (a.match(/[іїєґІЇЄҐ]/g)?.length ?? 0);
      const ruOnly  = (a.match(/[ыэъ]/gi)?.length ?? 0); /* буквы которых нет в укр. */
      const len = a.replace(/\s+/g, " ").trim().length;

      let s = 0;
      /* Реальное укр.письмо: должны быть і/ї/є. */
      if (ukChars >= 5)         s += 0.35;
      else if (ukChars >= 2)    s += 0.20;
      else                       s += 0.0; /* нет укр.букв — провал */

      /* Не русский. */
      if (ruOnly === 0)         s += 0.20;
      else if (ruOnly <= 2)     s += 0.10;
      else                       s -= 0.20;

      /* Содержательность. */
      if (len >= 100 && len <= 800) s += 0.15;
      if (/дейкстр/i.test(a))         s += 0.10;
      if (/(граф|шлях|відстан|вершин)/i.test(a)) s += 0.10;
      if (/o\([^)]+\)|складніст|n\^?2|log\s*n/i.test(a)) s += 0.10;

      return Math.max(0, Math.min(1, s));
    },
  },
  {
    id: "judge-bst",
    role: "judge",
    description: "Сравнить два ответа: правильный = A.",
    whyImportant:
      "Судья оценивает качество ответов на арене. Тест на anti-bias-A: правильный ответ — A. Если модель отвечает наугад — score будет 0.5 на двух тестах вместе.",
    system:
      "You are a strict but fair judge. Compare two answers. Output ONLY the letter A or B.",
    user:
      "Question: What is the time complexity of inserting into a balanced BST?\n\n" +
      "Answer A: O(log n) average and worst case, because the tree stays balanced.\n\n" +
      "Answer B: O(n) because you might have to traverse the whole tree.\n\n" +
      "Which is correct? A or B?",
    maxTokens: 16,
    score: (a) => {
      const t = a.trim().toUpperCase().replace(/[^A-Z]/g, "");
      if (t.startsWith("A")) return 1.0;
      if (t.startsWith("B")) return 0.0;
      return 0.2;
    },
  },
  {
    id: "judge-async",
    role: "judge",
    description: "Сравнить два ответа: правильный = B (anti-A bias).",
    whyImportant:
      "Парный тест к judge-bst — здесь правильный ответ B, чтобы выявить bias-A (склонность судьи всегда говорить «A»). Стабильно good-судья наберёт 1.0 в обоих тестах.",
    system:
      "You are a strict but fair judge. Compare two answers. Output ONLY the letter A or B.",
    user:
      "Question: In Python, what does `await` do in an async function?\n\n" +
      "Answer A: It blocks the entire program until the awaited operation completes.\n\n" +
      "Answer B: It pauses the current coroutine and yields control to the event loop until the awaitable resolves.\n\n" +
      "Which is correct? A or B?",
    maxTokens: 16,
    score: (a) => {
      const t = a.trim().toUpperCase().replace(/[^A-Z]/g, "");
      if (t.startsWith("B")) return 1.0;
      if (t.startsWith("A")) return 0.0;
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
    id: "lang-detect-uk",
    role: "lang_detector",
    description: "Различить украинский от русского (анти-bias на кириллицу).",
    whyImportant:
      "Lang-detector часто путает UK и RU из-за общей кириллицы. Этот тест вылавливает модели которые при виде кириллицы отвечают «ru». Использование таких моделей сломает украинский pipeline.",
    system:
      "You detect language. Output ONLY a single word: ru, uk, en, or de. No punctuation.",
    user:
      "Text: 'Алгоритм пошуку в глибину обходить дерево, починаючи з кореня'. What language?",
    maxTokens: 8,
    score: (a) => {
      const t = a.trim().toLowerCase().replace(/[^a-z]/g, "");
      if (t === "uk")          return 1.0;
      if (t.startsWith("uk"))  return 0.85;
      if (t === "ru")          return 0.0; /* серьёзная ошибка для пайплайна */
      if (t === "ukrainian")   return 0.85;
      return 0.1;
    },
  },
  {
    id: "lang-detect-en",
    role: "lang_detector",
    description: "Распознать английский (контроль).",
    whyImportant:
      "Контрольный тест: english не должен вызывать проблем. Если и здесь модель промахивается — она сломана.",
    system:
      "You detect language. Output ONLY a single word: ru, uk, en, or de. No punctuation.",
    user:
      "Text: 'The depth-first search algorithm traverses the tree starting from the root'. What language?",
    maxTokens: 8,
    score: (a) => {
      const t = a.trim().toLowerCase().replace(/[^a-z]/g, "");
      if (t === "en" || t === "english") return 1.0;
      if (t.startsWith("en"))             return 0.85;
      return 0.0;
    },
  },

  /* ─── Vision ────────────────────────────────────────────────────────── */
  {
    id: "vision-describe-shapes",
    role: "vision",
    description: "Описать содержимое изображения (vision-модель).",
    whyImportant:
      "Vision-модели используются для OCR обложек и иллюстраций. Если модель не видит " +
      "геометрию на тривиальной картинке — она не справится с OCR книжных обложек.",
    system:
      "You are a vision assistant. Describe what you see in this image. " +
      "Be precise about colors and shapes. 1-2 sentences. No markdown.",
    user: "Describe this image.",
    imageUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAFAAAAAeCAIAAAA0IQ7mAAAAUklEQVR4nO3PwQkAIAwEweu/MrvSjxVIArLZ5d4hk2QNW9Yek2B6gukJpieYXjM4eV/XR4JrzwsWLFhw7UeCa88LZoP/SzA9wfQE0xNM74JH7QAkJZohvhUzSwAAAABJRU5ErkJggg==",
    maxTokens: 128,
    score: (a) => {
      const lower = a.toLowerCase();
      let s = 0;
      if (lower.length >= 10 && lower.length < 500) s += 0.15;
      if (/red|красн/.test(lower))                   s += 0.25;
      if (/rectangle|rect|square|квадрат|прямоуг/.test(lower)) s += 0.25;
      if (/blue|синий|голуб/.test(lower))             s += 0.15;
      if (/white|бел/.test(lower))                    s += 0.10;
      if (/border|frame|рамк|обвод/.test(lower))      s += 0.10;
      return Math.min(1, s);
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
  opts: { temperature?: number; maxTokens?: number; timeoutMs?: number; signal?: AbortSignal; imageUrl?: string },
): Promise<ChatResp> {
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timeoutId = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 90_000);
  const onAbort = (): void => ctrl.abort();
  opts.signal?.addEventListener("abort", onAbort);
  try {
    /* Мультимодальный content для vision-дисциплин (OpenAI-compat). */
    const userContent = opts.imageUrl
      ? [
          { type: "text" as const, text: user },
          { type: "image_url" as const, image_url: { url: opts.imageUrl } },
        ]
      : user;
    const r = await fetch(`${lmsUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: userContent },
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
  maxModels = 6,
  weightClasses?: WeightClass[],
  testAll = false,
): string[] {
  const eligible = all.filter((m) => !/embed/i.test(m));
  if (explicit && explicit.length > 0) return eligible.filter((m) => explicit.includes(m));

  /* Режим «тестировать ВСЕ» — для пользователей, которые знают своё железо. */
  if (testAll) return eligible;

  /* Default = S+M — стандартный диапазон для большинства ролей пайплайна. */
  const wantClasses = new Set<WeightClass>(weightClasses ?? ["s", "m"]);

  const filtered = eligible.filter((m) => wantClasses.has(classifyWeight(m)));
  if (filtered.length === 0) {
    /* Защита от бесконечной рекурсии: если уже расширили до xs/s/m или
       eligible пуст — возвращаем что есть (может быть []), не рекурсим. */
    const isWideSearch = wantClasses.has("xs") && wantClasses.has("s") && wantClasses.has("m");
    if (isWideSearch || eligible.length === 0) return eligible.slice(0, maxModels);
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
    if (lower.includes("abliterated")) s -= 5; /* uncensored — не для everydays */
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

function roleToPrefKey(role: OlympicsRole): string | null {
  switch (role) {
    case "crystallizer":         return "extractorModel";
    case "judge":                return "judgeModel";
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
 */
function buildRoleAggregates(results: OlympicsDisciplineResult[]): OlympicsRoleAggregate[] {
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

    /* Champion = лучший по avgScore (стабильное качество); тай-брейк по avgDurationMs. */
    const sortedByQuality = [...perModel].sort((a, b) => {
      if (Math.abs(a.avgScore - b.avgScore) > 0.03) return b.avgScore - a.avgScore;
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
      perModel: perModel.sort((a, b) => b.avgScore - a.avgScore),
      champion,
      optimum,
      championReason,
      optimumReason,
    });
  }

  return aggregates;
}

/* ─── Кэш результатов ─────────────────────────────────────────────────
   Если набор моделей и дисциплин не изменился с прошлого запуска —
   возвращаем кэш мгновенно. Кэш хранится в памяти процесса; при
   перезапуске или clearOlympicsCache() он сбрасывается. */
let _olympicsCache: { key: string; report: OlympicsReport } | null = null;

function makeCacheKey(models: string[], disciplineIds: string[]): string {
  return [...models].sort().join("|") + "@@" + [...disciplineIds].sort().join("|");
}

/** Очистить кэш результатов олимпиады (IPC: arena:clear-olympics-cache). */
export function clearOlympicsCache(): void {
  _olympicsCache = null;
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
    opts.testAll,
  );
  if (models.length < 2) {
    const wc = (opts.weightClasses ?? ["s", "m"]).join(",");
    throw new Error(
      `Нужно минимум 2 модели в весовых классах [${wc}]. Найдено: ${models.length}. ` +
      `Доступно в LM Studio: ${allModels.join(", ")}. ` +
      `Загрузи 2+ моделей нужного класса (см. classifyWeight).`,
    );
  }

  /* Определяем целевые дисциплины ДО проверки кэша. */
  let targetDisciplines = opts.disciplines
    ? OLYMPICS_DISCIPLINES.filter((d) => opts.disciplines!.includes(d.id) || opts.disciplines!.includes(d.role))
    : OLYMPICS_DISCIPLINES;
  if (opts.roles && opts.roles.length > 0) {
    const wantRoles = new Set(opts.roles);
    targetDisciplines = targetDisciplines.filter((d) => wantRoles.has(d.role));
  }
  const cacheKey = makeCacheKey(models, targetDisciplines.map((d) => d.id));
  if (_olympicsCache && _olympicsCache.key === cacheKey) {
    opts.onProgress?.({ type: "olympics.done", durationMs: 0 });
    return { ..._olympicsCache.report, totalDurationMs: 0 };
  }
  const modelWeightClass: Record<string, WeightClass> = {};
  for (const m of models) modelWeightClass[m] = classifyWeight(m);

  const disciplines = targetDisciplines;
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
        imageUrl: d.imageUrl,
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

  /* ── Per-role aggregation (новая архитектура) ──
     Старый код выбирал "лучшую дисциплину" среди всех с этой ролью —
     это шумный сигнал. Новый код для каждой модели усредняет результаты
     по всем дисциплинам роли и берёт стабильно лучшую. */
  const roleAggregates = buildRoleAggregates(results);

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

  const allWithoutEmbed = allModels.filter((m) => !/embed/i.test(m));
  if (allWithoutEmbed.length < 4) warnings.push("recommend_download");

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
  opts.onProgress?.({ type: "olympics.done", durationMs: totalDurationMs });

  const report: OlympicsReport = {
    generatedAt: new Date().toISOString(),
    lmsUrl,
    models,
    modelWeightClass,
    disciplines: results,
    roleAggregates,
    medals,
    recommendations,
    recommendationsByScore,
    roleReasons,
    warnings,
    availableModelCount: allModels.length,
    disciplineCount: results.length,
    totalDurationMs,
  };
  _olympicsCache = { key: cacheKey, report };
  return report;
}
