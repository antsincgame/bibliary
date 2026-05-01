/**
 * Parser registration smoke tests для Iter 6Б форматов.
 *
 * НЕ требует Calibre/реального содержимого — проверяет регистрацию в
 * SupportedExt + PARSERS + SUPPORTED_BOOK_EXTS, плюс graceful degradation
 * на пустых файлах.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import JSZip from "jszip";

import { parseBook, detectExt, isSupportedBook } from "../electron/lib/scanner/parsers/index.js";
import { SUPPORTED_BOOK_EXTS } from "../electron/lib/library/types.js";

/* Iter 6В: .rb удалён из набора (Ruby исходники в реальных библиотеках). */
const ITER_6B_EXTS = ["cbz", "cbr", "tcr", "lit", "lrf", "snb"] as const;

test("Iter 6Б extensions зарегистрированы в SupportedExt и SUPPORTED_BOOK_EXTS", () => {
  for (const ext of ITER_6B_EXTS) {
    assert.equal(detectExt(`/path/to/file.${ext}`), ext, `detectExt должен распознать .${ext}`);
    assert.equal(isSupportedBook(`/path/to/file.${ext}`), true, `${ext} должен быть supported`);
    assert.ok(SUPPORTED_BOOK_EXTS.has(ext), `${ext} должен быть в SUPPORTED_BOOK_EXTS`);
  }
});

test("CBZ wrapper-парсер не throw на валидном но пустом ZIP", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "bibliary-cbz-parser-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const zip = new JSZip();
  zip.file("readme.txt", "empty");
  const cbzBuf = await zip.generateAsync({ type: "nodebuffer" });

  const file = path.join(dir, "empty.cbz");
  await writeFile(file, cbzBuf);

  const parsed = await parseBook(file);
  /* Должен вернуть результат (пустой), а не throw. */
  assert.equal(parsed.sections.length, 0);
  assert.ok(parsed.metadata.warnings.length > 0);
});

test("CBZ wrapper делегирует к pdfParser при наличии страниц", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "bibliary-cbz-deleg-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  /* Минимальный валидный 1×1 PNG. */
  const png = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
    0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x00, 0x00, 0x00, 0x00, 0x3a, 0x7e, 0x9b, 0x55, 0x00, 0x00, 0x00,
    0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x00, 0x00, 0x02,
    0x00, 0x01, 0xe5, 0x27, 0xde, 0xfc, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45,
    0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
  ]);

  const zip = new JSZip();
  zip.file("001.png", png);
  zip.file("002.png", png);
  const cbzBuf = await zip.generateAsync({ type: "nodebuffer" });

  const file = path.join(dir, "comic.cbz");
  await writeFile(file, cbzBuf);

  const parsed = await parseBook(file);
  /* PDF из 1×1 PNG = пустой текст после OCR. Главное — не throw, результат
     корректной формы (sections массив, warnings содержит инфо о конвертации). */
  assert.ok(Array.isArray(parsed.sections));
  assert.ok(parsed.metadata.warnings.length > 0);
  /* В warnings должна быть строка про CBZ→PDF конвертацию. */
  const warnText = parsed.metadata.warnings.join(" ");
  assert.match(warnText, /Converted CBZ.*PDF|cbz/i);
});

test("TCR/LIT/LRF/SNB — graceful через Calibre wrapper", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "bibliary-niche-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  /* Iter 6В: .rb удалён — Ruby исходники в реальных библиотеках. */
  for (const ext of ["tcr", "lit", "lrf", "snb"] as const) {
    const file = path.join(dir, `test.${ext}`);
    await writeFile(file, Buffer.from("not a real binary"));

    const parsed = await parseBook(file);
    assert.ok(parsed, `parseBook должен вернуть результат для .${ext}`);
    assert.ok(Array.isArray(parsed.sections), `sections должен быть array для .${ext}`);
    /* Без Calibre или с invalid input — пустой sections + warnings. */
    assert.equal(parsed.sections.length, 0);
  }
});

test("CBR требует 7z — graceful если нет, или конвертирует", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "bibliary-cbr-parser-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  /* Создаём fake CBR (не валидный RAR). 7z extraction должна упасть, обёртка
     должна вернуть пустой результат с warnings. */
  const file = path.join(dir, "fake.cbr");
  await writeFile(file, Buffer.from("not a rar"));

  const parsed = await parseBook(file);
  assert.equal(parsed.sections.length, 0);
  assert.ok(parsed.metadata.warnings.length > 0);
});
