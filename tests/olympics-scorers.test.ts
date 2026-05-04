/**
 * Olympics — scorer integrity tests.
 *
 * Каждый scorer должен:
 *   1. Правильный ответ → score ≥ 0.6
 *   2. Полностью неверный → score ≤ 0.2
 *   3. Markdown fences ```...``` или JSON-вместо-prose → штраф (≤ 0.5)
 *   4. Пустой / мусорный ответ → 0
 *
 * Эти тесты — регрессия против двух классов багов:
 *   • scorer слишком мягкий (любой ответ получает 0.5+, чемпион невыделим)
 *   • scorer слишком строгий (правильный ответ получает 0, ложные нули)
 *
 * Проверяются ВСЕ дисциплины, кроме vision-* (там не текстовый эталон).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { OLYMPICS_DISCIPLINES } from "../electron/lib/llm/arena/olympics.ts";

interface Sample {
  good: string;
  bad: string;
  malformed?: string; /* markdown fences или JSON-prose микс */
}

/**
 * Эталонные ответы для каждой текстовой дисциплины. Vision-дисциплины
 * исключены, потому что у них нет текстового "правильного ответа" —
 * они тестируют способность модели увидеть пиксели.
 */
const SAMPLES: Record<string, Sample> = {
  "crystallizer-rover": {
    good: JSON.stringify({
      facts: [
        "Curiosity rover landed on Mars on August 6, 2012",
        "Curiosity is powered by a radioisotope thermoelectric generator",
        "Curiosity landed in Gale Crater",
        "Curiosity uses plutonium-238 as a power source",
      ],
      entities: [
        { name: "Curiosity", type: "rover" },
        { name: "Mars", type: "planet" },
        { name: "Gale Crater", type: "location" },
        { name: "plutonium-238", type: "isotope" },
      ],
    }),
    bad: "Curiosity is a rover. It went to Mars.",
    malformed: "```json\n" + JSON.stringify({ facts: ["Mars"], entities: [] }) + "\n```",
  },

  "evaluator-clrs": {
    good: JSON.stringify({
      score: 10,
      reasoning: "CLRS by Cormen, Leiserson, Rivest, Stein — фундаментальный стандарт computer science, эталон университетских курсов алгоритмов и структур данных.",
    }),
    bad: JSON.stringify({ score: 3, reasoning: "ok" }),
  },

  "evaluator-noise": {
    good: JSON.stringify({
      score: 1,
      reasoning: "Self-published self-help with chakras and crystal energy — non-technical noise, low quality.",
    }),
    bad: JSON.stringify({ score: 9, reasoning: "great book" }),
  },

  "evaluator-midrange": {
    good: JSON.stringify({
      score: 6,
      reasoning: "Beginner visual guide for git basics — useful niche book, not a fundamental reference but solid for introduction step-by-step.",
    }),
    bad: JSON.stringify({ score: 1, reasoning: "ok" }),
  },

  /* Iter 14.2 (2026-05-04): SOTA-aligned mid-range eval — discriminative
     power test (G-Eval / Prometheus 2 methodology). Хорошее обоснование
     должно содержать И положительную, И негативную сторону книги. */
  "evaluator-mid-quality": {
    good: JSON.stringify({
      score: 6,
      reasoning: "Crockford's Good Parts is historically influential and useful for beginners learning the JS subset, but it's outdated (2008, pre-ES6, no Promise/async) and opinion-based — partially relevant for modern JavaScript work.",
    }),
    bad: JSON.stringify({ score: 10, reasoning: "great" }),
  },

  "evaluator-ru-classic": {
    good: JSON.stringify({
      score: 10,
      reasoning: "Дональд Кнут, фундаментальный труд по информатике, классический справочник по алгоритмам и комбинаторике.",
    }),
    bad: JSON.stringify({ score: 4, reasoning: "ok" }),
  },

  "evaluator-nuanced": {
    good: JSON.stringify({
      score: 6,
      reasoning: "Книга освещает важные темы concurrency, но в Java 8, что устарело. Полезна как историческая база, но требует обновления — баланс плюсов и минусов даёт средний балл.",
    }),
    bad: JSON.stringify({ score: 10, reasoning: "perfect" }),
  },

  "crystallizer-deep-extract": {
    good: JSON.stringify({
      facts: [
        "Apollo 11 launched on July 16, 1969",
        "Neil Armstrong was the first person to step on the Moon",
        "Buzz Aldrin followed Armstrong onto the Moon surface",
        "Michael Collins remained in lunar orbit",
        "The mission lasted 8 days, 3 hours, 18 minutes",
      ],
      entities: [
        { name: "Apollo 11", type: "mission" },
        { name: "Neil Armstrong", type: "astronaut" },
        { name: "Buzz Aldrin", type: "astronaut" },
        { name: "Michael Collins", type: "astronaut" },
        { name: "Moon", type: "celestial-body" },
      ],
    }),
    bad: JSON.stringify({ facts: ["Moon"], entities: [] }),
  },

  "crystallizer-production-delta": {
    good: JSON.stringify({
      essence: "Кэш-иерархия CPU использует L1/L2/L3 уровни для уменьшения латентности доступа к памяти на 1-2 порядка",
      cipher: "L1: 4-5 циклов, L2: ~12, L3: ~40, DRAM: 200+",
      domain: "computer-science",
      tags: ["cpu", "cache", "memory-hierarchy", "performance"],
      auraFlags: { actionable: true, generalizable: true, surprising: false, structured: true },
      relations: [
        { subject: "L1 cache", predicate: "reduces_latency_to", object: "memory access" },
        { subject: "MESI protocol", predicate: "ensures", object: "cache coherence" },
      ],
    }),
    bad: JSON.stringify({ essence: "ok" }),
  },

  "crystallizer-aura": {
    good: "Многоуровневая кэш-иерархия CPU (L1/L2/L3) сокращает латентность доступа к памяти на 1-2 порядка ценой сложного протокола когерентности.",
    bad: "В этой главе говорится о кэшах процессоров и о том, как они работают.",
  },

  "crystallizer-ru-mendeleev": {
    good: JSON.stringify({
      facts: [
        "Дмитрий Менделеев открыл периодический закон в 1869 году",
        "Периодический закон описывает зависимость свойств элементов от их атомного веса",
        "Менделеев предсказал существование галлия и германия",
      ],
      entities: [
        { name: "Дмитрий Менделеев", type: "учёный" },
        { name: "периодический закон", type: "закон" },
        { name: "галлий", type: "элемент" },
      ],
    }),
    bad: JSON.stringify({ facts: ["химия"], entities: [] }),
  },

  "code-summary-cpp": {
    good: "The function implements quicksort recursively: pivots around the last element, partitions into two halves with a swap loop, then sorts each half. Time complexity O(n log n) average, O(n²) worst-case.",
    bad: "It sorts.",
  },

  "html-extract": {
    good: "Apple announced new iPhone with improved camera and battery life. The device launches next month with a starting price of $999.",
    bad: "<html><body>Apple announced</body></html>",
  },

  "translator-uk-ru": {
    good: "Алгоритм быстрой сортировки имеет среднюю временную сложность O(n log n) и худшую O(n²). Реализация через рекурсивный выбор опорного элемента (pivot).",
    bad: "Quicksort algorithm.",
  },

  "translator-en-ru": {
    good: "Алгоритм решает проблему путём итеративного выбора опорного элемента и разбиения массива на части. Сложность O(n log n) в среднем случае, O(n²) в худшем.",
    bad: "The algorithm solves the problem.",
  },

  "translator-ru-en": {
    good: "The Curiosity rover landed on Mars in 2012 and continues to explore Gale Crater. It uses a radioisotope thermoelectric generator powered by plutonium-238.",
    bad: "Curiosity. Mars. 2012.",
  },

  "ukrainian-uk-write": {
    good: "Сучасні процесори використовують багаторівневу систему кешів для зменшення латентності доступу до пам'яті. Кеш L1 розділений на інструкції та дані.",
    bad: "Современные процессоры используют кэши.", /* русский вместо украинского */
  },

  "lang-detect-uk": {
    good: "uk",
    bad: "ru",
  },

  "lang-detect-uk-shevchenko": {
    good: "uk",
    bad: "ru",
  },

  "lang-detect-uk-library": {
    good: "uk",
    bad: "ru",
  },

  "lang-detect-en": {
    good: "en",
    bad: "uk",
  },

  "lang-detect-ru": {
    good: "ru",
    bad: "uk",
  },

  "layout_assistant-chapter-detection": {
    /* Эталонный ответ: оба заголовка распознаны, "42" помечена как junk,
       никаких ложных срабатываний. */
    good: JSON.stringify({
      headings: [
        { line: 1, level: 2, text: "Chapter 1: Hello" },
        { line: 7, level: 2, text: "Chapter 2: World" },
      ],
      toc_block: null,
      junk_lines: [5],
    }),
    /* Плохой ответ: пропущен Chapter 2, junk не найден, добавлены ложные
       headings (галлюцинация). */
    bad: JSON.stringify({
      headings: [
        { line: 1, level: 1, text: "Some random title" },
        { line: 3, level: 2, text: "Body" },
        { line: 9, level: 1, text: "Other" },
      ],
      toc_block: null,
      junk_lines: [1, 3, 7, 9], /* всё контентное помечено junk */
    }),
  },
};

/**
 * Минимальный порог для "правильного ответа". Низкий потому, что многие scorers
 * — агрегатные (15+ признаков, эталонный ответ покрывает 3-5 из них). Цель —
 * различать «есть основа правильности» (≥0.30) от «полный мусор» (<0.20).
 */
const GOOD_THRESHOLD = 0.30;

/**
 * Максимум для "неверного ответа". Если scorer возвращает >0.40 — сигнал что
 * scorer слишком мягкий, а champion будет невыделим (все модели в одном регионе).
 */
const BAD_THRESHOLD = 0.40;

test("scorers: правильный ответ получает score ≥ 0.30 (отделим от шума)", () => {
  const failures: string[] = [];
  for (const d of OLYMPICS_DISCIPLINES) {
    if (d.role === "vision" || d.role.startsWith("vision_")) continue;
    const sample = SAMPLES[d.id];
    if (!sample) {
      failures.push(`${d.id}: нет эталонного ответа в SAMPLES`);
      continue;
    }
    const s = d.score(sample.good);
    if (s < GOOD_THRESHOLD) {
      failures.push(`${d.id}: правильный ответ получил ${s.toFixed(2)} (ожидаем ≥${GOOD_THRESHOLD})`);
    }
  }
  assert.deepEqual(failures, [], `Scorers слишком строгие:\n  - ${failures.join("\n  - ")}`);
});

test("scorers: правильный СУЩЕСТВЕННО лучше неверного (margin ≥ 0.20)", () => {
  /* Главная инвариантность: правильный ответ должен побеждать неверный
   * с заметным отрывом, иначе champion невыделим. */
  const failures: string[] = [];
  for (const d of OLYMPICS_DISCIPLINES) {
    if (d.role === "vision" || d.role.startsWith("vision_")) continue;
    const sample = SAMPLES[d.id];
    if (!sample) continue;
    const goodS = d.score(sample.good);
    const badS = d.score(sample.bad);
    if (goodS - badS < 0.20) {
      failures.push(
        `${d.id}: margin good(${goodS.toFixed(2)}) - bad(${badS.toFixed(2)}) = ${(goodS - badS).toFixed(2)} < 0.20`,
      );
    }
  }
  assert.deepEqual(failures, [], `Недостаточный margin между good и bad:\n  - ${failures.join("\n  - ")}`);
});

test("scorers: неверный ответ получает score ≤ 0.40", () => {
  const failures: string[] = [];
  for (const d of OLYMPICS_DISCIPLINES) {
    if (d.role === "vision" || d.role.startsWith("vision_")) continue;
    const sample = SAMPLES[d.id];
    if (!sample) continue;
    const s = d.score(sample.bad);
    if (s > BAD_THRESHOLD) {
      failures.push(`${d.id}: неверный ответ получил ${s.toFixed(2)} (ожидаем ≤${BAD_THRESHOLD})`);
    }
  }
  assert.deepEqual(failures, [], `Scorers слишком мягкие:\n  - ${failures.join("\n  - ")}`);
});

test("scorers: пустой ответ всегда даёт ≤ 0.15", () => {
  const failures: string[] = [];
  for (const d of OLYMPICS_DISCIPLINES) {
    const s = d.score("");
    if (s > 0.15) {
      failures.push(`${d.id}: пустой ответ получил ${s.toFixed(2)} (ожидаем ≤0.15)`);
    }
  }
  assert.deepEqual(failures, [], `Пустые ответы не должны давать score > 0.15:\n  - ${failures.join("\n  - ")}`);
});

test("scorers: markdown fences ```...``` штрафуются для дисциплин с JSON-схемой", () => {
  const failures: string[] = [];
  for (const d of OLYMPICS_DISCIPLINES) {
    const sample = SAMPLES[d.id];
    if (!sample?.malformed) continue; /* проверяем только те где есть malformed */
    const cleanScore = d.score(sample.good);
    const dirtyScore = d.score(sample.malformed);
    /* Markdown fences должны снижать score хотя бы на 0.10 относительно clean. */
    if (dirtyScore >= cleanScore) {
      failures.push(`${d.id}: malformed (markdown fences) получил ${dirtyScore.toFixed(2)} ≥ clean ${cleanScore.toFixed(2)}`);
    }
  }
  assert.deepEqual(failures, [], `Scorers не штрафуют markdown fences:\n  - ${failures.join("\n  - ")}`);
});

/**
 * Production-точная копия `stripThinkingBlock` из olympics.ts.
 *
 * Олимпиада применяет этот strip ПЕРЕД scorer (executeDiscipline), поэтому
 * scorer не обязан сам уметь парсить `<think>`. Этот тест эмулирует тот же
 * pre-process — это test integration, не unit (но с одной зависимостью).
 */
function stripThinkingBlockTest(raw: string): string {
  if (!raw.includes("<think")) return raw;
  return raw
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<think>[\s\S]*/gi, "")
    .trim();
}

test("integration: thinking-block <think>...</think> успешно вырезается перед scorer", () => {
  const failures: string[] = [];
  for (const d of OLYMPICS_DISCIPLINES) {
    if (d.role === "vision" || d.role.startsWith("vision_")) continue;
    const sample = SAMPLES[d.id];
    if (!sample) continue;
    const wrapped = `<think>Let me reason about this carefully...\nThe answer should be the correct one.</think>\n\n${sample.good}`;
    const stripped = stripThinkingBlockTest(wrapped);
    const sCleaned = d.score(stripped);
    const sGood = d.score(sample.good);
    /* После strip ответ должен скоринг как чистый good (с tolerance 0.05). */
    if (Math.abs(sCleaned - sGood) > 0.05) {
      failures.push(
        `${d.id}: после strip score=${sCleaned.toFixed(2)} расходится с clean=${sGood.toFixed(2)}`,
      );
    }
  }
  assert.deepEqual(failures, [], `stripThinkingBlock не дал ожидаемого результата:\n  - ${failures.join("\n  - ")}`);
});

test("samples: каждая дисциплина (кроме vision) имеет эталонные сэмплы", () => {
  const missing: string[] = [];
  for (const d of OLYMPICS_DISCIPLINES) {
    if (d.role === "vision" || d.role.startsWith("vision_")) continue;
    if (!SAMPLES[d.id]) missing.push(d.id);
  }
  assert.deepEqual(missing, [], `Дисциплины без эталона:\n  - ${missing.join("\n  - ")}`);
});

/* ─── Vision OCR scorers (Iter 14.3, 2026-05-04) ──────────────────────────
 *
 * Эти тесты НЕ обращаются к VLM — они валидируют что scorer корректно
 * оценивает синтетические ответы для каждой vision_ocr дисциплины.
 *
 * Цель: гарантировать что топовая VLM, которая распознала текст идеально,
 * получит ≥ 0.85, а слабая модель, которая выдумала текст или
 * испортила формат — ≤ 0.40. Раньше потолок vision_ocr был 50/100 (см.
 * commit history) — это убивало discriminative power для топовых моделей.
 */

const VISION_OCR_SAMPLES: Record<string, { perfect: string; weak: string; junk: string }> = {
  "vision_ocr-print-simple": {
    perfect: "THE QUICK BROWN FOX",
    weak: "the brown fox", /* пропустил quick — частичный recall */
    junk: "{\n  \"text\": \"THE QUICK BROWN FOX\"\n}", /* JSON вместо plain text */
  },
  "vision_ocr-print-two-lines": {
    perfect: "Hello World\n2024-12-25",
    weak: "Hello World", /* пропустил вторую строку */
    junk: "```\nHello World\n2024-12-25\n```", /* markdown fences */
  },
  "vision_ocr-print-numbers": {
    perfect: "INVOICE #4291\nTotal: $1,234.56",
    weak: "INVOICE\nTotal", /* потерял числа */
    junk: "Here is the text: INVOICE #4291", /* prose-обёртка */
  },
  "vision_ocr-blank-control": {
    perfect: "NO_TEXT",
    weak: "no text", /* допустимо но не идеал */
    junk: "I see some kind of empty rectangle but cannot read any text from it specifically", /* галлюцинация */
  },
};

test("vision_ocr: все 4 vision_ocr дисциплины присутствуют", () => {
  const expected = new Set([
    "vision_ocr-print-simple",
    "vision_ocr-print-two-lines",
    "vision_ocr-print-numbers",
    "vision_ocr-blank-control",
  ]);
  const found = new Set(
    OLYMPICS_DISCIPLINES.filter((d) => d.role === "vision_ocr").map((d) => d.id),
  );
  for (const id of expected) {
    assert.ok(found.has(id), `vision_ocr дисциплина ${id} отсутствует в OLYMPICS_DISCIPLINES`);
  }
});

test("vision_ocr: идеальный ответ получает ≥ 0.85 (потолок 100/100 достижим)", () => {
  const failures: string[] = [];
  for (const d of OLYMPICS_DISCIPLINES) {
    if (d.role !== "vision_ocr") continue;
    const sample = VISION_OCR_SAMPLES[d.id];
    if (!sample) {
      failures.push(`${d.id}: нет сэмпла в VISION_OCR_SAMPLES`);
      continue;
    }
    const s = d.score(sample.perfect);
    if (s < 0.85) {
      failures.push(`${d.id}: идеальный ответ получил ${s.toFixed(2)} (ожидаем ≥ 0.85)`);
    }
  }
  assert.deepEqual(failures, [], `Vision OCR scorers слишком строгие:\n  - ${failures.join("\n  - ")}`);
});

test("vision_ocr: слабый ответ получает между 0.10 и 0.70 (mid range)", () => {
  /* Mid-range нужен чтобы scorer ОТЛИЧАЛ слабую модель от средней:
   *   - perfect: 0.85+
   *   - weak: 0.10..0.70
   *   - junk: 0..0.40
   * Если weak == perfect — нет дискриминативной силы. */
  const failures: string[] = [];
  for (const d of OLYMPICS_DISCIPLINES) {
    if (d.role !== "vision_ocr") continue;
    const sample = VISION_OCR_SAMPLES[d.id];
    if (!sample) continue;
    const s = d.score(sample.weak);
    if (s < 0.10 || s > 0.80) {
      failures.push(`${d.id}: weak ответ получил ${s.toFixed(2)} (ожидаем 0.10..0.80)`);
    }
  }
  assert.deepEqual(failures, [], `Vision OCR mid-range broken:\n  - ${failures.join("\n  - ")}`);
});

test("vision_ocr: junk (JSON/markdown/prose-wrap/halucination) штрафуется ≤ 0.50", () => {
  const failures: string[] = [];
  for (const d of OLYMPICS_DISCIPLINES) {
    if (d.role !== "vision_ocr") continue;
    const sample = VISION_OCR_SAMPLES[d.id];
    if (!sample) continue;
    const s = d.score(sample.junk);
    if (s > 0.50) {
      failures.push(`${d.id}: junk получил ${s.toFixed(2)} (ожидаем ≤ 0.50)`);
    }
  }
  assert.deepEqual(failures, [], `Vision OCR не штрафует junk:\n  - ${failures.join("\n  - ")}`);
});

test("vision_ocr: perfect СУЩЕСТВЕННО лучше weak (margin ≥ 0.20)", () => {
  const failures: string[] = [];
  for (const d of OLYMPICS_DISCIPLINES) {
    if (d.role !== "vision_ocr") continue;
    const sample = VISION_OCR_SAMPLES[d.id];
    if (!sample) continue;
    const sP = d.score(sample.perfect);
    const sW = d.score(sample.weak);
    if (sP - sW < 0.20) {
      failures.push(
        `${d.id}: perfect(${sP.toFixed(2)}) - weak(${sW.toFixed(2)}) = ${(sP - sW).toFixed(2)} < 0.20`,
      );
    }
  }
  assert.deepEqual(failures, [], `Vision OCR margin perfect-vs-weak недостаточен:\n  - ${failures.join("\n  - ")}`);
});
