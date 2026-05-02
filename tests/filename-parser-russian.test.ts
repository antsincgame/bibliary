/**
 * Unit-тесты filename-parser.ts для русских паттернов имён.
 *
 * Phase A+B Iter 9.3 (rev. 2). Покрывает реальные паттерны из торрент-дампов
 * Либрусека/Флибусты/IT-архивов 90-2010-х.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseFilename } from "../electron/lib/library/filename-parser.js";

describe("filename-parser / Russian author patterns", () => {
  it("'Толстой Л.Н. - Война и мир - 1869.pdf' (dash-separated с annotated initials)", () => {
    const meta = parseFilename("/library/Толстой Л.Н. - Война и мир - 1869.pdf");
    assert.equal(meta?.author, "Толстой Л.Н.");
    assert.equal(meta?.title, "Война и мир");
    assert.equal(meta?.year, 1869);
  });

  it("'Достоевский Ф.М. - Идиот.fb2' (no year, dash-separated)", () => {
    const meta = parseFilename("/library/Достоевский Ф.М. - Идиот.fb2");
    assert.equal(meta?.author, "Достоевский Ф.М.");
    assert.equal(meta?.title, "Идиот");
    assert.equal(meta?.year, undefined);
  });

  it("'Пушкин А.С. Евгений Онегин (1833).fb2' (space-separated, year in parens)", () => {
    const meta = parseFilename("/library/Пушкин А.С. Евгений Онегин (1833).fb2");
    assert.equal(meta?.author, "Пушкин А.С.");
    assert.equal(meta?.title, "Евгений Онегин");
    assert.equal(meta?.year, 1833);
  });

  it("'[Бахтин М.М.] Творчество Франсуа Рабле (1965).pdf' (square brackets)", () => {
    const meta = parseFilename("/library/[Бахтин М.М.] Творчество Франсуа Рабле (1965).pdf");
    assert.equal(meta?.author, "Бахтин М.М.");
    assert.equal(meta?.title, "Творчество Франсуа Рабле");
    assert.equal(meta?.year, 1965);
  });

  it("'1869_Толстой_Л.Н._Война_и_мир.fb2' (year-first underscore-separated)", () => {
    const meta = parseFilename("/library/1869_Толстой_Л.Н._Война_и_мир.fb2");
    assert.equal(meta?.author, "Толстой Л.Н.");
    assert.match(meta?.title || "", /Война и мир/);
    assert.equal(meta?.year, 1869);
  });

  it("'Гоголь Н.В. - Мёртвые души.djvu' (Cyrillic ё, dash-separated)", () => {
    const meta = parseFilename("/library/Гоголь Н.В. - Мёртвые души.djvu");
    assert.equal(meta?.author, "Гоголь Н.В.");
    assert.equal(meta?.title, "Мёртвые души");
  });

  it("'Чехов А.П. - Палата № 6 - 1892.epub' (с № и пробелами в title)", () => {
    const meta = parseFilename("/library/Чехов А.П. - Палата № 6 - 1892.epub");
    assert.equal(meta?.author, "Чехов А.П.");
    assert.match(meta?.title || "", /Палата.*6/);
    assert.equal(meta?.year, 1892);
  });

  it("'Лермонтов М. Ю. - Герой нашего времени - 1840.pdf' (initials с пробелом)", () => {
    const meta = parseFilename("/library/Лермонтов М. Ю. - Герой нашего времени - 1840.pdf");
    assert.equal(meta?.author, "Лермонтов М. Ю.");
    assert.equal(meta?.title, "Герой нашего времени");
    assert.equal(meta?.year, 1840);
  });

  it("'Мамин-Сибиряк Д.Н. - Приваловские миллионы (1883).fb2' (двойная фамилия через дефис)", () => {
    const meta = parseFilename("/library/Мамин-Сибиряк Д.Н. - Приваловские миллионы (1883).fb2");
    assert.equal(meta?.author, "Мамин-Сибиряк Д.Н.");
    assert.equal(meta?.title, "Приваловские миллионы");
    assert.equal(meta?.year, 1883);
  });

  it("Latin (старый паттерн): 'Knuth - Art of Programming - 1968.pdf'", () => {
    const meta = parseFilename("/library/Knuth - Art of Programming - 1968.pdf");
    assert.equal(meta?.author, "Knuth");
    assert.equal(meta?.title, "Art of Programming");
    assert.equal(meta?.year, 1968);
  });

  it("Эвристический год >2100 фильтруется (Иванов И.И. - 9999.pdf)", () => {
    const meta = parseFilename("/library/Иванов И.И. - Бред - 9999.pdf");
    assert.equal(meta?.year, undefined);
  });

  it("Игнорирует bibliary-internal paths (bibliary-cache_...)", () => {
    /* Не должен рассматривать parent dir bibliary-XXX как author. */
    const meta = parseFilename("/library/bibliary-cache_old/Толстой Л.Н. - Война и мир.fb2");
    assert.equal(meta?.author, "Толстой Л.Н.");
  });
});
