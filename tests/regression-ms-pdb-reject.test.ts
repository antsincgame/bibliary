/**
 * Regression test: Microsoft .pdb (Program Database, debug symbols от Visual
 * Studio) reject'ится magic guard'ом — НЕ передаётся в Calibre.
 *
 * Контекст: разведка реальной библиотеки D:\Bibliarifull обнаружила что все
 * 99 файлов .pdb в библиотеке = MS Program Database, не Palm Database eBook.
 * Без этой защиты они отправлялись бы в ebook-convert.exe и тратили ресурсы
 * на ошибочный convert.
 *
 * Iter 6В: добавлен `isMicrosoftPdb()` check в `isCalibreLegacyContainer`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { verifyExtMatchesContent } from "../electron/lib/library/import-magic-guard.js";

/* Реальная сигнатура MS PDB: "Microsoft C/C++ MSF 7.00\r\n\x1a\x44\x53\x00\x00\x00".
   Первые 32 байта реального .pdb файла из Visual Studio. */
const MS_PDB_HEADER = Buffer.concat([
  Buffer.from("Microsoft C/C++ MSF 7.00\r\n", "ascii"),
  Buffer.from([0x1a, 0x44, 0x53, 0x00, 0x00, 0x00]),
  /* Padding до 80 байт чтобы пройти MIN_HEAD_FOR_BINARY check. */
  Buffer.alloc(48, 0x00),
]);

test("Iter 6В regression: MS PDB reject'ится magic guard'ом", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "bibliary-mspdb-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const file = path.join(dir, "Ninject.pdb");
  await writeFile(file, MS_PDB_HEADER);

  const result = await verifyExtMatchesContent(file, "pdb");
  assert.equal(result.ok, false, "MS PDB должен быть отвергнут");
  assert.match(result.reason ?? "", /Microsoft|debug symbols|not Palm/i);
});

test("Iter 6В regression: валидный Palm DB header принимается", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "bibliary-palmdb-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  /* Минимальный Palm DB header: 60 байт padding + "BOOKMOBI" type на оффсете 60. */
  const palmHeader = Buffer.concat([
    Buffer.alloc(60, 0x00), /* db name + flags + dates */
    Buffer.from("BOOKMOBI", "ascii"), /* type+creator на offset 60 */
    Buffer.alloc(20, 0x00), /* остальная часть header */
  ]);

  const file = path.join(dir, "test.pdb");
  await writeFile(file, palmHeader);

  const result = await verifyExtMatchesContent(file, "pdb");
  assert.equal(result.ok, true, "Валидный Palm DB должен пройти guard");
});

test("Iter 6В regression: типичный Visual Studio .pdb из реальной библиотеки", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "bibliary-vs-pdb-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  /* Имитация Ninject.pdb / EssentialTools.pdb / etc. из D:\Bibliarifull. */
  const file = path.join(dir, "Ninject.pdb");
  await writeFile(file, MS_PDB_HEADER);

  const result = await verifyExtMatchesContent(file, "pdb");
  assert.equal(result.ok, false);
});
