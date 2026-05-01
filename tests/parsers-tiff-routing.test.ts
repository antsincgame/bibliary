/**
 * TIFF routing test (Iter 6В): single-page TIFF → imageParser, multi-page
 * → convertMultiTiff → pdfParser.
 *
 * Не создаём реальный multi-page TIFF (sharp generation сложна в тестах) —
 * проверяем что:
 *   1. Невалидный/пустой TIFF файл → fallback на imageParser (graceful)
 *   2. detectExt('.tif') возвращает 'tif' (зарегистрировано через PARSERS)
 *   3. parseBook на .tif вызывает tiffParser.parse, не imageParser.parse напрямую
 *      (косвенно через success без throw на graceful path)
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { detectExt, parseBook } from "../electron/lib/scanner/parsers/index.js";
import { tiffParser, tiffAlternateParser } from "../electron/lib/scanner/parsers/tiff.js";

test("Iter 6В: tiffParser зарегистрирован для .tif", () => {
  assert.equal(detectExt("/scan/page.tif"), "tif");
  assert.equal(tiffParser.ext, "tif");
});

test("Iter 6В: tiffAlternateParser зарегистрирован для .tiff", () => {
  assert.equal(detectExt("/scan/page.tiff"), "tiff");
  assert.equal(tiffAlternateParser.ext, "tiff");
});

test("Iter 6В: невалидный .tif файл → graceful (не throw, fallback на imageParser)", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "bibliary-tiff-bad-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const file = path.join(dir, "fake.tif");
  await writeFile(file, Buffer.from("not a real TIFF"));

  /* Должен вернуть результат, не throw. getTiffPageCount → 1 (graceful) →
     fallback на imageParser → может вернуть пустой sections с warnings. */
  const parsed = await parseBook(file);
  assert.ok(parsed, "parseBook на невалидном .tif должен вернуть результат");
  assert.ok(Array.isArray(parsed.sections));
});

test("Iter 6В: пустой .tif файл → graceful с warnings", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "bibliary-tiff-empty-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const file = path.join(dir, "empty.tif");
  await writeFile(file, Buffer.alloc(0));

  const parsed = await parseBook(file);
  assert.equal(parsed.sections.length, 0);
  assert.ok(parsed.metadata.warnings.length > 0, "пустой TIFF должен дать warnings");
});

test("Iter 6В: tiffParser direct call → routing выполняется", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "bibliary-tiff-direct-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const file = path.join(dir, "single.tif");
  await writeFile(file, Buffer.from("not real"));

  /* Direct call к tiffParser.parse — должен вернуть результат, не throw. */
  const parsed = await tiffParser.parse(file);
  assert.ok(parsed);
  assert.ok(Array.isArray(parsed.sections));
});

test("Iter 6В: AbortSignal респектируется в TIFF routing", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "bibliary-tiff-abort-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const file = path.join(dir, "abort.tif");
  await writeFile(file, Buffer.from("data"));

  const ctl = new AbortController();
  ctl.abort();

  /* Должен не throw — graceful с warnings. */
  const parsed = await tiffParser.parse(file, { signal: ctl.signal });
  assert.ok(parsed);
});
