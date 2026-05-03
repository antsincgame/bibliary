/**
 * Olympics disciplines — fixtures + scorers for role-based LLM evaluation.
 *
 * Извлечён из `olympics.ts` (Mahakala рефакторинг 2026-04-30). Содержит:
 *   - `Discipline` interface — контракт одного теста
 *   - `OLYMPICS_DISCIPLINES` — полный набор дисциплин по ролям
 *     (crystallizer / evaluator / translator / lang_detector / ukrainian_specialist / vision_*).
 *     Роль `judge` удалена 2026-05-01 (Иt 8А library-fortress) — у неё не
 *     было ни одного production-вызова resolve("judge"), а delta-extractor
 *     заменил отдельный judge-шаг ещё раньше.
 *   - `stripThinkingBlock`, `tryParseJson`, `ukLangScore` — общие helpers
 *
 * Тесты scorer-ов: `tests/olympics-scorers.test.ts`.
 * Политика "thinkingFriendly": `tests/olympics-thinking-policy.test.ts`.
 */

import {
  LANG_DETECT_SYSTEM_PROMPT,
  TRANSLATE_TO_RU_SYSTEM_PROMPT,
} from "./role-prompts.js";
import type { OlympicsRole } from "./olympics-types.js";

/* ─── ДИСЦИПЛИНЫ ─────────────────────────────────────────────────────── */

export interface Discipline {
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
  /**
   * Если true — дисциплина выигрывает от reasoning/thinking моделей
   * (LiteCoST ICLR'26 показал +8-12 пунктов quality для CoT-моделей
   * на extraction tasks). Для таких дисциплин:
   *   • efficiency НЕ штрафует за время (медленный, но точный — норма)
   *   • UI показывает бейдж 🧠 [thinking-friendly]
   *   • thinking-модели не получают penalty за длительный ответ
   *
   * Применять для: complex extraction, nuanced evaluation, multi-step reasoning.
   * НЕ применять для: lang-detect, judge A/B, simple translate, vision-describe.
   */
  thinkingFriendly?: boolean;
}

/**
 * Удаляет `<think>…</think>` (или `<thinking>…</thinking>`) блок из ответа LLM.
 *
 * Qwen3, GLM-4 используют `<think>`; DeepSeek-R1, GPT-OSS — `<thinking>`.
 * LM Studio не всегда разделяет content и reasoning_content, поэтому
 * thinking-блок может оказаться прямо в `content`. Если не вырезать —
 * scorer получит мусор вместо ответа.
 *
 * Поведение:
 * - `<think>reasoning here</think>\n\nen` → `en`
 * - `<thinking>...</thinking>{"score":9}` → `{"score":9}`
 * - `en` (без think) → `en` (noop)
 * - `<think>only reasoning, no close tag` → всё удалено → `""` (пустой)
 */
export function stripThinkingBlock(raw: string): string {
  if (!raw.includes("<think")) return raw;
  const stripped = raw
    /* Парные теги: <think>...</think> или <thinking>...</thinking>. */
    .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, "")
    /* Незакрытый блок (модель не дописала закрывающий тег) — режем до конца. */
    .replace(/<think(?:ing)?>[\s\S]*/gi, "")
    .trim();
  return stripped;
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

/** Scorer для всех украинских lang-detect дисциплин.
 *  Принимает: uk / ukrainian / Українська (кириллица удаляется, проверяем latin) /
 *             украинська / українська (Cyrillic check отдельно).
 *  Ноль если модель говорит "ru" — критическая ошибка для pipeline.
 */
function ukLangScore(a: string): number {
  const raw = a.trim().toLowerCase();
  /* Кириллический ответ: «українська», «украинский» — проверяем до strip */
  if (raw.includes("укра")) return 0.85;  /* "українська", "украинська", "украинский" - but not "uk" = penalize a little */
  const t = raw.replace(/[^a-z]/g, "");
  if (t === "uk")         return 1.0;
  if (t.startsWith("uk") && t.length <= 10) return 0.85;  /* "ukrainian", "ukrainain" typo */
  if (t === "ukrainian")  return 0.85;
  if (t === "ru" || t === "russian") return 0.0; /* грубая ошибка: перепутал uk↔ru */
  if (t === "")           return 0.05; /* пустой ответ */
  return 0.1;
}

export const OLYMPICS_DISCIPLINES: Discipline[] = [
  {
    id: "crystallizer-rover",
    role: "crystallizer",
    thinkingFriendly: true, /* crystallizer = ДА критично (см. docs/audits): извлечение фактов выигрывает от CoT */
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
    thinkingFriendly: true, /* evaluator = ДА: взвешивание факторов = reasoning, не угадывание числа */
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
    thinkingFriendly: true, /* evaluator = ДА: рассуждение «технический ли текст?» */
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
    /* Production-aligned: тестирует ТОЧНУЮ DeltaKnowledgeSchema боевого
     * delta-extractor (domain, essence, cipher, proof, applicability,
     * auraFlags, tags, relations). Олимпиадный crystallizer-rover проверял
     * абстрактные {facts,entities} — не совпадало с продакшен-задачей.
     * Эта дисциплина закрывает разрыв «олимпиада ↔ production». */
    id: "crystallizer-production-delta",
    role: "crystallizer",
    description: "DeltaKnowledge схема продакшна (domain/essence/cipher/proof/AURA/relations).",
    whyImportant:
      "Это ТОЧНАЯ схема delta-extractor в Bibliary. Если модель чемпион в этой дисциплине — она реально подходит для боевого pipeline извлечения знаний (а не для академического {facts,entities}). Тест требует: AURA-флаги ≥2, минимум 1 relation S-P-O, корректный cipher.",
    thinkingFriendly: true,
    system:
      "You are the Delta-Knowledge Crystallizer. Extract ONE atomic insight from the chunk. " +
      "Output STRICT JSON matching this schema (no markdown, no commentary):\n" +
      "{\n" +
      '  "domain": "engineering" | "science" | "ai" | "perf" | "arch" | "research",\n' +
      '  "chapterContext": string (10-300 chars),\n' +
      '  "essence": string (30-800 chars, the deepest insight),\n' +
      '  "cipher": string (5-500 chars, MECHANICUS code: X.<dom>|rule: a -> b),\n' +
      '  "proof": string (10-800 chars, evidence from text),\n' +
      '  "applicability": string (0-500 chars),\n' +
      '  "auraFlags": ["authorship"|"specialization"|"revision"|"causality"] (min 2 of 4),\n' +
      '  "tags": [string] (1-10 short kebab-case),\n' +
      '  "relations": [{"subject":string,"predicate":string,"object":string}] (1-8, predicate NOT is/was/has)\n' +
      "}\n" +
      "Do NOT use 'is/was/has' as predicate — use concrete verbs like 'depends_on', 'extends', 'refutes'.",
    user:
      "Extract a DeltaKnowledge from this passage:\n\n" +
      '"Cache eviction is dominated by access pattern, not by replacement policy. ' +
      "When the working set fits in cache, LRU and LFU perform identically. " +
      "When the working set is much larger than cache, both degrade to near-random. " +
      "The crucial transition happens at the threshold where working set ≈ cache size; " +
      "in this regime LFU outperforms LRU on power-law workloads (e.g. web traffic with " +
      "heavy-tail popularity), while LRU wins on bursty access patterns where recency " +
      'matters more than frequency. Belady\'s optimal algorithm is the upper bound but requires future knowledge."',
    maxTokens: 1024,
    score: (a) => {
      const parsed = tryParseJson(a);
      if (!parsed || typeof parsed !== "object") return 0;
      const obj = parsed as Record<string, unknown>;
      let s = 0;

      /* === БАЗОВАЯ СХЕМА: 0.20 === */
      if (typeof obj.domain === "string" && obj.domain.length >= 2) s += 0.04;
      if (typeof obj.chapterContext === "string" && obj.chapterContext.length >= 10) s += 0.03;
      if (typeof obj.essence === "string" && obj.essence.length >= 30) s += 0.05;
      if (typeof obj.cipher === "string" && obj.cipher.length >= 5) s += 0.03;
      if (typeof obj.proof === "string" && obj.proof.length >= 10) s += 0.03;
      if (Array.isArray(obj.tags) && (obj.tags as unknown[]).length >= 1) s += 0.02;

      /* === AURA: 0.15 === (≥2 валидных флага) */
      const validAura = new Set(["authorship", "specialization", "revision", "causality"]);
      if (Array.isArray(obj.auraFlags)) {
        const flags = (obj.auraFlags as unknown[]).filter(
          (f) => typeof f === "string" && validAura.has(f),
        );
        const unique = new Set(flags);
        if (unique.size >= 2) s += 0.15;
        else if (unique.size === 1) s += 0.05;
      }

      /* === RELATIONS (топология): 0.25 === */
      if (Array.isArray(obj.relations)) {
        const rels = obj.relations as Array<Record<string, unknown>>;
        const validRels = rels.filter((r) => {
          if (!r || typeof r !== "object") return false;
          const ok = typeof r.subject === "string" && typeof r.predicate === "string" && typeof r.object === "string";
          if (!ok) return false;
          const pred = (r.predicate as string).trim().toLowerCase();
          /* Запрет copula-предикатов. */
          return !/^(is|was|are|were|has|have|had|be|been)$/.test(pred);
        });
        if (validRels.length >= 1) s += 0.10;
        if (validRels.length >= 2) s += 0.05;
        if (validRels.length >= 3) s += 0.05;

        /* Бонус за конкретные релевантные триплеты. */
        const relStr = JSON.stringify(validRels).toLowerCase();
        if (/lru|lfu|cache|eviction|working\s*set|belady|access\s*pattern/.test(relStr)) s += 0.05;
      }

      /* === ФАКТ-ЯКОРЯ из текста: 0.30 === */
      const allText = JSON.stringify(parsed).toLowerCase();
      const anchors = [
        /lru/, /lfu/, /cache/, /eviction|replacement/,
        /working\s*set/, /access\s*pattern|recency|frequency/,
        /power[\s-]*law|heavy[\s-]*tail/, /belady|optimal/,
        /threshold|transition/,
      ];
      const hits = anchors.filter((rx) => rx.test(allText)).length;
      s += Math.min(0.30, hits * 0.04); /* 9 якорей × 0.04 = ≤ 0.36 → cap 0.30 */

      /* === CIPHER: 0.05 === (MECHANICUS-style operators) */
      if (typeof obj.cipher === "string") {
        const c = obj.cipher;
        if (/->|>>|==|\+|NO:/.test(c)) s += 0.05;
      }

      /* === DOMAIN валидность: 0.05 === */
      const validDomains = new Set([
        "ui", "web", "mobile", "ux", "perf", "arch", "copy", "seo",
        "research", "data", "security", "devops", "ai", "business",
        "science", "psychology", "philosophy", "engineering", "medicine",
        "economics", "other",
      ]);
      if (typeof obj.domain === "string" && validDomains.has(obj.domain)) s += 0.05;

      /* === ШТРАФЫ === */
      /* Галлюцинации (фактов нет в источнике). */
      if (/redis|memcached|varnish/.test(allText)) s -= 0.10;
      if (/clock\s*algorithm|second\s*chance|arc/.test(allText)) s -= 0.05;
      /* Markdown fences вместо чистого JSON. */
      if (a.includes("```")) s -= 0.05;

      return Math.max(0, Math.min(1, s));
    },
  },

  {
    /* Production-релевант: en→ru, главный путь импорта англ.книг. */
    id: "translator-en-ru",
    role: "translator",
    description: "Перевод EN→RU технического абзаца.",
    whyImportant:
      "Большинство технических книг в библиотеке — на английском. Перевод EN→RU — основной production-путь. Тест проверяет: 1) сохранение чисел/терминов (O(n log n), Δ); 2) отсутствие meta-комментариев («Here is the translation:»); 3) живой русский без кальки.",
    system: TRANSLATE_TO_RU_SYSTEM_PROMPT,
    user:
      "Translate to Russian, preserve all numbers and notations exactly:\n\n" +
      "\"Comparison-based sorting algorithms have a lower bound of Ω(n log n) on the number of comparisons. " +
      "Counting sort breaks this bound by exploiting the integer structure of keys, achieving O(n + k) time " +
      "where k is the range of input values. The trade-off is space: counting sort needs Θ(k) auxiliary memory.\"",
    maxTokens: 384,
    score: (a) => {
      const ruChars = (a.match(/[а-яА-ЯёЁ]/g)?.length ?? 0);
      const enLetters = (a.match(/[a-zA-Z]/g)?.length ?? 0);
      let s = 0;

      /* 1. Должен быть на русском (≥80% букв кириллица среди буквенных). */
      const totalLetters = ruChars + enLetters;
      if (totalLetters >= 50 && ruChars / totalLetters >= 0.85) s += 0.30;
      else if (totalLetters >= 50 && ruChars / totalLetters >= 0.70) s += 0.15;

      /* 2. Сохранение точных нотаций. */
      if (/Ω\s*\(\s*n\s*log\s*n\s*\)/i.test(a) || /omega\s*\(\s*n\s*log\s*n\s*\)/i.test(a)) s += 0.15;
      if (/O\s*\(\s*n\s*\+\s*k\s*\)/i.test(a)) s += 0.10;
      if (/Θ\s*\(\s*k\s*\)/i.test(a) || /\bθ\s*\(\s*k\s*\)/i.test(a) || /theta\s*\(\s*k\s*\)/i.test(a)) s += 0.10;

      /* 3. Корректные термины (не машинный калькь). */
      if (/(сравн|основан\s+на\s+сравн)/i.test(a)) s += 0.05;
      if (/(сортировк)/i.test(a))                  s += 0.05;
      if (/(нижн\w+\s+границ|нижняя\s+оценк)/i.test(a)) s += 0.05;
      if (/подсчет|подсчёт/i.test(a)) s += 0.05; /* "counting sort" → "сортировка подсчётом" */
      if (/целочисл|целые\s+числ/i.test(a)) s += 0.03;
      if (/память|памяти|пространств/i.test(a)) s += 0.02;

      /* === ШТРАФЫ === */
      /* Meta-комментарии (BAD). */
      if (/(here\s+is\s+the\s+translation|вот\s+перевод|перевод\s+текста\s*:)/i.test(a)) s -= 0.30;
      /* Markdown fences. */
      if (/```/.test(a)) s -= 0.10;
      /* Слишком короткий или раздутый. */
      if (a.length < 100) s -= 0.20;
      if (a.length > 1500) s -= 0.10;
      /* Не перевёл вообще (английский остался в большинстве). */
      if (totalLetters > 50 && enLetters / totalLetters > 0.30) s -= 0.20;

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
      const trimmed = a.trim();
      if (trimmed.length < 10) return 0; /* пустой/слишком короткий ответ */

      const ukChars = (a.match(/[іїєґІЇЄҐ]/g)?.length ?? 0);
      const ruOnly  = (a.match(/[ыэъ]/gi)?.length ?? 0); /* буквы которых нет в укр. */
      const len = a.replace(/\s+/g, " ").trim().length;

      let s = 0;
      /* Реальное укр.письмо: должны быть і/ї/є. */
      if (ukChars >= 5)         s += 0.35;
      else if (ukChars >= 2)    s += 0.20;
      else                       s += 0.0; /* нет укр.букв — провал */

      /* Не русский. */
      if (ruOnly === 0 && ukChars >= 1) s += 0.20; /* «нет ru-букв» поощряем только если есть укр. */
      else if (ruOnly <= 2)             s += 0.10;
      else                              s -= 0.20;

      /* Содержательность. */
      if (len >= 100 && len <= 800) s += 0.15;
      if (/дейкстр/i.test(a))         s += 0.10;
      if (/(граф|шлях|відстан|вершин)/i.test(a)) s += 0.10;
      if (/o\([^)]+\)|складніст|n\^?2|log\s*n/i.test(a)) s += 0.10;

      return Math.max(0, Math.min(1, s));
    },
  },
  /* ─── Crystallizer: Russian language test ──────────────────────────── */
  {
    id: "crystallizer-ru-mendeleev",
    role: "crystallizer",
    thinkingFriendly: true, /* crystallizer = ДА критично: извлечение фактов на русском */
    description: "Извлечь факты из русскоязычного текста.",
    whyImportant:
      "Библиотека содержит книги на русском. Если модель плохо работает с кириллицей — кристаллизатор пропустит факты.",
    system:
      "Извлеки структурированные знания из текста. Ответ ТОЛЬКО валидный JSON: " +
      '{"facts":[string],"entities":[{"name":string,"type":string}]}.',
    user:
      'Извлеки знания из фрагмента:\n\n' +
      '"Дмитрий Менделеев в 1869 году составил Периодическую таблицу химических элементов. ' +
      "Он работал профессором в Санкт-Петербургском университете. " +
      'Таблица предсказала свойства трёх ещё не открытых элементов: галлия, скандия и германия."',
    maxTokens: 384,
    score: (a) => {
      const parsed = tryParseJson(a);
      if (!parsed || typeof parsed !== "object") return 0;
      const obj = parsed as { facts?: unknown[]; entities?: unknown[] };
      if (!Array.isArray(obj.facts) || !Array.isArray(obj.entities)) return 0.15;

      let s = 0.2;
      if (obj.facts.length >= 3) s += 0.15;
      else if (obj.facts.length >= 2) s += 0.08;
      if (obj.entities.length >= 3) s += 0.15;
      else if (obj.entities.length >= 2) s += 0.08;

      const allText = JSON.stringify(parsed).toLowerCase();
      if (/менделеев|mendeleev/.test(allText)) s += 0.1;
      if (/1869/.test(allText)) s += 0.075;
      if (/периодическ|periodic/i.test(allText)) s += 0.075;
      if (/галлий|gallium|скандий|scandium|германий|germanium/.test(allText)) s += 0.1;
      if (/петербург|petersburg/.test(allText)) s += 0.075;

      return Math.max(0, Math.min(1, s));
    },
  },

  {
    id: "lang-detect-uk",
    role: "lang_detector",
    description: "Відрізнити українську від російської (антибайєс на кирилицю).",
    whyImportant:
      "Lang-detector часто путає UK і RU через спільну кирилицю. " +
      "Цей тест відловлює моделі, що відповідають «ru» на будь-який кириличний текст. " +
      "Дисципліна використовує абзац з українськими маркерами (є, ї, дозволяє, невід'ємною) " +
      "яких не існує в російській мові. Такі моделі зламають pipeline обробки українських книг.",
    system:
      LANG_DETECT_SYSTEM_PROMPT,
    user:
      "What language is this text?\n\n" +
      "«Штучний інтелект є невід'ємною частиною сучасного технологічного прогресу. " +
      "Алгоритми машинного навчання дозволяють комп'ютерам вчитися з даних та вирішувати " +
      "складні завдання без явного програмування. Системи глибокого навчання досягають " +
      "вражаючих результатів у галузях розпізнавання мовлення, обробки зображень та " +
      "обробки природної мови.»",
    maxTokens: 16,
    score: ukLangScore,
  },
  {
    id: "lang-detect-en",
    role: "lang_detector",
    description: "Распознать английский (контроль).",
    whyImportant:
      "Контрольный тест: english не должен вызывать проблем. Если и здесь модель промахивается — она сломана.",
    system:
      LANG_DETECT_SYSTEM_PROMPT,
    user:
      "What language is this text?\n\n" +
      "«The depth-first search algorithm traverses the tree starting from the root node. " +
      "It explores each branch completely before backtracking to explore other branches. " +
      "This approach uses a stack data structure, either explicitly or via the call stack.»",
    maxTokens: 16,
    score: (a) => {
      const t = a.trim().toLowerCase().replace(/[^a-z]/g, "");
      if (t === "en" || t === "english") return 1.0;
      if (t.startsWith("en"))             return 0.85;
      return 0.0;
    },
  },

  {
    /* Production-aligned: vision_meta = обложка → STRICT JSON.
     * Здесь fixture минимальный, но проверяется именно жёсткое следование
     * формату вывода и отсутствие prose. */
    id: "vision_meta-strict-json",
    role: "vision_meta",
    description: "Vision-модель должна вернуть STRICT JSON с описанием изображения.",
    whyImportant:
      "Vision-meta извлекает метаданные обложки в JSON для каталога. Самая частая поломка — " +
      "модель пишет prose вместо JSON, добавляет markdown fences или комментарии. " +
      "Тест проверяет дисциплину формата: parsable JSON с предсказуемыми полями.",
    system:
      "You are a forensic image analyzer. Output STRICT JSON only. NO prose, NO markdown.\n" +
      "Schema: {\"primary_color\":\"red|blue|green|yellow|white|black|other\",\"shape\":\"rectangle|circle|triangle|other\",\"has_border\":boolean,\"confidence\":0.0-1.0}",
    user: "Analyze this image and output the JSON.",
    imageUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAFAAAAAeCAIAAAA0IQ7mAAAAUklEQVR4nO3PwQkAIAwEweu/MrvSjxVIArLZ5d4hk2QNW9Yek2B6gukJpieYXjM4eV/XR4JrzwsWLFhw7UeCa88LZoP/SzA9wfQE0xNM74JH7QAkJZohvhUzSwAAAABJRU5ErkJggg==",
    maxTokens: 128,
    score: (a) => {
      const parsed = tryParseJson(a);
      if (!parsed || typeof parsed !== "object") return 0;
      const obj = parsed as Record<string, unknown>;
      let s = 0;

      /* Структура */
      if (typeof obj.primary_color === "string") s += 0.20;
      if (typeof obj.shape === "string") s += 0.20;
      if (typeof obj.has_border === "boolean") s += 0.15;
      if (typeof obj.confidence === "number" && obj.confidence >= 0 && obj.confidence <= 1) s += 0.10;

      /* Семантика */
      const c = String(obj.primary_color ?? "").toLowerCase();
      const sh = String(obj.shape ?? "").toLowerCase();
      if (c === "red") s += 0.20;
      if (sh === "rectangle" || sh === "square") s += 0.15;

      /* Штрафы */
      if (a.includes("```")) s -= 0.15;
      if (/^[\s\S]{0,30}\{/.test(a) && !/^\{/.test(a.trim())) s -= 0.05; /* prose перед JSON */

      return Math.max(0, Math.min(1, s));
    },
  },

  {
    /* Production-aligned: vision_ocr = картинка → plain text (никакого JSON,
     * никаких markdown, чистый текст). */
    id: "vision_ocr-plain-text",
    role: "vision_ocr",
    description: "Vision-OCR должен вернуть plain text — никакого JSON или markdown.",
    whyImportant:
      "OCR sканированных страниц требует чистого plain text для последующего chunking. " +
      "Если модель добавит JSON, markdown fences или prose-обёртку («Here is the text:») — " +
      "pipeline сломается. Тест проверяет дисциплину plain-text-вывода.",
    system:
      "Extract any visible text from this image as plain text only. " +
      "If there is no text, output the literal string: NO_TEXT. " +
      "No JSON, no markdown, no fences, no commentary, no quotes.",
    user: "Extract text:",
    imageUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAFAAAAAeCAIAAAA0IQ7mAAAAUklEQVR4nO3PwQkAIAwEweu/MrvSjxVIArLZ5d4hk2QNW9Yek2B6gukJpieYXjM4eV/XR4JrzwsWLFhw7UeCa88LZoP/SzA9wfQE0xNM74JH7QAkJZohvhUzSwAAAABJRU5ErkJggg==",
    maxTokens: 64,
    score: (a) => {
      const t = a.trim();
      let s = 0;

      /* Главный сигнал: картинка БЕЗ текста — модель должна сказать NO_TEXT. */
      if (/no[_\s]?text/i.test(t)) s += 0.50;
      else if (t.length === 0)     s += 0.05; /* пустой ответ — допустимо но не идеал */

      /* === ШТРАФЫ за нарушение формата === */
      if (a.includes("```")) s -= 0.30; /* markdown fences */
      if (/^\s*\{/.test(a)) s -= 0.30;  /* JSON вместо plain text */
      if (/here\s+is\s+the\s+text|the\s+text\s+is/i.test(a)) s -= 0.20; /* prose-обёртка */
      if (/^['"]/.test(t) && /['"]$/.test(t)) s -= 0.10; /* кавычки вокруг */
      if (a.length > 200) s -= 0.20; /* раздул, галлюцинирует */

      /* Если модель сказала что-то вменяемое (даже если не идеально) */
      if (s <= 0 && t.length >= 1 && t.length <= 80 && !/[{}`]/.test(t)) s = 0.15;

      return Math.max(0, Math.min(1, s));
    },
  },

  {
    /* Production-aligned: vision_illustration = картинка + контекст главы
     * → описание для RAG. Это для индексации в Qdrant. */
    id: "vision_illustration-with-context",
    role: "vision_illustration",
    description: "Описать иллюстрацию ИСПОЛЬЗУЯ контекст главы (для RAG-индекса).",
    whyImportant:
      "Иллюстрации в книгах извлекаются и описываются для индексации в Qdrant. " +
      "Если модель ИГНОРИРУЕТ контекст главы и описывает картинку как изолированную " +
      "геометрию — описание бесполезно для тематического поиска. Тест проверяет: " +
      "1) использует ли модель контекст; 2) даёт ли тематически связный текст; " +
      "3) не путает чисто графический примитив с осмысленным предметом.",
    system:
      "You describe technical-book illustrations for a knowledge-base index. " +
      "Use the chapter context to interpret the image — don't describe pixels in isolation. " +
      "If the image is a simple shape, anchor it to the chapter topic if plausible " +
      "(e.g. 'red rectangular block — possibly a memory page or a register'). " +
      "Output 1-3 sentences of plain prose. No JSON, no markdown.",
    user:
      "**Chapter context:** Computer architecture — memory hierarchy and address spaces. " +
      "The chapter discusses how the OS represents physical memory as a sequence of pages.\n\n" +
      "Describe this illustration in the context of the chapter:",
    imageUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAFAAAAAeCAIAAAA0IQ7mAAAAUklEQVR4nO3PwQkAIAwEweu/MrvSjxVIArLZ5d4hk2QNW9Yek2B6gukJpieYXjM4eV/XR4JrzwsWLFhw7UeCa88LZoP/SzA9wfQE0xNM74JH7QAkJZohvhUzSwAAAABJRU5ErkJggg==",
    maxTokens: 256,
    score: (a) => {
      const lower = a.toLowerCase();
      let s = 0;

      /* === БАЗА: видит цвет и форму (без этого — слепая модель) === */
      if (/red|красн/.test(lower))                   s += 0.10;
      if (/rectangle|rect|square|block|квадрат|прямоуг/.test(lower)) s += 0.10;

      /* === КЛЮЧЕВОЕ: использует ли контекст главы === */
      const usesContext = /memory|page|address|register|architecture|hierarchy|operating\s*system|os\s|память|страниц|адрес/.test(lower);
      if (usesContext) s += 0.40;

      /* === Связность текста (не просто список слов) === */
      const sentences = (a.match(/[.!?]+\s/g) || []).length;
      if (sentences >= 1 && sentences <= 4) s += 0.15;
      if (a.length >= 50 && a.length <= 600) s += 0.10;

      /* === Тематические якоря === */
      if (/possibly|could\s+represent|may\s+be|could\s+be|может\s+представ|возможно/.test(lower)) s += 0.10;

      /* === ШТРАФЫ === */
      if (a.includes("```"))  s -= 0.15;
      if (/^\s*\{/.test(a))    s -= 0.20; /* JSON вместо prose */
      if (/here\s+is|the\s+image\s+shows/i.test(a)) s -= 0.05; /* meta-обёртка */
      /* Слишком короткое (<30 chars) или раздуто (>700) */
      if (a.length < 30) s -= 0.20;
      if (a.length > 800) s -= 0.10;

      return Math.max(0, Math.min(1, s));
    },
  },

  /* ─── Vision_meta: cover EN — обложка с английским заголовком ────────
   * Production: книги в библиотеке на английском нуждаются в извлечении
   * заголовка/автора/года из обложки. Здесь fixture минимальный (red rect),
   * но мы проверяем способность модели выдавать чистый JSON под английский
   * mental model. */
  {
    id: "vision_meta-cover-en",
    role: "vision_meta",
    description: "Vision-meta cover (English schema) → strict JSON metadata.",
    whyImportant:
      "Английские книги в библиотеке — основной поток. Модель должна выдавать " +
      "metadata schema {title, author, year, language='en'} строго в JSON, " +
      "без prose. Тест на формат — критичен для каталога.",
    system:
      "You are a book-cover analyzer. Output STRICT JSON only. NO prose, NO markdown.\n" +
      "Schema: {\"title\":string|null,\"author\":string|null,\"year\":number|null,\"language\":\"en\"|\"ru\"|\"uk\"|\"unknown\",\"confidence\":0.0-1.0}",
    user: "Analyze this book cover and output the JSON metadata.",
    imageUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAFAAAAAeCAIAAAA0IQ7mAAAAUklEQVR4nO3PwQkAIAwEweu/MrvSjxVIArLZ5d4hk2QNW9Yek2B6gukJpieYXjM4eV/XR4JrzwsWLFhw7UeCa88LZoP/SzA9wfQE0xNM74JH7QAkJZohvhUzSwAAAABJRU5ErkJggg==",
    maxTokens: 128,
    score: (a) => {
      const parsed = tryParseJson(a);
      if (!parsed || typeof parsed !== "object") return 0;
      const obj = parsed as Record<string, unknown>;
      let s = 0;

      /* Структура: 5 полей по схеме. */
      if ("title" in obj) s += 0.15;
      if ("author" in obj) s += 0.15;
      if ("year" in obj) s += 0.10;
      if (typeof obj.language === "string" &&
          ["en", "ru", "uk", "unknown"].includes(obj.language)) s += 0.20;
      if (typeof obj.confidence === "number" && obj.confidence >= 0 && obj.confidence <= 1) s += 0.10;

      /* Сема: на красном квадрате честная модель должна сказать "не вижу обложки".
       * Хороший знак — title=null, language=unknown, confidence низкая. */
      if (obj.title === null || obj.title === "") s += 0.10;
      if (obj.language === "unknown") s += 0.10;
      if (typeof obj.confidence === "number" && obj.confidence < 0.5) s += 0.05;

      /* === Штрафы === */
      if (a.includes("```")) s -= 0.20;
      if (/^[\s\S]{0,30}\{/.test(a) && !/^\{/.test(a.trim())) s -= 0.10;

      return Math.max(0, Math.min(1, s));
    },
  },
];
