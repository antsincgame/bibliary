/**
 * tests/renderer-library-display-meta.test.ts
 *
 * Unit-тесты для renderer/library/display-meta.js — locale-aware
 * bibliographic display (title/author/tooltip/tags). Эти функции
 * вызываются на КАЖДОЙ строке каталога + в reader + в collections.
 *
 * Регрессия типа «показали titleEn когда locale · ru» или
 * «вывели row.id вместо корректногво fallback'а» разломает всю UX
 * каталога. До этого теста эти 4 функции не были unit-tested.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

/* ─── globals stub ДО импорта i18n в display-meta ────────────────── */
const memStore = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => memStore.get(k) ?? null,
  setItem: (k: string, v: string) => { memStore.set(k, String(v)); },
  removeItem: (k: string) => { memStore.delete(k); },
  clear: () => { memStore.clear(); },
};
(globalThis as Record<string, unknown>).document = {
  documentElement: { lang: "" },
  querySelectorAll: () => [],
};

import { setLocale } from "../renderer/i18n.js";
import {
  displayBookTitle,
  displayBookAuthor,
  bookTitleTooltip,
  displayBookTags,
} from "../renderer/library/display-meta.js";

/* Группируем всё по locale — после каждого теста возвращаемся к ru. */

/* ─── displayBookTitle: ru locale fallback chain ──────────────────── */

test("[display-meta] displayBookTitle/ru: titleRu выигрывает приоритет", () => {
  setLocale("ru");
  const v = displayBookTitle({
    id: "abc", title: "Original", titleRu: "Русское", titleEn: "English",
  });
  assert.equal(v, "Русское");
});

test("[display-meta] displayBookTitle/ru: fallback titleRu → title", () => {
  setLocale("ru");
  const v = displayBookTitle({
    id: "abc", title: "Original", titleEn: "English",
  });
  assert.equal(v, "Original");
});

test("[display-meta] displayBookTitle/ru: fallback title → titleEn", () => {
  setLocale("ru");
  const v = displayBookTitle({
    id: "abc", title: "", titleEn: "English",
  });
  assert.equal(v, "English");
});

test("[display-meta] displayBookTitle: пустые все поля → row.id fallback", () => {
  setLocale("ru");
  const v = displayBookTitle({ id: "book-uuid-123", title: "" });
  assert.equal(v, "book-uuid-123");
});

test("[display-meta] displayBookTitle: всё пустое + пробельные → row.id", () => {
  /* Семантика: строка из whitespace ложновыглядит как non-empty но .trim()="" →
     id fallback (иначе пользователь увидит пустую ячейку в каталоге). */
  setLocale("ru");
  const v = displayBookTitle({ id: "book-fallback", title: "   ", titleRu: "\t\t", titleEn: "  " });
  assert.equal(v, "book-fallback");
});

/* ─── displayBookTitle: en locale fallback chain ──────────────────── */

test("[display-meta] displayBookTitle/en: titleEn выигрывает приоритет", () => {
  setLocale("en");
  const v = displayBookTitle({
    id: "abc", title: "Original", titleRu: "Русское", titleEn: "English",
  });
  assert.equal(v, "English");
  setLocale("ru");
});

test("[display-meta] displayBookTitle/en: fallback titleEn → title", () => {
  setLocale("en");
  const v = displayBookTitle({
    id: "abc", title: "Original", titleRu: "Русское",
  });
  assert.equal(v, "Original");
  setLocale("ru");
});

test("[display-meta] displayBookTitle/en: fallback title → titleRu", () => {
  setLocale("en");
  const v = displayBookTitle({
    id: "abc", title: "", titleRu: "Русское",
  });
  assert.equal(v, "Русское");
  setLocale("ru");
});

/* ─── displayBookAuthor ────────────────────────────────────────── */

test("[display-meta] displayBookAuthor/ru: authorRu приоритет", () => {
  setLocale("ru");
  const v = displayBookAuthor({
    author: "Original", authorRu: "Винер Н.", authorEn: "Wiener N.",
  });
  assert.equal(v, "Винер Н.");
});

test("[display-meta] displayBookAuthor/en: authorEn приоритет", () => {
  setLocale("en");
  const v = displayBookAuthor({
    author: "Original", authorRu: "Винер Н.", authorEn: "Wiener N.",
  });
  assert.equal(v, "Wiener N.");
  setLocale("ru");
});

test("[display-meta] displayBookAuthor: пустые поля → пустая строка (НЕ 'unknown')", () => {
  /* Критично: пустой автор → "", не «Unknown» или placeholder. UI решает
     что показывать в пустой ячейке (у них разные i18n keys). */
  setLocale("ru");
  assert.equal(displayBookAuthor({}), "");
});

test("[display-meta] displayBookAuthor: trim whitespace", () => {
  setLocale("ru");
  assert.equal(displayBookAuthor({ authorRu: "  Винер Н.  " }), "Винер Н.");
});

/* ─── bookTitleTooltip ────────────────────────────────────────── */

test("[display-meta] bookTitleTooltip: показан один titleRu, orig совпадает → без дублирования", () => {
  setLocale("ru");
  /* shown=Русское, title=Русское, titleRu=Русское → всё совпадает → parts=[shown]. */
  const v = bookTitleTooltip({ title: "Русское", titleRu: "Русское" });
  assert.equal(v, "Русское");
});

test("[display-meta] bookTitleTooltip: orig отличается → добавляется 'orig:'", () => {
  setLocale("ru");
  /* shown=titleRu, orig=title отличается → "orig: ..." в tooltip. */
  const v = bookTitleTooltip({ title: "Original Eng", titleRu: "Русское" });
  assert.match(v, /Русское/);
  assert.match(v, /orig: Original Eng/);
});

test("[display-meta] bookTitleTooltip: все alternates разные → все включены", () => {
  setLocale("ru");
  const v = bookTitleTooltip({
    title: "Orig", titleRu: "Рус", titleEn: "En",
  });
  /* shown="Рус" (locale=ru wins), дальше orig+altEn (altRu = shown → skip). */
  assert.match(v, /Рус/);
  assert.match(v, /orig: Orig/);
  assert.match(v, /EN: En/);
});

/* ─── displayBookTags ─────────────────────────────────────────── */

test("[display-meta] displayBookTags/ru: непустой tagsRu выигрывает", () => {
  setLocale("ru");
  const v = displayBookTags({
    tags: ["theory", "book"], tagsRu: ["теория", "книга"],
  });
  assert.deepEqual(v, ["теория", "книга"]);
});

test("[display-meta] displayBookTags/ru: пустой tagsRu → fallback на tags", () => {
  /* Критично: если ev. не сгенерировал tagsRu (редкий баг),
     показываем en вместо пустой полосы. */
  setLocale("ru");
  const v = displayBookTags({ tags: ["theory"], tagsRu: [] });
  assert.deepEqual(v, ["theory"]);
});

test("[display-meta] displayBookTags/en: зеркально — tags приоритет", () => {
  setLocale("en");
  const v = displayBookTags({
    tags: ["theory"], tagsRu: ["теория"],
  });
  assert.deepEqual(v, ["theory"]);
  setLocale("ru");
});

test("[display-meta] displayBookTags/en: пустой tags → fallback на tagsRu", () => {
  setLocale("en");
  const v = displayBookTags({ tags: [], tagsRu: ["теория"] });
  assert.deepEqual(v, ["теория"]);
  setLocale("ru");
});

test("[display-meta] displayBookTags: оба пустых → пустой array", () => {
  setLocale("ru");
  assert.deepEqual(displayBookTags({ tags: [], tagsRu: [] }), []);
  assert.deepEqual(displayBookTags({}), []);
});

test("[display-meta] displayBookTags: non-array → пустой array (defensive)", () => {
  /* Если frontmatter или IPC вернет tags=null/string/object, displayBookTags
     не должен упасть или вернуть гарбаж — вернёт []. */
  setLocale("ru");
  /* @ts-expect-error — явный narrow violation для теста. */
  assert.deepEqual(displayBookTags({ tags: null, tagsRu: "not-array" }), []);
});
