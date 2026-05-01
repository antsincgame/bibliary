/**
 * Regression test: .rb файлы НЕ распознаются как book formats.
 *
 * Контекст: в Iter 6Б .rb был ошибочно зарегистрирован как Rocket eBook
 * (deprecated 2003). Разведка реальной библиотеки D:\Bibliarifull показала
 * 921 файл .rb — все Ruby исходники. Iter 6В откатил эту регистрацию.
 *
 * Этот тест предотвращает повторное добавление .rb в SupportedExt.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { detectExt, isSupportedBook, parseBook } from "../electron/lib/scanner/parsers/index.js";
import { SUPPORTED_BOOK_EXTS } from "../electron/lib/library/types.js";
import { CALIBRE_INPUT_EXTS } from "../electron/lib/scanner/converters/index.js";

test("Iter 6В regression: .rb НЕ в SupportedExt", () => {
  const ext = detectExt("/some/script.rb");
  /* detectExt должен НЕ распознать .rb как поддерживаемое расширение книги. */
  assert.equal(ext, null, "detectExt('.rb') должен вернуть null — .rb не книга");
});

test("Iter 6В regression: .rb НЕ в SUPPORTED_BOOK_EXTS", () => {
  /* TypeScript-уровневая защита: .rb не должен быть в SupportedBookFormat union.
     SUPPORTED_BOOK_EXTS — Set<SupportedBookFormat>, но проверим runtime тоже. */
  const set = SUPPORTED_BOOK_EXTS as ReadonlySet<string>;
  assert.equal(set.has("rb"), false, "SUPPORTED_BOOK_EXTS не должен содержать 'rb'");
});

test("Iter 6В regression: .rb НЕ в CALIBRE_INPUT_EXTS (sherlok find)", () => {
  /* Sherlok нашёл забытый хвост: после удаления .rb из всех 6 файлов в Iter 6В
     осталось упоминание в converters/index.ts:CALIBRE_INPUT_EXTS. Этот тест
     ловит подобные регрессии: convertToParseable проверяет CALIBRE_INPUT_EXTS,
     если .rb там — Calibre будет вызван даже когда parseBook reject'нет файл. */
  assert.equal(
    CALIBRE_INPUT_EXTS.has("rb"),
    false,
    "CALIBRE_INPUT_EXTS не должен содержать 'rb' (Ruby исходники)",
  );
});

test("Iter 6В regression: isSupportedBook('.rb') === false", () => {
  assert.equal(
    isSupportedBook("/lib/script.rb"),
    false,
    "isSupportedBook должен возвращать false для .rb (Ruby исходник)",
  );
});

test("Iter 6В regression: parseBook на .rb файле бросает unsupported", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "bibliary-rb-regression-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const file = path.join(dir, "fibonacci.rb");
  await writeFile(file, Buffer.from("def fib(n)\n  n < 2 ? n : fib(n-1) + fib(n-2)\nend\n"));

  /* parseBook должен бросать "unsupported" для .rb. */
  await assert.rejects(
    parseBook(file),
    /unsupported|not.+supported/i,
    "parseBook(.rb) должен бросать unsupported, не пытаться импортировать как book",
  );
});

test("Iter 6В regression: типичный Ruby файл из реальной библиотеки имитируется", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "bibliary-rb-real-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  /* Имитация реального файла из D:\Bibliarifull\...\code\arrays\add.rb (~100 байт). */
  const rubyContent = Buffer.from(`# Add elements to array
arr = [1, 2, 3]
arr << 4
arr.push(5)
puts arr.inspect
`);
  const file = path.join(dir, "add.rb");
  await writeFile(file, rubyContent);

  /* Должно реджектиться на уровне detectExt — раньше парсера. */
  assert.equal(isSupportedBook(file), false);
  await assert.rejects(parseBook(file), /unsupported/i);
});
