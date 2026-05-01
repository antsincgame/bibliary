/**
 * Cross-format pre-dedup для Calibre-cascade форматов.
 *
 * Проверяет что приоритеты MOBI/AZW/AZW3/PDB/PRC/CHM настроены правильно:
 *   - EPUB и PDF по-прежнему выигрывают (структурированные форматы > legacy)
 *   - AZW3 > AZW = MOBI (KF8 модернее)
 *   - PDB = PRC (одинаковый Palm-формат)
 *   - CHM ниже всех (теряет TOC при конвертации)
 */

import { describe, it, beforeEach } from "node:test";
import { expect } from "./helpers/expect-shim.ts";
import * as path from "node:path";
import { CrossFormatPreDedup } from "../electron/lib/library/cross-format-prededup.js";

let dedup: CrossFormatPreDedup;

beforeEach(() => {
  dedup = new CrossFormatPreDedup();
});

describe("CrossFormatPreDedup — structured формат побеждает legacy", () => {
  it("EPUB побеждает MOBI с тем же basename", () => {
    const epubDecision = dedup.check(path.normalize("/lib/Book Title.epub"));
    const mobiDecision = dedup.check(path.normalize("/lib/Book Title.mobi"));
    expect(epubDecision.include).toBe(true);
    expect(mobiDecision.include).toBe(false);
  });

  it("PDF побеждает CHM", () => {
    const pdfDecision = dedup.check(path.normalize("/lib/Manual.pdf"));
    const chmDecision = dedup.check(path.normalize("/lib/Manual.chm"));
    expect(pdfDecision.include).toBe(true);
    expect(chmDecision.include).toBe(false);
  });

  it("EPUB добавлен ПОСЛЕ MOBI — MOBI evicted, EPUB included", () => {
    const mobiDecision = dedup.check(path.normalize("/lib/Book.mobi"));
    expect(mobiDecision.include).toBe(true); /* первый — включён */

    const epubDecision = dedup.check(path.normalize("/lib/Book.epub"));
    expect(epubDecision.include).toBe(true); /* выше priority — заменяет */
    expect(dedup.superseded.some((s) => s.skipped.endsWith("Book.mobi"))).toBe(true);
  });
});

describe("CrossFormatPreDedup — legacy форматы между собой", () => {
  it("AZW3 побеждает AZW (модернее KF8)", () => {
    const azw3 = dedup.check(path.normalize("/lib/Kindle Book.azw3"));
    const azw = dedup.check(path.normalize("/lib/Kindle Book.azw"));
    expect(azw3.include).toBe(true);
    expect(azw.include).toBe(false);
  });

  it("MOBI и AZW равны (35) — выигрывает первый зарегистрированный", () => {
    const mobi = dedup.check(path.normalize("/lib/Book.mobi"));
    const azw = dedup.check(path.normalize("/lib/Book.azw"));
    expect(mobi.include).toBe(true);
    /* Equal priority — second skipped. */
    expect(azw.include).toBe(false);
  });

  it("PDB и PRC равны (20) — выигрывает первый", () => {
    const pdb = dedup.check(path.normalize("/lib/Old Book.pdb"));
    const prc = dedup.check(path.normalize("/lib/Old Book.prc"));
    expect(pdb.include).toBe(true);
    expect(prc.include).toBe(false);
  });

  it("MOBI побеждает PDB (35 > 20)", () => {
    const mobi = dedup.check(path.normalize("/lib/Book.mobi"));
    const pdb = dedup.check(path.normalize("/lib/Book.pdb"));
    expect(mobi.include).toBe(true);
    expect(pdb.include).toBe(false);
  });

  it("PDB побеждает CHM (20 > 15)", () => {
    const pdb = dedup.check(path.normalize("/lib/Manual.pdb"));
    const chm = dedup.check(path.normalize("/lib/Manual.chm"));
    expect(pdb.include).toBe(true);
    expect(chm.include).toBe(false);
  });
});

describe("CrossFormatPreDedup — разные basename не конфликтуют", () => {
  it("Book.mobi и Other.mobi оба проходят (разный basename)", () => {
    const a = dedup.check(path.normalize("/lib/Book.mobi"));
    const b = dedup.check(path.normalize("/lib/Other.mobi"));
    expect(a.include).toBe(true);
    expect(b.include).toBe(true);
  });

  it("разные папки = независимые ledger entries", () => {
    const a = dedup.check(path.normalize("/lib/dir1/Book.mobi"));
    const b = dedup.check(path.normalize("/lib/dir2/Book.mobi"));
    expect(a.include).toBe(true);
    expect(b.include).toBe(true);
  });
});
