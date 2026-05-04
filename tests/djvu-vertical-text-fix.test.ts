/**
 * Регрессионный тест: DjVu вёрстка «слово на строку» (Iter 14.5, 2026-05-04).
 *
 * Симптом со скриншота: DjVu файл «Алгоритмические языки реального времени»
 * после импорта показывался как вертикальный столбик букв — каждая буква
 * на отдельной строке, потому что встроенный текстовый слой DjVu давал
 * фрагменты вида «К о н с т р у и р о в а н и е».
 *
 * Корень: `paragraphsToSections` в `djvu.ts` НЕ склеивал одиночные `\n` в
 * пробелы (в отличие от `textToSections` для full-doc пути) — каждый
 * параграф попадал в Markdown как многострочный блок и Versator рендерил
 * это как «слово на строку».
 *
 * Фикс: применяется `text.replace(/\n/g, " ")` перед добавлением в
 * paragraphs, как делает full-doc ветка.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { paragraphsToSections } from "../electron/lib/scanner/parsers/djvu.ts";

test("djvu paragraphsToSections: одиночные \\n склеиваются в пробелы", () => {
  /* Вход: «вертикальный» текст из DjVu OCR — слово на строку. */
  const input = [
    { page: 1, text: "Конструирование\nи\nразработка\nалгоритмов" },
  ];
  const sections = paragraphsToSections(input);

  assert.equal(sections.length, 1, "Должна быть одна секция");
  const para = sections[0]!.paragraphs[0]!;

  /* После фикса абзац должен быть ОДНОЙ строкой со пробелами. */
  assert.equal(para, "Конструирование и разработка алгоритмов",
    `Ожидаем плоский абзац, получили: «${para}»`);

  /* Главная инвариантность: НЕ должно быть переносов внутри абзаца. */
  assert.ok(!para.includes("\n"),
    `BUG REGRESSION: одиночные \\n остались в абзаце: «${para}»`);
});

test("djvu paragraphsToSections: множественные пробелы schrumpfen в один", () => {
  const input = [
    { page: 1, text: "Слово\n\nещё\nодно   слово" },
  ];
  const sections = paragraphsToSections(input);
  const para = sections[0]!.paragraphs[0]!;
  assert.ok(!para.includes("  "),
    `Двойные пробелы остались: «${para}»`);
});

test("djvu paragraphsToSections: разные страницы → разные секции", () => {
  const input = [
    { page: 1, text: "Текст с\nпервой страницы" },
    { page: 2, text: "Текст со\nвторой страницы" },
  ];
  const sections = paragraphsToSections(input);
  assert.equal(sections.length, 2, "Должно быть 2 секции");
  assert.equal(sections[0]!.paragraphs[0], "Текст с первой страницы");
  assert.equal(sections[1]!.paragraphs[0], "Текст со второй страницы");
});

test("djvu paragraphsToSections: пустой input → пустой результат", () => {
  assert.deepEqual(paragraphsToSections([]), []);
});

test("djvu paragraphsToSections: только пробелы / \\n → секция отбрасывается", () => {
  const input = [
    { page: 1, text: "   \n\n   \n" },
  ];
  const sections = paragraphsToSections(input);
  assert.equal(sections.length, 0,
    "Секция без полезного контента должна отброситься");
});

test("djvu paragraphsToSections: реальный паттерн из скрина — таблица контента", () => {
  /* Это упрощённое воспроизведение того, что было видно на скрине
   * «Алгоритмические языки реального»: левая колонка из коротких слов. */
  const input = [
    {
      page: 1,
      text: "К\nо\nн\nс\nт\nр\nу\nи\nр\nо\nв\nа\nн\nи\nе",
    },
  ];
  const sections = paragraphsToSections(input);
  /* После фикса все буквы склеиваются в одну строку (без пробелов между
   * буквами т.к. изначально в исходнике не было пробелов между ними —
   * это и было главной катастрофой). Тест документирует поведение:
   * мы превращаем «столбец букв» в одну строку. */
  const para = sections[0]?.paragraphs[0];
  assert.ok(para && !para.includes("\n"),
    `BUG REGRESSION: вертикальный текст не сглажен: «${para}»`);
});
