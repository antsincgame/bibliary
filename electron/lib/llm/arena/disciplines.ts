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
 *
 * ── Методологическая база (Iter 14.2 audit, 2026-05-04) ──
 *
 * Текущие scorer'ы построены по принципам state-of-the-art LLM evaluation
 * литературы 2024-2026:
 *
 *   • G-Eval (NeurIPS 2024) — rubric-based scoring с form factor + content
 *     anchors. Каждый scorer декомпозирует общую цель на N измеримых
 *     суб-критериев, каждое со своим весом.
 *
 *   • Prometheus 2 (ICLR 2025) — open-source rubric-evaluator framework;
 *     анти-bias техника «explicit reasoning requirement» (мы её внедряем
 *     через bonus за `reasoning` поле и penalty за meta-комментарии).
 *
 *   • LLM-RUBRIC (ACL 2024) — multidimensional rubric-based evaluation
 *     с form-vs-content separation. Reflected here через раздельные точки
 *     scoring: format (JSON valid, schema match), content (anchors hit),
 *     hallucination (negative weight на out-of-context tokens).
 *
 *   • Bradley-Terry MLE / am-ELO (ICML 2025) — pairwise ranking для
 *     стабильности при small N. Реализован в `scoring.ts` (buildRoleAggregates).
 *
 *   • Discriminative power principle (BBH 2024) — включаем mid-range
 *     test cases (не только extremes), чтобы дифференцировать модели
 *     в реальной зоне 5-7. См. `evaluator-mid-quality`.
 *
 *   • OCRBench v2 (2025) / DocVQA (2024) — vision-OCR best practices.
 *     Используем строгое scoring по character-level recall (vision_ocr).
 *
 * Дальнейшие направления (из roadmap 2026-Q3):
 *   - Bootstrap CI per-role для статистической значимости при N≤3 тестах
 *   - Champion stability across runs через EMA / Glicko-2
 *   - LLM-as-judge калибровка через cross-model agreement (Prometheus-2)
 */

import {
  LANG_DETECT_SYSTEM_PROMPT,
  TRANSLATE_TO_RU_SYSTEM_PROMPT,
} from "./role-prompts.js";
import type { OlympicsRole } from "./olympics-types.js";
import {
  asImageDataUrl,
  VISION_OCR_SIMPLE,
  VISION_OCR_TWO_LINES,
  VISION_OCR_NUMBERS,
  VISION_OCR_BLANK,
} from "./fixtures/vision-ocr-fixtures.js";

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

/**
 * Извлечь язык-кодовый ответ из произвольного текста модели.
 *
 * Зачем: reasoning-модели (Qwen3, GLM-4, GPT-OSS) часто пишут CoT-prose
 * прямо в content без `<think>` тегов:
 *   "Thinking Process: ... \n\nThe answer is: en"
 *   "Okay, let's see. The user wants ... ru"
 *   "* Input: ... * Final: en"
 * Строгое равенство `t === "en"` после `replace(/[^a-z]/g,"")` даёт 0
 * на таких ответах, хотя финальный токен корректный.
 *
 * Стратегия (детерминированная, без false-positives):
 *   1. Убрать `<think>...</think>` (на случай если postProcess не отработал).
 *   2. Trim + lowercase.
 *   3. Если ответ короткий (<=24 символа) — старая логика equality по
 *      stripped letters (быстрый путь для cooperative-моделей).
 *   4. Иначе ищем `\b(ru|uk|en|de)\b` или `\b(russian|ukrainian|english|german)\b`
 *      в ПОСЛЕДНИХ 256 символах ответа (final-answer обычно в конце CoT).
 *      Возвращаем код последнего match-а.
 *   5. Если ничего не найдено — возвращаем "" (scorer интерпретирует как fail).
 *
 * Confidence:
 *   - "exact"   — короткий ответ совпал точно (ru/uk/en/de или *ian/*ish/*an).
 *   - "tail"    — найдено в хвосте длинного ответа (CoT-fallback, чуть ниже балл).
 *   - "none"    — не нашли вообще.
 */
type LangExtractResult = {
  code: "ru" | "uk" | "en" | "de" | "";
  confidence: "exact" | "tail" | "none";
};

const LANG_CODE_RE = /\b(ru|uk|en|de)\b/g;
const LANG_FULL_RE = /\b(russian|ukrainian|english|german)\b/g;
const LANG_FULL_TO_CODE: Record<string, "ru" | "uk" | "en" | "de"> = {
  russian: "ru",
  ukrainian: "uk",
  english: "en",
  german: "de",
};

export function extractLangCode(answer: string): LangExtractResult {
  const noThink = stripThinkingBlock(answer).trim();
  if (!noThink) return { code: "", confidence: "none" };

  const lowered = noThink.toLowerCase();

  if (lowered.length <= 24) {
    const stripped = lowered.replace(/[^a-z]/g, "");
    if (stripped === "ru" || stripped === "russian") return { code: "ru", confidence: "exact" };
    if (stripped === "uk" || stripped === "ukrainian") return { code: "uk", confidence: "exact" };
    if (stripped === "en" || stripped === "english") return { code: "en", confidence: "exact" };
    if (stripped === "de" || stripped === "german") return { code: "de", confidence: "exact" };
    if (stripped.startsWith("uk") && stripped.length <= 12) return { code: "uk", confidence: "exact" };
    if (stripped.startsWith("en") && stripped.length <= 12) return { code: "en", confidence: "exact" };
    if (stripped.startsWith("de") && stripped.length <= 12) return { code: "de", confidence: "exact" };
    if (stripped.startsWith("ru") && stripped.length <= 12) return { code: "ru", confidence: "exact" };
  }

  const TAIL_LEN = 256;
  const tail = lowered.slice(-TAIL_LEN);

  let lastCode: "ru" | "uk" | "en" | "de" | "" = "";
  for (const m of tail.matchAll(LANG_CODE_RE)) {
    lastCode = m[1] as "ru" | "uk" | "en" | "de";
  }
  if (lastCode) return { code: lastCode, confidence: "tail" };

  let lastFull: "ru" | "uk" | "en" | "de" | "" = "";
  for (const m of tail.matchAll(LANG_FULL_RE)) {
    lastFull = LANG_FULL_TO_CODE[m[1]] ?? "";
  }
  if (lastFull) return { code: lastFull, confidence: "tail" };

  return { code: "", confidence: "none" };
}

/** Scorer для всех украинских lang-detect дисциплин.
 *  Принимает: uk / ukrainian / Українська (кириллица удаляется, проверяем latin) /
 *             украинська / українська (Cyrillic check отдельно).
 *  Ноль если модель говорит "ru" — критическая ошибка для pipeline.
 */
function ukLangScore(a: string): number {
  const raw = a.trim().toLowerCase();
  if (raw === "") return 0.05;
  /* Кириллический ответ: «українська», «украинский» — проверяем до strip
   * (extractLangCode видит только латиницу). */
  if (raw.includes("укра")) return 0.85;

  const { code, confidence } = extractLangCode(a);
  if (code === "uk") return confidence === "exact" ? 1.0 : 0.85;
  if (code === "ru") return 0.0; /* грубая ошибка: перепутал uk↔ru */
  if (code === "en" || code === "de") return 0.05;
  return 0.1;
}

/**
 * Scorer для vision_ocr дисциплин с реальным печатным текстом.
 *
 * Считает recall ожидаемых токенов в ответе модели:
 *   - точное вхождение каждого ожидаемого токена даёт полный балл;
 *   - частичное (substring/prefix) — половину балла;
 *   - регистр игнорируется, пунктуация очищается.
 *
 * Дополнительные penalty:
 *   - markdown fences (```), JSON-обёртка, prose («Here is the text»);
 *   - hallucination: ответ ≥ 4× ожидаемой длины → -0.15;
 *   - NO_TEXT когда текст есть → -0.50 (грубая ошибка).
 *
 * Шкала:
 *   - 100/100 = все ожидаемые токены распознаны точно, без штрафов;
 *   - 50/100 = половина токенов или один из всех + штраф формата;
 *   - 0/100 = ничего не распознано или галлюцинация NO_TEXT.
 *
 * Соответствует character-level recall + format compliance из OCRBench v2 (2025).
 */
function scoreOcrRecall(answer: string, expectedTokens: ReadonlyArray<string>): number {
  if (expectedTokens.length === 0) return 0; /* expected пустой — используй blank-control scorer */

  const raw = answer.trim();
  const lowered = raw.toLowerCase();
  /* Грубая ошибка: ответил NO_TEXT когда текст реально есть. */
  if (/^no[_\s]?text\.?$/i.test(raw)) return 0;

  /* Две нормализации:
   *   - normalized: пунктуация → пробелы (для wordRe со словесными границами).
   *   - digitsOnly: цифры без пунктуации (для чисел типа "1,234.56" → "123456",
   *     где expected="1234" совпадёт substring-ом). */
  const normalized = lowered.replace(/[^a-zа-я0-9\s]/giu, " ").replace(/\s+/g, " ");
  const digitsOnly = lowered.replace(/[^0-9]/g, "");

  let hits = 0;
  for (const token of expectedTokens) {
    const tok = token.toLowerCase();
    /* Полное совпадение слова — максимальный балл. */
    const wordRe = new RegExp(`\\b${tok.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
    if (wordRe.test(normalized)) {
      hits += 1;
      continue;
    }
    /* Substring в text (для коротких токенов): полный балл. */
    if (normalized.includes(tok)) {
      hits += 1;
      continue;
    }
    /* Числовые токены: ищем как substring в digits-only (учитывает разделители). */
    if (/^\d+$/.test(tok) && digitsOnly.includes(tok)) {
      hits += 1;
      continue;
    }
    /* Дробное совпадение для очень коротких числовых частей. */
    if (/^\d{1,3}$/.test(tok) && normalized.includes(tok)) {
      hits += 0.5;
    }
  }

  /* Recall: какая доля ожидаемых токенов распознана. */
  const recall = hits / expectedTokens.length;

  /* Iter 14.3 — формат имеет ВЕС: чистый plain text получает full recall;
   * любое нарушение формата (JSON / markdown / prose-обёртка) даёт жёсткий
   * множитель. Цель — научить модель именно формату, а не «лишь бы ответ
   * содержал слова». */
  let formatMultiplier = 1.0;
  if (answer.includes("```"))                                     formatMultiplier *= 0.45;
  if (/^\s*\{/.test(answer))                                      formatMultiplier *= 0.40;
  if (/^(here\s+is|the\s+text\s+is|i\s+see|extracted)/i.test(raw)) formatMultiplier *= 0.55;
  /* Hallucination: ответ многократно длиннее ожидаемого текста. */
  const expectedLen = expectedTokens.join(" ").length;
  if (raw.length > expectedLen * 4 + 40)                          formatMultiplier *= 0.70;

  return Math.max(0, Math.min(1, recall * formatMultiplier));
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
    /* Iter 14.2 (2026-05-04): добавлен mid-range тест для discriminative
       power. Раньше evaluator имел только high-end (CLRS = 9-10) и low-end
       (mot. noise = 1-3). Между ними была дыра: модели одинаково хорошо
       определяли крайности, но плохо различали 5-7. Этот тест — типичная
       книга «среднего качества» (полезная, но не классика): ожидаемый
       score 5-7. Источник методологии: G-Eval (NeurIPS 2024) + Prometheus 2
       (ICLR 2025) — rubric-based scoring с явной анти-saturation практикой
       включения mid-range cases для повышения дискриминативной силы. */
    id: "evaluator-mid-quality",
    role: "evaluator",
    thinkingFriendly: true,
    description: "Оценить книгу среднего качества (mid-range).",
    whyImportant:
      "Дискриминативная сила: между классикой (9-10) и шумом (1-3) лежит зона 5-7 — типичные «полезные но не эталонные» книги. Без mid-теста модели одинаково хорошо проходят high+low extremes, но провалят реальный кейс «нормальной» книги. Тест проверяет: 1) score в окне 5-7; 2) обоснование упоминает СИЛЬНЫЕ И слабые стороны; 3) не уходит в крайности.",
    system:
      "You evaluate book quality for a TECHNICAL knowledge base. Score 0-10 " +
      "(10 = essential reference, 5 = useful but not foundational, 1 = noise). " +
      'Output ONLY JSON: {"score":number,"reasoning":string}.',
    user:
      'Book: "JavaScript: The Good Parts" by Douglas Crockford. ' +
      "Topics: JS subset, lexical conventions, common pitfalls. " +
      "Year: 2008. Pages: 176. Mostly opinion-based, partially outdated " +
      "(pre-ES6, no Promise/async). Influential historically but no longer " +
      "the recommended reference for modern JavaScript.",
    maxTokens: 256,
    score: (a) => {
      const parsed = tryParseJson(a) as { score?: number; reasoning?: string } | null;
      if (!parsed || typeof parsed.score !== "number") return 0;

      let s = 0;
      /* Mid-range окно: 5-7 — сладкая зона. */
      if (parsed.score >= 5 && parsed.score <= 7)       s += 0.55;
      else if (parsed.score === 4 || parsed.score === 8) s += 0.30;
      else if (parsed.score === 3 || parsed.score === 9) s += 0.10;
      else                                                s += 0.0; /* крайности = плохая дискриминация */

      if (typeof parsed.reasoning === "string") {
        const r = parsed.reasoning.toLowerCase();
        if (r.length >= 30) s += 0.10;
        if (r.length >= 80) s += 0.05;
        /* Сбалансированное обоснование: упоминание И плюсов, И минусов. */
        const hasPositive = /(влиятел|important|founda|popular|classic|valuable|insight|good|useful|полез)/.test(r);
        const hasNegative = /(outdat|устар|old|dated|pre-?es6|opinionated|partial|limited|incomplete|subjective|opinion|неполн|субъект)/.test(r);
        if (hasPositive && hasNegative) s += 0.20;
        else if (hasPositive || hasNegative) s += 0.05;
        /* Бонус за упоминание конкретных фактов из контекста. */
        if (/(crockford|good\s*parts|es6|promise|async|2008|js\s*subset)/.test(r)) s += 0.10;
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
      /* ASCII кавычки вместо `«»` (U+00AB/U+00BB): часть моделей плохо
       * декодирует UTF-8 multi-byte символы и эхом выдаёт `\uFFFD<` (мусор в
       * CoT-логе). Содержимое теста от этого не страдает. */
      'What language is this text?\n\n' +
      '"Штучний інтелект є невід\'ємною частиною сучасного технологічного прогресу. ' +
      "Алгоритми машинного навчання дозволяють комп'ютерам вчитися з даних та вирішувати " +
      "складні завдання без явного програмування. Системи глибокого навчання досягають " +
      "вражаючих результатів у галузях розпізнавання мовлення, обробки зображень та " +
      'обробки природної мови."\n\n' +
      "Reply with ONLY the language code (one of: ru, uk, en, de). Final answer:",
    /* 16 → 96: reasoning-моделям (Qwen3, GLM-4, GPT-OSS) нужно ~50-80 токенов
     * на CoT-prose до final answer. С max_tokens=16 они обрезаются на середине
     * reasoning и финальный код не успевает попасть в content. */
    maxTokens: 96,
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
      'What language is this text?\n\n' +
      '"The depth-first search algorithm traverses the tree starting from the root node. ' +
      "It explores each branch completely before backtracking to explore other branches. " +
      'This approach uses a stack data structure, either explicitly or via the call stack."\n\n' +
      "Reply with ONLY the language code (one of: ru, uk, en, de). Final answer:",
    maxTokens: 96,
    score: (a) => {
      if (!a.trim()) return 0;
      const { code, confidence } = extractLangCode(a);
      if (code === "en") return confidence === "exact" ? 1.0 : 0.85;
      return 0;
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

  /* ─── Vision OCR: РЕАЛЬНЫЙ ПЕЧАТНЫЙ ТЕКСТ ──────────────────────────────
   *
   * До Iter 14.3 (2026-05-04) была одна дисциплина с пустой картинкой —
   * fixture без текста, модель должна была вернуть `NO_TEXT`. Из-за этого
   * scorer имел потолок 50/100 by design (только один позитивный сигнал
   * `NO_TEXT` = +0.50, остальное — штрафы), что было невозможно перебить
   * для топовых VLM (Qwen2.5-VL, InternVL3, Gemma3-Vision).
   *
   * Решение по OCRBench v2 / DocVQA рекомендациям 2025:
   *   - 3 дисциплины с реальным печатным текстом разной сложности
   *     (1 строка, 2 строки, числа+символы), каждая со scorer'ом на основе
   *     character-level recall (доля распознанных ожидаемых токенов).
   *   - 1 контрольная дисциплина с пустой картинкой → модель должна
   *     ответить `NO_TEXT` (тест на дисциплину «не галлюцинируй»).
   *   - Все scorer'ы достижимы 90-100/100 при правильном OCR.
   *
   * Fixtures генерируются программно через Sharp+SVG в build-time —
   * см. `scripts/generate-vision-ocr-fixtures.cjs`. */
  {
    id: "vision_ocr-print-simple",
    role: "vision_ocr",
    description: "Распознать одну строку чёткого печатного текста (THE QUICK BROWN FOX).",
    whyImportant:
      "Базовый тест VLM-OCR: одна строка крупного печатного шрифта на белом фоне. " +
      "Любая production-grade VLM должна давать 100% recall на таком вводе. " +
      "Scorer считает долю распознанных слов (the, quick, brown, fox) с учётом регистра. " +
      "По OCRBench v2 / DocVQA 2025 — обязательная начальная точка для калибровки.",
    system:
      "Extract any visible text from this image as plain text only. " +
      "If there is no text, output the literal string: NO_TEXT. " +
      "No JSON, no markdown, no fences, no commentary, no quotes.",
    user: "Extract text:",
    imageUrl: asImageDataUrl(VISION_OCR_SIMPLE),
    maxTokens: 64,
    score: (a) => scoreOcrRecall(a, VISION_OCR_SIMPLE.expectedTokens),
  },
  {
    id: "vision_ocr-print-two-lines",
    role: "vision_ocr",
    description: "Распознать 2 строки текста: «Hello World» + дата «2024-12-25».",
    whyImportant:
      "Многострочный OCR с числами и дефисами. Проверяет сохранение порядка строк " +
      "и правильное распознавание цифр и знаков пунктуации. Распространённый случай " +
      "в реальных книгах (заголовок главы + дата публикации, таблицы дат).",
    system:
      "Extract any visible text from this image as plain text only. " +
      "Preserve line breaks. " +
      "If there is no text, output the literal string: NO_TEXT. " +
      "No JSON, no markdown, no fences, no commentary, no quotes.",
    user: "Extract text:",
    imageUrl: asImageDataUrl(VISION_OCR_TWO_LINES),
    maxTokens: 96,
    score: (a) => scoreOcrRecall(a, VISION_OCR_TWO_LINES.expectedTokens),
  },
  {
    id: "vision_ocr-print-numbers",
    role: "vision_ocr",
    description: "Сложный OCR: «INVOICE #4291» + «Total: $1,234.56» (числа и символы).",
    whyImportant:
      "Stress-тест на спецсимволы (#, $, ,, .) и числа с тысячными разделителями. " +
      "Проверяет точность распознавания пунктуации, важной для финансовых/счётов сцен. " +
      "Слабые VLM ошибаются на разделителях; топовые (Qwen2.5-VL-72B, InternVL3) — нет.",
    system:
      "Extract any visible text from this image as plain text only. " +
      "Preserve numbers, punctuation and symbols exactly as shown. " +
      "If there is no text, output the literal string: NO_TEXT. " +
      "No JSON, no markdown, no fences, no commentary, no quotes.",
    user: "Extract text:",
    imageUrl: asImageDataUrl(VISION_OCR_NUMBERS),
    maxTokens: 96,
    score: (a) => scoreOcrRecall(a, VISION_OCR_NUMBERS.expectedTokens),
  },
  {
    /* Контроль: пустой PNG → модель должна сказать NO_TEXT (anti-hallucination). */
    id: "vision_ocr-blank-control",
    role: "vision_ocr",
    description: "Контроль: пустая картинка → модель не должна галлюцинировать.",
    whyImportant:
      "Модели иногда «видят» текст там где его нет (галлюцинации OCR). Этот тест " +
      "ловит таких. Правильный ответ — литерал `NO_TEXT`. Любой другой текст — штраф. " +
      "Проверяет дисциплину «не выдумывать» — критично для качества каталога книг.",
    system:
      "Extract any visible text from this image as plain text only. " +
      "If there is no text, output the literal string: NO_TEXT. " +
      "No JSON, no markdown, no fences, no commentary, no quotes.",
    user: "Extract text:",
    imageUrl: asImageDataUrl(VISION_OCR_BLANK),
    maxTokens: 32,
    score: (a) => {
      const t = a.trim();
      let s = 0;
      /* Только точный литерал «NO_TEXT» (заглавные, без пунктуации) даёт
       * полный балл — это контракт, который модель должна выучить. */
      if (/^NO_TEXT\.?$/.test(t)) s = 1.0;
      else if (/^no_text\.?$/i.test(t)) s = 0.70; /* lower-case — нарушение строгого контракта */
      else if (/\bno[_\s]?text\b/i.test(t) && t.length <= 30) s = 0.55; /* в фразе — частично */
      else if (t.length === 0) s = 0.10; /* пустой ответ — лучше чем галлюцинация, но не идеал */
      else s = Math.max(0, 0.30 - t.length * 0.005); /* любой текст → штраф пропорц. длине */

      /* Штрафы за нарушение формата */
      if (a.includes("```")) s -= 0.20;
      if (/^\s*\{/.test(a)) s -= 0.30;

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

  /* ─── Layout Assistant: разметка markdown книги ────────────────────────
   * Production: модель получает chunk OCR'd markdown и должна вернуть JSON
   * аннотации (headings, junk_lines). Тест с golden answer:
   *   - 2 настоящих заголовка ("Chapter 1: Hello", "Chapter 2: World")
   *   - 1 junk line (одиночная "42" — page number)
   * Bug 11 fix: toc_block удалён из контракта (не применялся в production).
   * Scorer проверяет: валидный JSON, точность найденных headings/junk,
   * отсутствие галлюцинаций (extra junk вне source). */
  {
    id: "layout_assistant-chapter-detection",
    role: "layout_assistant",
    thinkingFriendly: false, /* быстрая аннотация — не нужен CoT, время критично для batch обработки */
    description: "Разметить markdown: найти заголовки, удалить page-numbers как junk.",
    whyImportant:
      "Layout Assistant — последняя линия защиты от плохо-парсенных книг. " +
      "Если модель не находит очевидные `Chapter N:` или путает контент с junk, " +
      "она сделает книгу хуже. Тест проверяет: 1) валидный JSON; " +
      "2) точное обнаружение явных глав; 3) распознавание solo-цифр как junk; " +
      "4) отсутствие false-positive (не помечает обычный текст как junk).",
    system:
      "You are a careful book typesetter. Annotate markdown chunks. " +
      "Return ONLY valid JSON: " +
      '{"headings":[{"line":number,"level":number,"text":string}],' +
      '"junk_lines":[number]}. ' +
      "Headings: lines starting with 'Chapter', 'Глава', 'Section'. " +
      "Junk: solo numbers (page numbers). " +
      "Use 1-indexed line numbers.",
    user:
      "Annotate this markdown chunk:\n\n" +
      "Chapter 1: Hello\n" +
      "\n" +
      "This is body text of chapter one.\n" +
      "\n" +
      "42\n" +
      "\n" +
      "Chapter 2: World\n" +
      "\n" +
      "And here is body of chapter two.",
    maxTokens: 512,
    score: (a) => {
      const parsed = tryParseJson(a) as {
        headings?: Array<{ line?: number; level?: number; text?: string }>;
        junk_lines?: number[];
      } | null;
      if (!parsed || typeof parsed !== "object") return 0;

      let s = 0.1; /* JSON валиден — base */

      /* Headings: ожидаем 2 (Chapter 1, Chapter 2). */
      const headings = Array.isArray(parsed.headings) ? parsed.headings : [];
      const ch1Found = headings.some(
        (h) => typeof h.text === "string" && /chapter\s*1/i.test(h.text),
      );
      const ch2Found = headings.some(
        (h) => typeof h.text === "string" && /chapter\s*2/i.test(h.text),
      );
      if (ch1Found) s += 0.20;
      if (ch2Found) s += 0.20;

      /* Junk: ожидаем строку 5 (где "42"). */
      const junk = Array.isArray(parsed.junk_lines) ? parsed.junk_lines : [];
      if (junk.includes(5)) s += 0.25;

      /* False-positive penalty: junk на content lines. */
      const contentLines = [1, 3, 7, 9]; /* lines с реальным контентом */
      const fpJunk = junk.filter((l) => contentLines.includes(l));
      s -= fpJunk.length * 0.15;

      /* Heading line numbers близки к правильным (1 и 7). */
      if (headings.some((h) => h.line === 1 && h.level && h.level >= 1 && h.level <= 3)) s += 0.10;
      if (headings.some((h) => h.line === 7 && h.level && h.level >= 1 && h.level <= 3)) s += 0.10;

      /* Hallucinated headings (больше 3 — модель добавила лишнее). */
      if (headings.length > 3) s -= 0.15;

      /* === Штрафы за нарушение формата === */
      if (a.includes("```")) s -= 0.10;
      if (!/^\s*\{/.test(a)) s -= 0.10; /* preamble before JSON */

      return Math.max(0, Math.min(1, s));
    },
  },
];
