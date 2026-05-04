/**
 * H11 regression — `injectCasImageRefs`/`parseBookMarkdownChapters` не должны
 * терять контент книги, в которой есть Markdown-разделитель `---` (валидный
 * scene-break/horizontal rule в CommonMark).
 *
 * До 14.4 поиск был `lastIndexOf("\n---\n", imgIdx)` — ловил первый попавшийся
 * `---` перед маркером и обрезал всю книгу после него. Теперь поиск ищет
 * полную сигнатуру `\n---\n\n<!-- Image references ... -->` (см.
 * findImageRefsBlockStart в md-converter.ts).
 *
 * Источник угрозы: пользовательские книги (например, художественные с
 * `---` между сценами; технические с `---` между главами как стиль).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  injectCasImageRefs,
  parseBookMarkdownChapters,
} from "../electron/lib/library/md-converter.ts";
import type { BookCatalogMeta } from "../electron/lib/library/md-converter.ts";

const META: BookCatalogMeta = {
  id: "test-book-1",
  sha256: "deadbeef".repeat(8),
  originalFile: "test.epub",
  originalFormat: "epub",
  title: "Test Book",
  wordCount: 100,
  chapterCount: 2,
  status: "imported",
  storedAt: "2026-05-04T00:00:00.000Z",
  importedAt: "2026-05-04T00:00:00.000Z",
};

const FRONTMATTER = [
  "---",
  "id: test-book-1",
  "sha256: " + "deadbeef".repeat(8),
  "originalFile: test.epub",
  "originalFormat: epub",
  "title: Test Book",
  "wordCount: 100",
  "chapterCount: 2",
  "status: imported",
  "storedAt: 2026-05-04T00:00:00.000Z",
  "importedAt: 2026-05-04T00:00:00.000Z",
  "---",
].join("\n");

test("H11: injectCasImageRefs не теряет контент после `---` сцены-разделителя", () => {
  const bookWithSceneBreak = `${FRONTMATTER}

# Глава 1

Начало главы.

---

После сцены-разделителя.

---

Финальная сцена. ВАЖНЫЙ КОНТЕНТ ДЛЯ ПРОВЕРКИ.

## Глава 2

Вторая глава.
`;

  const reinjected = injectCasImageRefs(bookWithSceneBreak, [], META);

  /* КЛЮЧЕВАЯ проверка: контент после ВСЕХ `---` должен сохраниться. */
  assert.ok(
    reinjected.includes("ВАЖНЫЙ КОНТЕНТ ДЛЯ ПРОВЕРКИ"),
    `H11 BUG: контент после Markdown-разделителя пропал!\n\nReinjected:\n${reinjected}`,
  );
  assert.ok(reinjected.includes("Глава 2"), "Глава 2 должна остаться");
  assert.ok(reinjected.includes("Финальная сцена"), "Финальная сцена должна остаться");
  /* Сцены-разделители тоже должны остаться — это валидный Markdown. */
  const dashCount = (reinjected.match(/^---$/gm) || []).length;
  assert.ok(dashCount >= 2, "Ожидаем минимум 2 строки '---' (frontmatter close + scene break), получили " + dashCount);
});

test("H11: injectCasImageRefs корректно отрезает старый image-refs блок", () => {
  const bookWithRefs = `${FRONTMATTER}

# Глава

Текст главы.

---

<!-- Image references (CAS asset links) -->
[img-cover]: bibliary-asset://sha256/old.jpg
`;

  const reinjected = injectCasImageRefs(bookWithRefs, [], META);

  /* Старый image-refs блок отрезан (нет ссылок на старую обложку). */
  assert.ok(
    !reinjected.includes("old.jpg"),
    `Старая ссылка на обложку должна быть удалена.\n\nResult:\n${reinjected}`,
  );
  /* Контент главы сохранился. */
  assert.ok(reinjected.includes("Текст главы"), "Контент главы должен сохраниться");
});

test("H11: parseBookMarkdownChapters находит главы через сцены-разделители", () => {
  const bookWithSceneBreaks = `${FRONTMATTER}

## Глава 1

Параграф один главы 1.

---

Параграф два главы 1 (после разделителя сцен).

## Глава 2

Параграф главы 2.

---

<!-- Image references (CAS asset links) -->
[img-cover]: bibliary-asset://sha256/cover.jpg
`;

  const chapters = parseBookMarkdownChapters(bookWithSceneBreaks);

  assert.equal(chapters.length, 2, `Ожидаем 2 главы, получили ${chapters.length}`);
  assert.equal(chapters[0].title, "Глава 1");
  assert.equal(chapters[1].title, "Глава 2");

  /* КЛЮЧЕВАЯ проверка H11: параграф ПОСЛЕ `---` должен попасть в главу 1. */
  const ch1Text = chapters[0].paragraphs.join(" ");
  assert.ok(
    ch1Text.includes("Параграф два главы 1"),
    `H11 BUG: контент после разделителя сцен пропал из главы.\n\nГлава 1 paragraphs: ${JSON.stringify(chapters[0].paragraphs)}`,
  );
});

test("H11: idempotent — повторный inject не разрушает контент", () => {
  const original = `${FRONTMATTER}

# Глава

Текст с разделителем.

---

После разделителя.
`;

  const r1 = injectCasImageRefs(original, [], META);
  const r2 = injectCasImageRefs(r1, [], META);

  assert.ok(r1.includes("После разделителя"), "После 1-го inject контент сохраняется");
  assert.ok(r2.includes("После разделителя"), "После 2-го inject контент тоже сохраняется");
});
