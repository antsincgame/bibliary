/**
 * v1.0.10 (2026-05-06): регрессионный тест для критического бага «думающие
 * модели получают score=0 даже когда выдают валидный JSON».
 *
 * Контекст: до v1.0.10 локальный `tryParseJson` в `disciplines.ts`
 * использовал наивный regex `^[^{[]*`. Это срезало преамбулу до первой
 * `{` или `[`, но:
 *
 *   1. Реальные thinking-модели (gpt-oss-20b, qwen3.5-35b-a3b, qwen3.6-27b)
 *      пишут CoT prose БЕЗ `<think>` тегов — текст вроде «Thinking Process:
 *      1. **Analyze the Request:** ...» или «Here's a thinking process: ...».
 *      Внутри prose часто появляются artefactous `{` (markdown пример,
 *      mention структуры) — парсер хватал их как «начало JSON».
 *
 *   2. Финальный JSON у таких моделей всегда в КОНЦЕ ответа.
 *
 *   3. JSON.parse валился → null → `score=0`.
 *
 * Результат: чемпионами Olympics становились мелкие 1.5B-3B модели без
 * thinking, выдающие plain JSON. Это **противоположность желаемого** для
 * Кристаллизатора (где reasoning = выше качество).
 *
 * Фикс v1.0.10: tryParseJson переключён на `findLastValidJsonObject` +
 * `stripProseReasoning` из `electron/lib/library/reasoning-parser.ts`
 * (production parser, уже используемый в evaluator-queue).
 *
 * Этот тест защищает от рецидива:
 *
 *   - Реальные content-сэмплы из Olympics-логов (gpt-oss / qwen3.5-35b-a3b)
 *     обязаны давать `score > 0` для всех 4 evaluator-дисциплин и для
 *     обоих crystallizer-теста.
 *   - Прозрачные plain-JSON ответы (мелкие модели) не должны регрессировать.
 *   - Markdown-fences ```json``` корректно обрабатываются.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { OLYMPICS_DISCIPLINES } from "../electron/lib/llm/arena/disciplines.js";

function getDiscipline(id: string) {
  const d = OLYMPICS_DISCIPLINES.find((x) => x.id === id);
  if (!d) throw new Error(`discipline not found: ${id}`);
  return d;
}

/* ─── Real-world thinking-model responses (из v1.0.9 Olympics log) ─── */

const GPT_OSS_20B_EVALUATOR_CLRS = `{"score":9,"reasoning":"The 4th edition of *Introduction to Algorithms* (CLRS) remains the definitive technical reference for algorithm design and analysis. Used at top universities worldwide. Comprehensive coverage of sorting, graph algorithms, dynamic programming. The 1312-page volume is the de-facto standard textbook."}`;

const QWEN35_THINKING_PROSE_THEN_JSON = `Thinking Process:
1. **Analyze the Request:**
   * Task: Evaluate book quality.
   * Input Book: "Introduction to Algorithms" by CLRS.
2. **Recall facts about CLRS:**
   * It is the standard reference at MIT, Stanford, top schools worldwide.
   * 1312 pages, 4th edition (2022).
3. **Apply rubric:** This is THE classic — score should be 9 or 10.

{"score":9,"reasoning":"CLRS is the canonical algorithm textbook used by top universities globally. Comprehensive coverage of sorting, graph algorithms, and dynamic programming makes it the gold-standard reference."}`;

const HERES_A_THINKING_PROCESS_PROSE = `Here's a thinking process:
1. **Analyze User Input:**
   - **Book:** "JavaScript: The Good Parts" by Douglas Crockford
   - **Year:** 2008, pre-ES6
   - **Pages:** 176, mostly opinion-based
2. **Score reasoning:** Influential historically (good parts insight) but partially outdated. Mid-range = 6.

{"score":6,"reasoning":"JavaScript: The Good Parts was influential and useful when published, but is now dated (pre-ES6, no Promise/async). Worth reading as historical context but not the modern reference."}`;

const FIRST_I_NEED_TO = `First, I need to extract structured knowledge from the passage about the Curiosity rover. Key facts: landed Mars 2012-08-06 in Gale Crater, RTG with plutonium-238, NASA JPL operates.

{"facts":["The Curiosity rover landed on Mars on August 6, 2012","It landed in Gale Crater","Curiosity is powered by an RTG with plutonium-238","NASA's Jet Propulsion Laboratory operates the mission"],"entities":[{"name":"Curiosity","type":"rover"},{"name":"Mars","type":"planet"},{"name":"Gale Crater","type":"location"},{"name":"NASA","type":"organization"},{"name":"Jet Propulsion Laboratory","type":"organization"},{"name":"plutonium-238","type":"isotope"}]}`;

const OKAY_LETS_SEE = `Okay, let's see. The user is asking me to evaluate the book quality based on the given information. The book title is "10 Days to a Better You: Manifest Your Dreams Through Crystal Energy" — this is clearly self-help/spirituality content, not technical. For a TECHNICAL knowledge base, this should score very low.

{"score":1,"reasoning":"This is non-technical self-help content focused on chakras and crystal energy — explicitly outside the scope of a technical knowledge base. Self-published, no rigorous content. Should be filtered out as noise."}`;

const MARKDOWN_FENCES_JSON = `\`\`\`json
{"score":9,"reasoning":"CLRS is the canonical algorithm textbook used by top universities globally."}
\`\`\``;

const RU_PROSE_THEN_JSON = `Хорошо, давайте проанализируем фрагмент о Менделееве. Ключевые факты:
1. Дата: 1869 год
2. Создатель: Дмитрий Менделеев
3. Изобретение: Периодическая таблица
4. Место работы: Санкт-Петербургский университет
5. Предсказанные элементы: галлий, скандий, германий

{"facts":["Дмитрий Менделеев в 1869 году составил Периодическую таблицу химических элементов","Менделеев работал профессором в Санкт-Петербургском университете","Таблица предсказала свойства галлия, скандия и германия"],"entities":[{"name":"Дмитрий Менделеев","type":"person"},{"name":"Периодическая таблица","type":"concept"},{"name":"Санкт-Петербургский университет","type":"organization"},{"name":"галлий","type":"element"},{"name":"скандий","type":"element"},{"name":"германий","type":"element"}]}`;

/* ─── Тесты по дисциплинам ─────────────────────────────────────────── */

test("v1.0.10 evaluator-clrs: plain JSON без prose даёт высокий score", () => {
  const d = getDiscipline("evaluator-clrs");
  const score = d.score(GPT_OSS_20B_EVALUATOR_CLRS);
  assert.ok(score > 0.7, `expected > 0.7, got ${score}`);
});

test("v1.0.10 evaluator-clrs: 'Thinking Process:' prose-CoT не убивает score", () => {
  const d = getDiscipline("evaluator-clrs");
  const score = d.score(QWEN35_THINKING_PROSE_THEN_JSON);
  assert.ok(
    score > 0.5,
    `prose+JSON should still score > 0.5, got ${score} (BUG: tryParseJson v1.0.9 returned null → 0)`,
  );
});

test("v1.0.10 evaluator-mid-quality: \"Here's a thinking process:\" не убивает score", () => {
  const d = getDiscipline("evaluator-mid-quality");
  const score = d.score(HERES_A_THINKING_PROCESS_PROSE);
  assert.ok(
    score > 0.5,
    `"Here's a thinking process:" + final JSON should score > 0.5, got ${score}`,
  );
});

test("v1.0.10 crystallizer-rover: 'First, I need to' prose-CoT парсится корректно", () => {
  const d = getDiscipline("crystallizer-rover");
  const score = d.score(FIRST_I_NEED_TO);
  assert.ok(
    score > 0.6,
    `prose-CoT crystallizer should score > 0.6 (factCount=4, all anchors hit), got ${score}`,
  );
});

test("v1.0.10 evaluator-noise: \"Okay, let's see\" prose-CoT парсится корректно", () => {
  const d = getDiscipline("evaluator-noise");
  const score = d.score(OKAY_LETS_SEE);
  assert.ok(
    score > 0.7,
    `prose-CoT evaluator-noise should score > 0.7 (score=1 in [1..3] range), got ${score}`,
  );
});

test("v1.0.10 evaluator-clrs: markdown fences ```json``` корректно срезаются", () => {
  const d = getDiscipline("evaluator-clrs");
  const score = d.score(MARKDOWN_FENCES_JSON);
  assert.ok(score > 0.5, `markdown-fenced JSON should score > 0.5, got ${score}`);
});

test("v1.0.10 crystallizer-ru-mendeleev: русский prose-CoT парсится корректно", () => {
  const d = getDiscipline("crystallizer-ru-mendeleev");
  const score = d.score(RU_PROSE_THEN_JSON);
  assert.ok(
    score > 0.6,
    `русский prose-CoT для Менделеева должен дать score > 0.6, got ${score}`,
  );
});

test("v1.0.10 без регрессий: чистый plain JSON по-прежнему работает", () => {
  /* Mimics output of qwen2.5-1.5b-instruct (small non-thinking model) */
  const d = getDiscipline("evaluator-clrs");
  const plainJson = `{"score":10,"reasoning":"CLRS is the gold standard reference for algorithm design"}`;
  const score = d.score(plainJson);
  assert.ok(score > 0.5, `plain JSON regression: got ${score}`);
});

test("v1.0.10 без регрессий: пустой ответ → 0", () => {
  const d = getDiscipline("evaluator-clrs");
  assert.equal(d.score(""), 0);
});

test("v1.0.10 без регрессий: ответ без JSON → 0", () => {
  const d = getDiscipline("evaluator-clrs");
  const proseOnly = "I think this book is excellent because it covers all the algorithms.";
  assert.equal(d.score(proseOnly), 0);
});

test("v1.0.10 без регрессий: 'Thinking Process:' но JSON оборвался → 0", () => {
  const d = getDiscipline("evaluator-clrs");
  const truncated = `Thinking Process: 1. **Analyze the Request:** * Task: Evaluate book.`;
  /* Никакого JSON нет — тест ловит обрезанный ответ. */
  assert.equal(d.score(truncated), 0);
});

/* ─── Новая дисциплина vision_ocr-ru-math-textbook ──────────────────── */

test("v1.0.10: vision_ocr-ru-math-textbook зарегистрирована в OLYMPICS_DISCIPLINES", () => {
  const d = OLYMPICS_DISCIPLINES.find((x) => x.id === "vision_ocr-ru-math-textbook");
  assert.ok(d, "discipline vision_ocr-ru-math-textbook должна быть в списке");
  assert.equal(d.role, "vision_ocr");
  assert.ok(d.imageUrl?.startsWith("data:image/png;base64,"), "должна быть картинка-data-URL");
  assert.ok(d.imageUrl!.length > 100_000, `картинка должна быть большой (>100KB base64), got ${d.imageUrl!.length}`);
});

test("v1.0.10: vision_ocr-ru-math-textbook scorer даёт высокий балл при полном recall", () => {
  const d = getDiscipline("vision_ocr-ru-math-textbook");
  /* Симулируем «идеальный» OCR-ответ — все ключевые токены распознаны. */
  const idealOcr =
    "Для понимания книги необходимо знакомство с началами анализа в объеме курсов, " +
    "которые читаются на факультетах с расширенной математической программой. " +
    "Кроме того, предполагаются известными основные факты линейной алгебры. " +
    "Относительно более деликатные сведения, например некоторые теоремы о " +
    "дифференциальных уравнениях, напоминаются. Без дополнительных пояснений " +
    "будут использоваться нижеследующие обозначения: A ∪ B — объединение " +
    "множеств A и B; A ∩ B — их пересечение; запись a ∈ A означает, что a — " +
    "элемент множества A; A ⊂ B означает, что элементы множества A принадлежат " +
    "множеству B; A × B — множество, элементами которого являются упорядоченные " +
    "пары (a, b). Если f — функция (отображение), то f(x), как правило, будет " +
    "обозначать лишь значение f в точке x. Аргумент в этом случае выписывается " +
    "для того, чтобы условиться об обозначающей его букве. Запись f: E₁ → E₂ " +
    "означает, что f есть функция, заданная на множестве E₁ и принимающая значения " +
    "на множестве E₂. Аналогично следует толковать неравенства. " +
    "Автор благодарен Ф. А. Березину, Л. Д. Кудрявцеву и М. В. Федорюку за " +
    "внимательное рецензирование рукописи в духе классической традиции единого символа.";
  const score = d.score(idealOcr);
  assert.ok(
    score > 0.6,
    `идеальный OCR должен давать score > 0.6 (recall ключевых слов + math symbols), got ${score}`,
  );
});

test("v1.0.10: vision_ocr-ru-math-textbook scorer штрафует за галлюцинацию NO_TEXT", () => {
  const d = getDiscipline("vision_ocr-ru-math-textbook");
  assert.equal(d.score("NO_TEXT"), 0, "NO_TEXT для непустой картинки = 0");
});

test("v1.0.10: vision_ocr-ru-math-textbook scorer штрафует за пустой ответ", () => {
  const d = getDiscipline("vision_ocr-ru-math-textbook");
  /* Пустая строка — 0 hits, recall=0. */
  assert.equal(d.score(""), 0);
});

test("v1.0.10: vision_ocr-ru-math-textbook scorer низкий балл за частичный recall", () => {
  const d = getDiscipline("vision_ocr-ru-math-textbook");
  /* Только 2 токена из 40+ распознаны. */
  const partial = "понимания книги";
  const score = d.score(partial);
  assert.ok(score < 0.15, `только 2 токена — score должен быть < 0.15, got ${score}`);
});
