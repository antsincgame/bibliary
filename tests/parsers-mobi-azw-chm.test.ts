/**
 * Parser registration smoke tests для Calibre-cascade форматов.
 *
 * НЕ требует установленного Calibre — проверяет регистрацию в PARSERS,
 * дисциплину graceful degradation (parseBook на .mobi возвращает пустой
 * ParseResult с warnings вместо throw).
 *
 * Реальная end-to-end конвертация (с установленным Calibre на CI) —
 * отдельная задача (e2e suite не в обычных unit tests).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { parseBook, detectExt, isSupportedBook } from "../electron/lib/scanner/parsers/index.js";
import { SUPPORTED_BOOK_EXTS } from "../electron/lib/library/types.js";

const CALIBRE_EXTS = ["mobi", "azw", "azw3", "pdb", "prc", "chm"] as const;

test("Calibre extensions зарегистрированы в SupportedExt и SUPPORTED_BOOK_EXTS", () => {
  for (const ext of CALIBRE_EXTS) {
    assert.equal(detectExt(`/path/to/file.${ext}`), ext, `detectExt should recognize .${ext}`);
    assert.equal(isSupportedBook(`/path/to/file.${ext}`), true, `${ext} should be supported`);
    assert.ok(SUPPORTED_BOOK_EXTS.has(ext), `${ext} should be in SUPPORTED_BOOK_EXTS`);
  }
});

test("parseBook на невалидном .mobi → graceful empty result + warnings", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "bibliary-mobi-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const file = path.join(dir, "fake.mobi");
  await writeFile(file, Buffer.from("not a real mobi"));

  /* Не должен throw, должен вернуть пустой ParseResult с warnings. */
  const parsed = await parseBook(file);
  assert.equal(parsed.sections.length, 0);
  assert.ok(
    parsed.metadata.warnings.length > 0,
    `expected warnings about Calibre conversion failure, got: ${JSON.stringify(parsed.metadata.warnings)}`,
  );
});

test("parseBook на невалидном .chm → graceful empty result", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "bibliary-chm-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const file = path.join(dir, "fake.chm");
  await writeFile(file, Buffer.from("not a real chm"));

  const parsed = await parseBook(file);
  assert.equal(parsed.sections.length, 0);
  assert.ok(parsed.metadata.warnings.length > 0);
});

test("Все 6 Calibre-форматов имеют registered parser", async (t) => {
  /* Проходим по каждому ext — parseBook не должен throw "unsupported book extension". */
  const dir = await mkdtemp(path.join(os.tmpdir(), "bibliary-calibre-multi-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  for (const ext of CALIBRE_EXTS) {
    const file = path.join(dir, `test.${ext}`);
    await writeFile(file, Buffer.from("data"));

    /* Должен вернуть результат (пусть пустой), а НЕ throw. */
    const parsed = await parseBook(file);
    assert.ok(parsed, `parseBook should return result for .${ext}`);
    assert.ok(Array.isArray(parsed.sections), `sections should be array for .${ext}`);
  }
});
