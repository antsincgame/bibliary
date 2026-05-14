/**
 * Регрессионные тесты для DjVu улучшений (bf0f1d7+):
 *   1. paragraphsToSections с bookmarks — главы получают real titles
 *      из DjVu outline вместо безликих "Page N"
 *   2. paragraphsToSections без bookmarks — backwards-compatible fallback
 *   3. Bookmark на странице БЕЗ paragraphs не падает
 *   4. Bookmark на pageIndex который не совпадает ни с одной paragraph
 *      page — игнорируется (paragraphs определяет какие sections появятся)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { paragraphsToSections } from "../server/lib/scanner/parsers/djvu.ts";

test("paragraphsToSections: с bookmarks — главы получают titles из outline", () => {
  const paragraphs = [
    { page: 1, text: "Введение в тему. Первый абзац." },
    { page: 1, text: "Второй абзац введения." },
    { page: 5, text: "Начало первой главы. Текст." },
    { page: 5, text: "Продолжение первой главы." },
    { page: 12, text: "Начало второй главы. Текст." },
  ];
  /* Bookmark.pageIndex 0-based; в paragraphs page 1-based. Соответствие:
     pageIndex 0 → page 1, pageIndex 4 → page 5, pageIndex 11 → page 12 */
  const bookmarks = [
    { title: "Введение", pageIndex: 0 },
    { title: "Глава 1. Основы", pageIndex: 4 },
    { title: "Глава 2. Углубление", pageIndex: 11 },
  ];

  const sections = paragraphsToSections(paragraphs, bookmarks);

  assert.equal(sections.length, 3, "должны быть 3 секции (по числу страниц с paragraphs)");
  assert.equal(sections[0]!.title, "Введение");
  assert.equal(sections[1]!.title, "Глава 1. Основы");
  assert.equal(sections[2]!.title, "Глава 2. Углубление");
  assert.equal(sections[0]!.paragraphs.length, 2, "введение: 2 абзаца");
  assert.equal(sections[1]!.paragraphs.length, 2);
  assert.equal(sections[2]!.paragraphs.length, 1);
});

test("paragraphsToSections: без bookmarks — fallback на 'Page N' (backwards compat)", () => {
  const paragraphs = [
    { page: 1, text: "Первый абзац." },
    { page: 2, text: "Второй абзац." },
  ];

  const sections = paragraphsToSections(paragraphs);

  assert.equal(sections.length, 2);
  assert.equal(sections[0]!.title, "Page 1");
  assert.equal(sections[1]!.title, "Page 2");
});

test("paragraphsToSections: bookmarks на странице БЕЗ paragraphs игнорируются", () => {
  const paragraphs = [
    { page: 5, text: "Текст пятой страницы." },
  ];
  const bookmarks = [
    { title: "Несуществующая глава", pageIndex: 99 },
    { title: "Глава 1", pageIndex: 4 },
  ];

  const sections = paragraphsToSections(paragraphs, bookmarks);

  assert.equal(sections.length, 1);
  assert.equal(sections[0]!.title, "Глава 1");
});

test("paragraphsToSections: смешанный сценарий — частичный outline", () => {
  /* Реалистичная ситуация: DjVu имеет outline только для основных глав,
     promezhutochnye страницы получают "Page N". */
  const paragraphs = [
    { page: 1, text: "Титульный лист." },     /* нет bookmark */
    { page: 3, text: "Содержание." },          /* нет bookmark */
    { page: 5, text: "Текст главы 1." },       /* bookmark "Глава 1" */
    { page: 50, text: "Текст главы 2." },      /* bookmark "Глава 2" */
  ];
  const bookmarks = [
    { title: "Глава 1", pageIndex: 4 },
    { title: "Глава 2", pageIndex: 49 },
  ];

  const sections = paragraphsToSections(paragraphs, bookmarks);

  assert.equal(sections.length, 4);
  assert.equal(sections[0]!.title, "Page 1");        /* fallback */
  assert.equal(sections[1]!.title, "Page 3");        /* fallback */
  assert.equal(sections[2]!.title, "Глава 1");       /* from bookmark */
  assert.equal(sections[3]!.title, "Глава 2");       /* from bookmark */
});

test("paragraphsToSections: пустой массив paragraphs → пустые sections (без crash)", () => {
  const sections = paragraphsToSections([], [{ title: "X", pageIndex: 0 }]);
  assert.deepEqual(sections, []);
});
