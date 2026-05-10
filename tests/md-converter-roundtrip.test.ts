/**
 * tests/md-converter-roundtrip.test.ts
 *
 * Unit-тесты для electron/lib/library/md-converter.ts — сердца pipeline'а.
 * Раньше покрывалось только косвенно через library-cas-pipeline и smoke
 * import-flow. Любая регрессия parseFrontmatter/replaceFrontmatter/
 * parseBookMarkdownChapters/upsertEvaluatorReasoning/injectCasImageRefs
 * ломает evaluator-flow и обнаруживается только в проде у пользователя.
 *
 * Покрытие:
 *   - parseFrontmatter: типы (numeric/boolean/string/list), escaping,
 *     unknown keys, отсутствующий разделитель, BOM, multiline lists
 *   - buildFrontmatter → parseFrontmatter roundtrip (lossless для известных полей)
 *   - replaceFrontmatter: идемпотентность, сохранение body, CRLF не ломает
 *   - parseBookMarkdownChapters: разбиение по `## `, скип `# ` (book title),
 *     скип evaluator-reasoning, скип image-refs (в т.ч. КОГДА в теле есть
 *     scene-break `---` — H11 fix критичен!), пустые параграфы
 *   - upsertEvaluatorReasoning: insert / replace / delete (null) — все идемпотентно
 *   - injectCasImageRefs: H11 — обновление refs не режет body по `---` scene-break
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseFrontmatter,
  replaceFrontmatter,
  parseBookMarkdownChapters,
  upsertEvaluatorReasoning,
  injectCasImageRefs,
} from "../electron/lib/library/md-converter.ts";
import type { BookCatalogMeta, ImageRef } from "../electron/lib/library/types.ts";

function makeMeta(overrides: Partial<BookCatalogMeta> = {}): BookCatalogMeta {
  return {
    id: "abc123def456",
    sha256: "a".repeat(64),
    title: "Test Book",
    originalFile: "book.pdf",
    originalFormat: "pdf",
    wordCount: 12345,
    chapterCount: 7,
    status: "imported",
    ...overrides,
  };
}

/* ─── parseFrontmatter ─────────────────────────────────────────────── */

test("[md-converter] parseFrontmatter: numeric/boolean/string/list types", () => {
  const md = `---
id: "book-1"
sha256: "deadbeef"
title: "My Title"
originalFile: "x.pdf"
originalFormat: pdf
wordCount: 5000
chapterCount: 3
qualityScore: 78
isFictionOrWater: true
status: evaluated
tags: ["alpha", "beta", "gamma"]
---

body
`;
  const fm = parseFrontmatter(md);
  assert.ok(fm, "frontmatter parsed");
  assert.equal(fm!.id, "book-1");
  assert.equal(fm!.sha256, "deadbeef");
  assert.equal(fm!.title, "My Title");
  assert.equal(fm!.wordCount, 5000, "numeric key wordCount");
  assert.equal(fm!.chapterCount, 3, "numeric key chapterCount");
  assert.equal(fm!.qualityScore, 78);
  assert.equal(fm!.isFictionOrWater, true, "boolean key isFictionOrWater");
  assert.equal(fm!.status, "evaluated");
  assert.deepEqual(fm!.tags, ["alpha", "beta", "gamma"]);
});

test("[md-converter] parseFrontmatter: returns null for missing or malformed delimiter", () => {
  assert.equal(parseFrontmatter(""), null, "empty");
  assert.equal(parseFrontmatter("body without frontmatter"), null);
  assert.equal(parseFrontmatter("---\nid: x"), null, "no closing ---");
  assert.equal(parseFrontmatter("---x\nid: y\n---\n"), null, "broken opener");
});

test("[md-converter] parseFrontmatter: handles double-quoted strings with escaped chars", () => {
  const md = `---
id: "book"
sha256: "x"
title: "Title with \\"quotes\\" and \\\\backslashes"
originalFile: "file.pdf"
originalFormat: pdf
wordCount: 1
chapterCount: 1
status: imported
---

body
`;
  const fm = parseFrontmatter(md);
  assert.ok(fm);
  assert.equal(fm!.title, 'Title with "quotes" and \\backslashes');
});

test("[md-converter] parseFrontmatter: multiline lists (warnings) collected from `  - ` items", () => {
  const md = `---
id: "x"
sha256: "y"
title: "T"
originalFile: "f.pdf"
originalFormat: pdf
wordCount: 1
chapterCount: 1
status: imported
warnings:
  - "first warning"
  - "second warning"
  - "third"
---

body
`;
  const fm = parseFrontmatter(md);
  assert.ok(fm);
  assert.deepEqual(fm!.warnings, ["first warning", "second warning", "third"]);
});

test("[md-converter] parseFrontmatter: unknown keys preserved as-is (forward compat)", () => {
  const md = `---
id: "x"
sha256: "y"
title: "T"
originalFile: "f.pdf"
originalFormat: pdf
wordCount: 1
chapterCount: 1
status: imported
futureUnknownField: "value-2030"
---

body
`;
  const fm = parseFrontmatter(md) as Record<string, unknown>;
  assert.ok(fm);
  assert.equal(fm["futureUnknownField"], "value-2030",
    "unknown keys must be preserved (forward-compat for new fields)");
});

test("[md-converter] parseFrontmatter: empty list `[]` returns empty array", () => {
  const md = `---
id: "x"
sha256: "y"
title: "T"
originalFile: "f.pdf"
originalFormat: pdf
wordCount: 1
chapterCount: 1
status: imported
tags: []
---

body
`;
  const fm = parseFrontmatter(md);
  assert.ok(fm);
  assert.deepEqual(fm!.tags, []);
});

/* ─── buildFrontmatter → parseFrontmatter roundtrip ────────────────── */

test("[md-converter] roundtrip: replaceFrontmatter on minimal meta preserves all fields", () => {
  const meta = makeMeta({
    title: "Кибернетика",
    author: "N. Wiener",
    titleRu: "Кибернетика",
    authorRu: "Н. Винер",
    titleEn: "Cybernetics",
    authorEn: "N. Wiener",
    year: 1965,
    language: "ru",
    isbn: "9785170000000",
    domain: "cybernetics",
    tags: ["cybernetics", "control", "feedback"],
    tagsRu: ["кибернетика", "управление", "обратная связь"],
    qualityScore: 92,
    conceptualDensity: 88,
    originality: 78,
    isFictionOrWater: false,
    verdictReason: "Classic foundational text on feedback systems and information theory",
    evaluatorModel: "qwen3-4b",
    evaluatedAt: "2026-05-09T12:00:00.000Z",
    status: "evaluated",
    warnings: ["w1", "w2 with special chars: «ёлочки»"],
    layoutVersion: 1,
  });

  /* replaceFrontmatter требует существующий markdown с frontmatter — даём
     минимальный, потом заменяем. */
  const seed = `---
id: ${meta.id}
sha256: ${meta.sha256}
title: ${meta.title}
originalFile: ${meta.originalFile}
originalFormat: ${meta.originalFormat}
wordCount: 0
chapterCount: 0
status: imported
---

body remains intact
`;
  const replaced = replaceFrontmatter(seed, meta);
  assert.match(replaced, /body remains intact/, "body preserved");

  const parsed = parseFrontmatter(replaced);
  assert.ok(parsed, "roundtrip parses");
  assert.equal(parsed!.id, meta.id);
  assert.equal(parsed!.sha256, meta.sha256);
  assert.equal(parsed!.title, "Кибернетика");
  assert.equal(parsed!.author, "N. Wiener");
  assert.equal(parsed!.titleRu, "Кибернетика");
  assert.equal(parsed!.year, 1965);
  assert.equal(parsed!.language, "ru");
  assert.equal(parsed!.isbn, "9785170000000");
  assert.equal(parsed!.qualityScore, 92);
  assert.equal(parsed!.isFictionOrWater, false);
  assert.equal(parsed!.layoutVersion, 1);
  assert.deepEqual(parsed!.tags, ["cybernetics", "control", "feedback"]);
  assert.deepEqual(parsed!.tagsRu, ["кибернетика", "управление", "обратная связь"]);
  assert.deepEqual(parsed!.warnings, ["w1", "w2 with special chars: «ёлочки»"]);
});

test("[md-converter] roundtrip: replaceFrontmatter with quotes/backslash/newline in title", () => {
  const meta = makeMeta({
    title: 'Tricky "Title" with \\backslash and\nnewline',
    verdictReason: 'Has "quote" too',
    status: "evaluated",
    qualityScore: 50,
  });
  const seed = `---
id: ${meta.id}
sha256: ${meta.sha256}
title: simple
originalFile: ${meta.originalFile}
originalFormat: ${meta.originalFormat}
wordCount: 0
chapterCount: 0
status: imported
---

body
`;
  const replaced = replaceFrontmatter(seed, meta);
  const parsed = parseFrontmatter(replaced);
  assert.ok(parsed);
  assert.equal(parsed!.title, 'Tricky "Title" with \\backslash and\nnewline');
  assert.equal(parsed!.verdictReason, 'Has "quote" too');
});

/* ─── replaceFrontmatter idempotency & body preservation ───────────── */

test("[md-converter] replaceFrontmatter: idempotent — same meta twice produces same output", () => {
  const meta = makeMeta({ qualityScore: 80, status: "evaluated" });
  const seed = `---
id: ${meta.id}
sha256: ${meta.sha256}
title: ${meta.title}
originalFile: ${meta.originalFile}
originalFormat: ${meta.originalFormat}
wordCount: 0
chapterCount: 0
status: imported
---

# Body

## Chapter

Some text.
`;
  const once = replaceFrontmatter(seed, meta);
  const twice = replaceFrontmatter(once, meta);
  assert.equal(once, twice, "second pass with same meta yields identical output");
});

test("[md-converter] replaceFrontmatter: returns markdown unchanged if no frontmatter", () => {
  const noFm = "# Just body\n\nNo frontmatter here.";
  const meta = makeMeta();
  assert.equal(replaceFrontmatter(noFm, meta), noFm);
});

test("[md-converter] replaceFrontmatter: returns markdown unchanged if frontmatter delimiter not closed", () => {
  const broken = "---\nid: x\ntitle: y\n\n# Body without closing\n";
  const meta = makeMeta();
  assert.equal(replaceFrontmatter(broken, meta), broken);
});

test("[md-converter] replaceFrontmatter: preserves evaluator-reasoning and image-refs sections", () => {
  const seed = `---
id: x
sha256: y
title: T
originalFile: f.pdf
originalFormat: pdf
wordCount: 0
chapterCount: 0
status: imported
---

## Evaluator Reasoning

> Chain-of-Thought from the evaluator LLM. Premium dataset asset.

The evaluator concluded foo bar baz.

<!-- /evaluator-reasoning -->

# Book Title

## Chapter 1

Body para.

---

<!-- Image references (CAS asset links) -->
[img-cover]: bibliary-asset://sha256/${"a".repeat(64)}
`;
  const meta = makeMeta({ qualityScore: 75, status: "evaluated" });
  const replaced = replaceFrontmatter(seed, meta);
  /* Reasoning section + image-refs не должны исчезнуть. */
  assert.match(replaced, /Evaluator Reasoning/);
  assert.match(replaced, /The evaluator concluded foo bar baz\./);
  assert.match(replaced, /Image references \(CAS asset links\)/);
  assert.match(replaced, /img-cover.*bibliary-asset:\/\/sha256/);
});

/* ─── parseBookMarkdownChapters ────────────────────────────────────── */

test("[md-converter] parseBookMarkdownChapters: basic split by `## `", () => {
  const md = `---
id: x
sha256: y
title: T
originalFile: f.pdf
originalFormat: pdf
wordCount: 100
chapterCount: 2
status: imported
---

# Book Title

## First Chapter

Para one of first.

Para two of first.

## Second Chapter

Para one of second.
`;
  const chapters = parseBookMarkdownChapters(md);
  assert.equal(chapters.length, 2);
  assert.equal(chapters[0].title, "First Chapter");
  assert.equal(chapters[0].paragraphs.length, 2);
  assert.equal(chapters[1].title, "Second Chapter");
  assert.equal(chapters[1].paragraphs.length, 1);
  /* Заголовок книги (`# Book Title`) пропускается, не попадает в chapters. */
  assert.ok(chapters.every((ch) => ch.title !== "Book Title"));
});

test("[md-converter] parseBookMarkdownChapters: skips evaluator-reasoning section", () => {
  const md = `---
id: x
sha256: y
title: T
originalFile: f.pdf
originalFormat: pdf
wordCount: 1
chapterCount: 1
status: evaluated
---

## Evaluator Reasoning

> CoT block.

The evaluator says this and that. NOT_A_CHAPTER_BODY.

<!-- /evaluator-reasoning -->

## Real Chapter

Real body content here.
`;
  const chapters = parseBookMarkdownChapters(md);
  assert.equal(chapters.length, 1, "only Real Chapter — Evaluator Reasoning is not a chapter");
  assert.equal(chapters[0].title, "Real Chapter");
  /* Контент из reasoning не должен утечь в paragraphs. */
  assert.ok(chapters[0].paragraphs.every((p) => !p.includes("NOT_A_CHAPTER_BODY")),
    "reasoning content must not leak into chapter body");
});

test("[md-converter] parseBookMarkdownChapters: skips image-refs section after `---` separator", () => {
  const md = `---
id: x
sha256: y
title: T
originalFile: f.pdf
originalFormat: pdf
wordCount: 1
chapterCount: 1
status: imported
---

## Chapter A

Real body of chapter A.

---

<!-- Image references (CAS asset links) -->
[img-cover]: bibliary-asset://sha256/${"a".repeat(64)}
[img-001]: bibliary-asset://sha256/${"b".repeat(64)}
`;
  const chapters = parseBookMarkdownChapters(md);
  assert.equal(chapters.length, 1);
  assert.equal(chapters[0].title, "Chapter A");
  /* image refs не должны попасть в paragraphs главы. */
  assert.ok(
    chapters[0].paragraphs.every((p) => !p.includes("bibliary-asset://")),
    "image ref definitions must not leak into chapter paragraphs",
  );
  assert.ok(
    chapters[0].paragraphs.every((p) => !p.includes("[img-001]")),
    "image ref ids must not leak",
  );
});

test("[md-converter] parseBookMarkdownChapters: H11 — scene-break `---` inside chapter must NOT trigger image-refs cut", () => {
  /* H11 fix (commit 173f6cb): scene-break `---` в теле — валидный CommonMark
     горизонтальный разделитель. Раньше он мог быть распознан как начало
     image-refs блока и резал книгу пополам. parseBookMarkdownChapters
     должен видеть только сигнатуру `\n---\n\n<!-- Image references...`
     или `\n---\n<!-- Image references...`, ничего другого. */
  const md = `---
id: x
sha256: y
title: T
originalFile: f.pdf
originalFormat: pdf
wordCount: 100
chapterCount: 1
status: imported
---

## Long Chapter

Paragraph before scene break.

---

Paragraph AFTER scene break — must still be present in body.

Another paragraph still in same chapter.
`;
  const chapters = parseBookMarkdownChapters(md);
  assert.equal(chapters.length, 1, "still one chapter (scene-break is part of body)");
  /* Все три параграфа должны выжить (хотя --- сам по себе пропадёт как
     пустой блок — это OK). */
  const joined = chapters[0].paragraphs.join("\n\n");
  assert.match(joined, /Paragraph before scene break/);
  assert.match(joined, /Paragraph AFTER scene break/,
    "H11: текст после scene-break `---` не должен быть отрезан");
  assert.match(joined, /Another paragraph still in same chapter/);
});

test("[md-converter] parseBookMarkdownChapters: CRLF line endings документированно НЕ поддерживаются (контракт LF-only)", () => {
  /* Документируем явно: parseBookMarkdownChapters ожидает frontmatter с
     `---\n...\n---\n` (LF only), не CRLF. Производственные .md файлы
     создаются на одной системе buildFrontmatter'ом и всегда используют LF.
     Если когда-либо потребуется поддержка CRLF (например, для импорта
     foreign markdown'а) — это потребует изменения parseBookMarkdownChapters
     И обновления этого теста на ожидаемое поведение. */
  const md = "---\r\nid: x\r\nsha256: y\r\ntitle: T\r\noriginalFile: f.pdf\r\noriginalFormat: pdf\r\nwordCount: 1\r\nchapterCount: 1\r\nstatus: imported\r\n---\r\n\r\n## Chapter CRLF\r\n\r\nBody with CRLF.\r\n";
  const chapters = parseBookMarkdownChapters(md);
  /* CRLF в frontmatter delimiter → markdown.startsWith("---\n") = false → return [] */
  assert.equal(chapters.length, 0,
    "CRLF в frontmatter не распознаётся как валидный delimiter; контракт LF-only");
});

test("[md-converter] parseBookMarkdownChapters: returns empty for body without `## `", () => {
  const md = `---
id: x
sha256: y
title: T
originalFile: f.pdf
originalFormat: pdf
wordCount: 0
chapterCount: 0
status: imported
---

# Just title

Some flat paragraphs without chapter headers.
`;
  const chapters = parseBookMarkdownChapters(md);
  assert.equal(chapters.length, 0,
    "no `## ` headers → no chapters (caller marks book as unsupported)");
});

test("[md-converter] parseBookMarkdownChapters: deterministic chapter index counting", () => {
  const md = `---
id: x
sha256: y
title: T
originalFile: f.pdf
originalFormat: pdf
wordCount: 0
chapterCount: 0
status: imported
---

## Ch1

a

## Ch2

b

## Ch3

c
`;
  const chapters = parseBookMarkdownChapters(md);
  assert.deepEqual(chapters.map((ch) => ch.index), [0, 1, 2]);
});

test("[md-converter] parseBookMarkdownChapters: skips standalone image-paragraphs `![alt][img-id]`", () => {
  const md = `---
id: x
sha256: y
title: T
originalFile: f.pdf
originalFormat: pdf
wordCount: 1
chapterCount: 1
status: imported
---

## Chapter With Inline Cover

![Cover][img-cover]

Real text paragraph.

![Page][img-001]

Another paragraph.
`;
  const chapters = parseBookMarkdownChapters(md);
  assert.equal(chapters.length, 1);
  /* Image-only параграфы выкинуты из paragraphs. */
  assert.equal(chapters[0].paragraphs.length, 2,
    "только текстовые параграфы — image refs выкинуты");
  assert.ok(chapters[0].paragraphs.every((p) => !p.startsWith("![")),
    "ни один параграф не должен быть чистым `![...][...]`");
});

/* ─── upsertEvaluatorReasoning ─────────────────────────────────────── */

test("[md-converter] upsertEvaluatorReasoning: insert into book without prior reasoning", () => {
  const md = `---
id: x
sha256: y
title: T
originalFile: f.pdf
originalFormat: pdf
wordCount: 1
chapterCount: 1
status: evaluated
---

# Book

## Ch1

Body.
`;
  const reasoning = "The evaluator deduced X, Y, Z.";
  const out = upsertEvaluatorReasoning(md, reasoning);
  assert.match(out, /## Evaluator Reasoning/);
  assert.match(out, /The evaluator deduced X, Y, Z\./);
  assert.match(out, /<!-- \/evaluator-reasoning -->/);
  /* Body сохранён. */
  assert.match(out, /## Ch1\n\nBody\./);
});

test("[md-converter] upsertEvaluatorReasoning: idempotent — same reasoning twice yields same result", () => {
  const md = `---
id: x
sha256: y
title: T
originalFile: f.pdf
originalFormat: pdf
wordCount: 1
chapterCount: 1
status: evaluated
---

## Ch1

Body.
`;
  const reasoning = "CoT chunk";
  const once = upsertEvaluatorReasoning(md, reasoning);
  const twice = upsertEvaluatorReasoning(once, reasoning);
  assert.equal(once, twice, "идемпотентность: повторный upsert не дублирует секцию");
});

test("[md-converter] upsertEvaluatorReasoning: replaces existing reasoning, not duplicates", () => {
  const md = `---
id: x
sha256: y
title: T
originalFile: f.pdf
originalFormat: pdf
wordCount: 1
chapterCount: 1
status: evaluated
---

## Evaluator Reasoning

> Chain-of-Thought from the evaluator LLM. Premium dataset asset.

OLD reasoning content.

<!-- /evaluator-reasoning -->

## Ch1

Body.
`;
  const out = upsertEvaluatorReasoning(md, "NEW reasoning content.");
  assert.doesNotMatch(out, /OLD reasoning content/, "old reasoning replaced");
  assert.match(out, /NEW reasoning content/);
  /* Только одна секция Evaluator Reasoning. */
  const matches = out.match(/## Evaluator Reasoning/g) ?? [];
  assert.equal(matches.length, 1, `must be exactly one Evaluator Reasoning section, got ${matches.length}`);
});

test("[md-converter] upsertEvaluatorReasoning: null/empty reasoning removes existing section entirely", () => {
  const md = `---
id: x
sha256: y
title: T
originalFile: f.pdf
originalFormat: pdf
wordCount: 1
chapterCount: 1
status: evaluated
---

## Evaluator Reasoning

> CoT block.

To be removed.

<!-- /evaluator-reasoning -->

## Ch1

Body.
`;
  const removedNull = upsertEvaluatorReasoning(md, null);
  assert.doesNotMatch(removedNull, /Evaluator Reasoning/);
  assert.doesNotMatch(removedNull, /To be removed/);
  assert.match(removedNull, /## Ch1\n\nBody\./, "body preserved after reasoning removal");

  const removedEmpty = upsertEvaluatorReasoning(md, "   ");
  assert.doesNotMatch(removedEmpty, /Evaluator Reasoning/, "whitespace-only reasoning removes section");
});

test("[md-converter] upsertEvaluatorReasoning: returns markdown unchanged if no frontmatter", () => {
  const noFm = "Just body, no frontmatter.";
  assert.equal(upsertEvaluatorReasoning(noFm, "x"), noFm);
});

/* ─── injectCasImageRefs (H11 critical) ────────────────────────────── */

test("[md-converter] injectCasImageRefs: H11 — scene-break `---` in body NOT eaten when refreshing image refs", () => {
  /* Это сценарий из commit 173f6cb: книга с scene-break `---` посреди тела.
     До H11 fix lastIndexOf("\\n---\\n", oldIdx) ловил scene-break и
     ВЫРЕЗАЛ всё после него при reimport обложки → катастрофическая
     потеря половины книги. Тест строит такой markdown и проверяет, что
     текст после scene-break сохранён. */
  const meta = makeMeta();
  const md = `---
id: ${meta.id}
sha256: ${meta.sha256}
title: ${meta.title}
originalFile: ${meta.originalFile}
originalFormat: ${meta.originalFormat}
wordCount: 100
chapterCount: 2
status: imported
---

![Cover][img-cover]

## Chapter 1

Para before scene break.

---

UNIQUE_TEXT_AFTER_SCENE_BREAK_MUST_SURVIVE_H11

## Chapter 2

Body of chapter 2.

---

<!-- Image references (CAS asset links) -->
[img-cover]: bibliary-asset://sha256/${"a".repeat(64)}
`;

  const newImages: ImageRef[] = [
    {
      id: "img-cover",
      mimeType: "image/png",
      buffer: Buffer.alloc(0),
      assetUrl: `bibliary-asset://sha256/${"b".repeat(64)}`,
    },
  ];
  const out = injectCasImageRefs(md, newImages, meta);
  assert.match(out, /UNIQUE_TEXT_AFTER_SCENE_BREAK_MUST_SURVIVE_H11/,
    "H11 regression: scene-break --- must NOT cause body truncation when image refs are rewritten");
  assert.match(out, /## Chapter 2/, "Chapter 2 still present");
  assert.match(out, /Body of chapter 2\./, "Chapter 2 body still present");
  /* Новый image ref добавился, старый убран. */
  assert.match(out, /bibliary-asset:\/\/sha256\/b{64}/, "new asset URL injected");
  assert.doesNotMatch(out, /bibliary-asset:\/\/sha256\/a{64}/, "old asset URL replaced");
});

test("[md-converter] injectCasImageRefs: empty image list produces markdown without refs section", () => {
  const meta = makeMeta();
  const md = `---
id: ${meta.id}
sha256: ${meta.sha256}
title: ${meta.title}
originalFile: ${meta.originalFile}
originalFormat: ${meta.originalFormat}
wordCount: 1
chapterCount: 1
status: imported
---

## Chapter

Body.
`;
  const out = injectCasImageRefs(md, [], meta);
  assert.match(out, /## Chapter/);
  assert.match(out, /Body\./);
  assert.doesNotMatch(out, /Image references/);
});

test("[md-converter] injectCasImageRefs: idempotent — same refs twice yields same output", () => {
  const meta = makeMeta();
  const md = `---
id: ${meta.id}
sha256: ${meta.sha256}
title: ${meta.title}
originalFile: ${meta.originalFile}
originalFormat: ${meta.originalFormat}
wordCount: 1
chapterCount: 1
status: imported
---

## Chapter

Body content.
`;
  const refs: ImageRef[] = [
    { id: "img-cover", mimeType: "image/png", buffer: Buffer.alloc(0),
      assetUrl: `bibliary-asset://sha256/${"c".repeat(64)}` },
    { id: "img-001", mimeType: "image/jpeg", buffer: Buffer.alloc(0),
      assetUrl: `bibliary-asset://sha256/${"d".repeat(64)}` },
  ];
  const once = injectCasImageRefs(md, refs, meta);
  const twice = injectCasImageRefs(once, refs, meta);
  assert.equal(once, twice,
    "повторный inject с теми же refs → identical output (нет дублирования секции)");
});
