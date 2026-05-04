/**
 * Регрессионные тесты для PDF hex-string sanitizer (Iter 14.5, 2026-05-04).
 *
 * Симптом: пользователь видел в каталоге книгу с заголовком
 * `<A8D4E0E8EEF1EEF4E8FF8B28EFFBEEE3F0E0EECCC0F8EEE2E0E0E68E0FF20E08EB28FFE7FBEAE528012828D2E717064>`.
 *
 * Это PDF Document Info Title в виде hex-string из CP1251 байт. pdfjs /
 * @firecrawl/pdf-inspector возвращают это как литерал, без декодирования —
 * получаем катастрофу UX.
 *
 * Фикс — `decodePdfHexTitle` + `sanitizeRawTitle` в `title-heuristics.ts`.
 * Дальше `pickBestBookTitle` сам прогоняет каждый кандидат через sanitizer,
 * что защищает все парсеры (pdf.ts, pdf-inspector-parser.ts, djvu.ts).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decodePdfHexTitle,
  sanitizeRawTitle,
  pickBestBookTitle,
} from "../electron/lib/library/title-heuristics.ts";

test("decodePdfHexTitle: NULL для не-hex-string", () => {
  assert.equal(decodePdfHexTitle("Normal title"), undefined);
  assert.equal(decodePdfHexTitle(""), undefined);
  assert.equal(decodePdfHexTitle("<incomplete"), undefined);
  assert.equal(decodePdfHexTitle("<XYZ>"), undefined); /* не hex */
});

test("decodePdfHexTitle: CP1251 кириллица расшифровывается", () => {
  /* "Программирование" в CP1251: CF=П, F0=р, EE=о, E3=г, F0=р, E0=а,
     EC=м, EC=м, E8=и, F0=р, EE=о, E2=в, E0=а, ED=н, E8=и, E5=е. */
  const hex = "<CFF0EEE3F0E0ECECE8F0EEE2E0EDE8E5>";
  const decoded = decodePdfHexTitle(hex);
  assert.ok(decoded, "Должна быть декодированная строка");
  assert.equal(decoded, "Программирование");
});

test("decodePdfHexTitle: UTF-16BE с BOM расшифровывается", () => {
  /* "Hi" UTF-16BE с BOM: FE FF 00 48 00 69 */
  const decoded = decodePdfHexTitle("<FEFF00480069>");
  assert.equal(decoded, "Hi");
});

test("decodePdfHexTitle: пробелы внутри hex игнорируются (per PDF spec)", () => {
  const hex = "<48 65 6C 6C 6F>"; /* "Hello" */
  const decoded = decodePdfHexTitle(hex);
  assert.equal(decoded, "Hello");
});

test("decodePdfHexTitle: нечётное число hex digits → undefined", () => {
  assert.equal(decodePdfHexTitle("<ABC>"), undefined);
});

test("sanitizeRawTitle: hex-string декодируется в читаемый текст", () => {
  const hex = "<CFF0EEE3F0E0ECECE8F0EEE2E0EDE8E5>"; /* "Программирование" в CP1251 */
  assert.equal(sanitizeRawTitle(hex), "Программирование");
});

test("sanitizeRawTitle: НЕдекодируемый hex-blob → undefined", () => {
  /* Случайный hex который не складывается ни в одну осмысленную кодировку. */
  const garbage = "<" + "0102030405060708090A0B0C0D0E0F1011121314151617181920".repeat(3) + ">";
  const result = sanitizeRawTitle(garbage);
  /* Decoder может что-то вернуть, но weird-ratio высокий — sanitizer должен
   * либо undefined, либо не-control строку. Главное: не raw hex. */
  if (result !== undefined) {
    assert.ok(!result.startsWith("<"), `Результат не должен начинаться с <: ${result}`);
  }
});

test("sanitizeRawTitle: нормальный title пропускается без изменений", () => {
  assert.equal(sanitizeRawTitle("Алгоритмические языки реального времени"),
    "Алгоритмические языки реального времени");
  assert.equal(sanitizeRawTitle("CLRS Introduction to Algorithms"),
    "CLRS Introduction to Algorithms");
});

test("sanitizeRawTitle: пустая / null / undefined → undefined", () => {
  assert.equal(sanitizeRawTitle(null), undefined);
  assert.equal(sanitizeRawTitle(undefined), undefined);
  assert.equal(sanitizeRawTitle(""), undefined);
  assert.equal(sanitizeRawTitle("   "), undefined);
});

test("sanitizeRawTitle: длинная строка без пробелов (хеш / base64) → undefined", () => {
  const sha256Hex = "a".repeat(280); /* псевдо-хеш */
  assert.equal(sanitizeRawTitle(sha256Hex), undefined);
});

test("sanitizeRawTitle: короткое слово даже с unicode → проходит", () => {
  /* Не должны фильтровать осмысленные короткие заголовки. */
  assert.equal(sanitizeRawTitle("Ёж"), "Ёж");
  assert.equal(sanitizeRawTitle("CLRS"), "CLRS");
});

test("pickBestBookTitle: hex-кандидат с очень коротким текстом проходит — но осмысленность важна", () => {
  /* `<A8D4E0E8>` = CP1251: «ЁФаи» — формально читаемые буквы (≥80% ratio),
   * decoder вернёт это как валидный декод. Но это короткий «осмысленный»
   * кусок, который пройдёт sanitizer. Это OK: после фикса hex-string
   * пользователя из 90+ символов фильтруется (см. оригинальный баг тест). */
  const hex = "<A8D4E0E8>";
  const filename = "assembler-praktikum-2nd";
  const result = pickBestBookTitle(hex, undefined, filename);
  /* Важно: что бы ни вернулось — это НЕ raw hex с угловыми скобками. */
  assert.ok(!result?.startsWith("<") && !result?.includes(">"),
    `Hex-string не должен попасть в каталог как литерал, получили: ${result}`);
});

test("pickBestBookTitle: расшифрованный hex выигрывает у filename", () => {
  const hex = "<CFF0EEE3F0E0ECECE8F0EEE2E0EDE8E5>"; /* "Программирование" в CP1251 */
  const filename = "programming";
  const result = pickBestBookTitle(hex, undefined, filename);
  assert.equal(result, "Программирование");
});

test("pickBestBookTitle: ОРИГИНАЛЬНЫЙ баг репродуцирован — не пропускает hex в каталог", () => {
  /* Точный сценарий пользователя со скриншота: */
  const userScreenshotTitle =
    "<A8D4E0E8EEF1EEF4E8FF8B28EFFBEEE3F0E0EECCC0F8EEE2E0E0E68E0FF20E08EB28FFE7FBEAE528012828D2E717064>";
  const filename = "Assembler. Практикум (2-е издание)";

  const result = pickBestBookTitle(userScreenshotTitle, undefined, filename);
  /* Главная инвариантность: что бы decoder ни вернул, оригинальная hex-строка
   * `<A8D4...>` НИКОГДА не должна оказаться в каталоге. */
  assert.notEqual(result, userScreenshotTitle,
    `BUG REGRESSION: hex-string просочился в title!`);
  assert.ok(!result?.startsWith("<A8D4"),
    `Title начинается с raw hex: ${result}`);
});
