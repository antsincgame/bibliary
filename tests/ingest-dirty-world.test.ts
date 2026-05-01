/**
 * Грязные тесты ingest-pipeline:
 *   - UTF-16 LE / BE с BOM и без него
 *   - UTF-8 с BOM
 *   - Пустой файл
 *   - «Битый PDF» (header не PDF)
 *   - Гигантский TXT (синтетика, чтобы проверить, что не рушится по памяти)
 *
 * Цель: parseBook никогда не выкидывает unrecoverable error на «грязном»
 * файле — он либо парсит, либо возвращает осмысленный warning.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";

import { parseBook } from "../electron/lib/scanner/parsers/index.ts";
import { decodeTextAuto } from "../electron/lib/scanner/parsers/txt.ts";

async function tmpDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "bibliary-dirty-"));
}

/* ─── decodeTextAuto unit tests ──────────────────────────────────────── */

test("decodeTextAuto: UTF-16 LE with BOM (FF FE) → text decoded", () => {
  /* "Привет мир" в UTF-16 LE: BOM + по 2 байта на символ */
  const text = "Привет мир";
  const buf = Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from(text, "utf16le"),
  ]);
  const r = decodeTextAuto(buf);
  assert.equal(r.encoding, "utf-16le");
  assert.equal(r.text, text);
});

test("decodeTextAuto: UTF-16 BE with BOM (FE FF) → text decoded", () => {
  const text = "Hello";
  /* Encode in UTF-16 BE manually: pad+swap. */
  const le = Buffer.from(text, "utf16le");
  const be = Buffer.allocUnsafe(le.length);
  for (let i = 0; i < le.length; i += 2) {
    be[i] = le[i + 1]!;
    be[i + 1] = le[i]!;
  }
  const buf = Buffer.concat([Buffer.from([0xfe, 0xff]), be]);
  const r = decodeTextAuto(buf);
  assert.equal(r.encoding, "utf-16be");
  assert.equal(r.text, text);
});

test("decodeTextAuto: UTF-8 BOM (EF BB BF) → BOM stripped", () => {
  const text = "Hello";
  const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, "utf8")]);
  const r = decodeTextAuto(buf);
  assert.equal(r.encoding, "utf-8-bom");
  assert.equal(r.text, text);
});

test("decodeTextAuto: UTF-16 LE without BOM (Windows export) → heuristic detects via NUL ratio", () => {
  const text = "Hello world long enough text so heuristic kicks in correctly";
  const buf = Buffer.from(text, "utf16le"); /* no BOM */
  const r = decodeTextAuto(buf);
  assert.equal(r.encoding, "utf-16le-noBOM");
  assert.equal(r.text, text);
  assert.ok(r.warnings.some((w) => w.includes("utf-16le")));
});

test("decodeTextAuto: pure ASCII → utf-8", () => {
  const buf = Buffer.from("hello world", "utf8");
  const r = decodeTextAuto(buf);
  assert.equal(r.encoding, "utf-8");
  assert.equal(r.text, "hello world");
});

/* ─── End-to-end через parseBook ─────────────────────────────────────── */

test("parseBook: TXT с UTF-16 LE BOM читается правильно", async (t) => {
  const dir = await tmpDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "win-export.txt");
  const text = "Глава 1\n\nЭто первый параграф книги.\n\nЭто второй параграф.";
  const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
  await writeFile(file, buf);

  const r = await parseBook(file);
  assert.ok(r.metadata.warnings.some((w) => w.includes("utf-16le")), `expected utf-16le warning, got: ${r.metadata.warnings.join("|")}`);
  /* Реальный текст должен быть в секциях. */
  const allText = r.sections.map((s) => `${s.title}\n${s.paragraphs.join(" ")}`).join("\n");
  assert.match(allText, /Это первый параграф/);
  assert.match(allText, /Это второй параграф/);
});

test("parseBook: пустой TXT не падает, warnings содержат 'empty file'", async (t) => {
  const dir = await tmpDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "empty.txt");
  await writeFile(file, "");

  const r = await parseBook(file);
  assert.ok(r.metadata.warnings.includes("empty file"));
  assert.equal(r.rawCharCount, 0);
});

test("parseBook: TXT с CRLF (Windows line endings) разбивает параграфы", async (t) => {
  const dir = await tmpDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "crlf.txt");
  await writeFile(file, "Hello\r\n\r\nSecond paragraph here.\r\n", "utf8");

  const r = await parseBook(file);
  /* Параграфы должны распарситься (\r\n\r\n считается separator). */
  const allText = r.sections.flatMap((s) => s.paragraphs).join(" ");
  assert.match(allText, /Hello/);
  assert.match(allText, /Second paragraph/);
});

test("parseBook: «битый PDF» (header не %PDF) возвращает warning и не падает", async (t) => {
  const dir = await tmpDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "broken.pdf");
  /* Не начинается с %PDF и не имеет минимальной структуры */
  await writeFile(file, Buffer.from("This is NOT a PDF file at all 12345"));
  const r = await parseBook(file);
  assert.equal(r.sections.length, 0, "broken PDF should not produce sections");
  assert.ok(r.metadata.warnings.length > 0, "must contain parser warning");
  assert.ok(
    r.metadata.warnings.some((w) => /pdf parse failed|invalidpdf|failed/i.test(w)),
    `expected parse-failed warning, got: ${r.metadata.warnings.join("|")}`,
  );
});

test("parseBook: TXT с большим текстом (1MB) не падает по памяти", async (t) => {
  const dir = await tmpDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "big.txt");
  /* 1 MB искусственного текста с параграфами */
  const para = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(20);
  const text = (`Chapter 1\n\n${para}\n\n`).repeat(500);
  await writeFile(file, text, "utf8");

  const t0 = Date.now();
  const r = await parseBook(file);
  const elapsed = Date.now() - t0;
  assert.ok(r.sections.length > 0, "must produce at least one section");
  assert.ok(r.rawCharCount > 500_000, `expected >500K chars, got ${r.rawCharCount}`);
  assert.ok(elapsed < 5000, `parse should complete in <5s, took ${elapsed}ms`);
});

test("parseBook: TXT, начинающийся с UTF-8 BOM, не теряет первый символ", async (t) => {
  const dir = await tmpDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "utf8-bom.txt");
  await writeFile(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("First word here", "utf8")]));

  const r = await parseBook(file);
  const allText = r.sections.flatMap((s) => s.paragraphs).join(" ");
  /* Старая версия после среза BOM всё равно работала корректно — но
     зафиксируем поведением. */
  assert.match(allText, /First word/);
});
