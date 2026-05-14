import { test } from "node:test";
import { strict as assert } from "node:assert";
import { parseMarkdownToSections } from "../server/lib/scanner/parsers/pdf-inspector-parser.ts";

/**
 * Юнит-тесты для адаптера markdown → BookSection[].
 * Покрываем граничные случаи: heading-уровни, code fences, таблицы,
 * текст до первого heading'а.
 */

test("parseMarkdownToSections: H1/H2/H3 mapping", () => {
  const md = `# Глава 1\n\nПервый абзац.\n\n## Раздел A\n\nСодержимое раздела.\n\n### Подраздел\n\nПодробности.\n\n#### Tier4\n\nЕщё.\n\n##### Tier5\n\nГлубоко.`;
  const out = parseMarkdownToSections(md);
  assert.equal(out.length, 5);
  assert.equal(out[0]!.level, 1);
  assert.equal(out[0]!.title, "Глава 1");
  assert.equal(out[1]!.level, 1); // ## tier → level 1 (compressed)
  assert.equal(out[1]!.title, "Раздел A");
  assert.equal(out[2]!.level, 2); // ### → level 2
  assert.equal(out[3]!.level, 2); // #### → level 2
  assert.equal(out[4]!.level, 3); // ##### → level 3
});

test("parseMarkdownToSections: paragraphs separated by blank lines", () => {
  const md = `# Title\n\nFirst paragraph.\n\nSecond paragraph here.`;
  const out = parseMarkdownToSections(md);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.paragraphs.length, 2);
  assert.equal(out[0]!.paragraphs[0], "First paragraph.");
  assert.equal(out[0]!.paragraphs[1], "Second paragraph here.");
});

test("parseMarkdownToSections: text before first heading goes to virtual section", () => {
  const md = `Preface text without heading.\n\n# Real Heading\n\nUnder real heading.`;
  const out = parseMarkdownToSections(md);
  assert.equal(out.length, 2);
  assert.equal(out[0]!.title, "Введение");
  assert.equal(out[0]!.paragraphs[0], "Preface text without heading.");
  assert.equal(out[1]!.title, "Real Heading");
});

test("parseMarkdownToSections: code fences preserved as single paragraph", () => {
  const md = `# Code\n\n\`\`\`python\nfor i in range(10):\n    print(i)\n\`\`\`\n\nAfter code.`;
  const out = parseMarkdownToSections(md);
  assert.equal(out.length, 1);
  /* Code fence сохраняется как один параграф; следом отдельный за пустой строкой. */
  assert.equal(out[0]!.paragraphs.length, 2);
  assert.match(out[0]!.paragraphs[0]!, /```python/u);
  assert.match(out[0]!.paragraphs[0]!, /```$/u);
  assert.equal(out[0]!.paragraphs[1], "After code.");
});

test("parseMarkdownToSections: markdown table preserved", () => {
  const md = `# Tables\n\n| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n\nAfter table.`;
  const out = parseMarkdownToSections(md);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.paragraphs.length, 2);
  /* Вся таблица — один параграф (LLM крайстализатор поймёт markdown pipe-table). */
  assert.match(out[0]!.paragraphs[0]!, /\| a \| b \|/u);
  assert.match(out[0]!.paragraphs[0]!, /\| 3 \| 4 \|/u);
});

test("parseMarkdownToSections: empty input returns empty array", () => {
  assert.deepEqual(parseMarkdownToSections(""), []);
  assert.deepEqual(parseMarkdownToSections("\n\n\n"), []);
});

test("parseMarkdownToSections: heading without content yields section with title only", () => {
  const md = `# Empty Section\n\n## Real\n\nContent.`;
  const out = parseMarkdownToSections(md);
  /* "Empty Section" имеет 0 параграфов, но не пустой title — оставляем. */
  assert.equal(out.length, 2);
  assert.equal(out[0]!.title, "Empty Section");
  assert.equal(out[0]!.paragraphs.length, 0);
  assert.equal(out[1]!.title, "Real");
  assert.equal(out[1]!.paragraphs[0], "Content.");
});

test("parseMarkdownToSections: trailing # in heading stripped", () => {
  const md = `# Title #\n\nText.`;
  const out = parseMarkdownToSections(md);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.title, "Title");
});

test("parseMarkdownToSections: handles \\r\\n line endings", () => {
  const md = `# Heading\r\n\r\nFirst para.\r\n\r\nSecond.`;
  const out = parseMarkdownToSections(md);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.paragraphs.length, 2);
});

test("parseMarkdownToSections: code fence with no closing fence treats rest as code", () => {
  /* Защита от corrupt markdown — pdf-inspector может на edge cases выдать
     unbalanced fences. Оставляем содержимое в буфере. */
  const md = `# Title\n\n\`\`\`\nopen fence\nno closing.`;
  const out = parseMarkdownToSections(md);
  assert.equal(out.length, 1);
  /* Всё после ``` ушло в один параграф (буфер не сброшен). */
  assert.equal(out[0]!.paragraphs.length, 1);
});

test("parseMarkdownToSections: real-world snippet from Stroustrup C++", () => {
  /* Реальный фрагмент из Tour of C++ — двойные пустые строки между блоками. */
  const md = `### A Tour of C++ Second Edition\n\n#### C++ In-Depth Series Bjarne Stroustrup, Series Editor\n\nVisit informit.com/series/indepth for a complete list.\n\nhe C++ In-Depth Series is a collection of concise and focused books.\n\n## Tprovide real-world programmers with reliable information about the C++\n\n##### programming language.`;
  const out = parseMarkdownToSections(md);
  assert.ok(out.length >= 3, `expected ≥3 sections, got ${out.length}`);
  assert.equal(out[0]!.title, "A Tour of C++ Second Edition");
});
