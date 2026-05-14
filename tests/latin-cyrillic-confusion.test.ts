/**
 * detectLatinCyrillicConfusion — safe OCR confusion detection for
 * Russian/Ukrainian DjVu text layers.
 *
 * Key invariant: valid Ukrainian text with Latin i/ï homoglyphs must NOT be
 * flagged as confused even though OCR commonly outputs these instead of і/ї.
 */

import { describe, it } from "node:test";
import { expect } from "./helpers/expect-shim.ts";
import { detectLatinCyrillicConfusion } from "../server/lib/scanner/extractors/quality-heuristic.js";

describe("detectLatinCyrillicConfusion — Ukrainian safety (i/ï whitelist)", () => {
  it("valid Ukrainian text with Latin i for і should NOT be confused", () => {
    // Simulates OCR output where Ukrainian і is rendered as Latin i (very common)
    const ukrainianWithLatinI =
      "Це нормальний украiнський текст де буква i замiнює кирилiчну i. " +
      "Такi тексти зустрiчаються дуже часто в старих DjVu файлах. " +
      "Мiсто Киiв розташоване на рiчцi Днiпро де жили нашi предки.";
    const result = detectLatinCyrillicConfusion(ukrainianWithLatinI);
    expect(result.isConfused).toBe(false);
  });

  it("valid Ukrainian text with Latin ï for ї should NOT be confused", () => {
    const ukrainianWithLatinIdiaeressis =
      "Украïнська мова маï власнi букви що вiдрiзняють ïï вiд iнших мов. " +
      "Народ Украïни маï право на власну iдентичнiсть i культуру вiками.";
    const result = detectLatinCyrillicConfusion(ukrainianWithLatinIdiaeressis);
    expect(result.isConfused).toBe(false);
  });
});

describe("detectLatinCyrillicConfusion — OCR garble patterns", () => {
  it("detects digit substitutions like 06pa3y (образу)", () => {
    const garbled =
      "B 06pa3y cл0жных зaдaч мнoгиe уч0ные нaxoдятcя в тр0удных. " +
      "C0вpeмeнный подх0д пpeдлaгaeт р6шeния для xapактepных 3aдaч. " +
      "Pr0грaммирoвaниe нa C++ тpебуeт 0пыта и знaний осн0в нaуки.";
    const result = detectLatinCyrillicConfusion(garbled);
    expect(result.isConfused).toBe(true);
    expect(result.digitSubstitutions).toBeGreaterThan(0);
  });

  it("detects Latin p/c/o homoglyphs embedded in Cyrillic words", () => {
    // пpогpамма = п + Latin-p + рогp + Latin-p + амма
    // Such output comes from OCR engines with wrong language settings
    const garbled =
      "Hаша пpогpамма для oбpаботки тeкcтoв испoльзyeт cпeциальныe алгopитмы. " +
      "Bпeрвыe пpимeнённые мeтoды пoказали xopoшиe peзультаты в cтатистикe. " +
      "Haучныe иccлeдoвания пoтрeбoвали мнoгo вpeмeни и уcилий кoллeктива.";
    const result = detectLatinCyrillicConfusion(garbled);
    expect(result.isConfused).toBe(true);
    expect(result.homoglyphTokens).toBeGreaterThan(0);
  });

  it("clean Russian text is NOT confused", () => {
    const cleanRussian =
      "Современные методы обработки текстов используют специальные алгоритмы. " +
      "Впервые применённые методы показали хорошие результаты в статистике. " +
      "Научные исследования потребовали много времени и усилий коллектива научников.";
    const result = detectLatinCyrillicConfusion(cleanRussian);
    expect(result.isConfused).toBe(false);
  });

  it("clean English text is NOT confused", () => {
    const cleanEnglish =
      "The quick brown fox jumps over the lazy dog near the river bank. " +
      "Modern computer science uses algorithms and data structures efficiently. " +
      "Programming languages provide abstractions for complex system design.";
    const result = detectLatinCyrillicConfusion(cleanEnglish);
    expect(result.isConfused).toBe(false);
  });

  it("returns sampleTokens count", () => {
    const text = "слово другое третье четвёртое пятое шестое седьмое";
    const result = detectLatinCyrillicConfusion(text);
    expect(result.sampleTokens).toBeGreaterThan(0);
  });
});

describe("detectLatinCyrillicConfusion — edge cases", () => {
  it("empty string returns isConfused=false", () => {
    const result = detectLatinCyrillicConfusion("");
    expect(result.isConfused).toBe(false);
    expect(result.sampleTokens).toBe(0);
  });

  it("very short text (< 3 char tokens) returns isConfused=false", () => {
    const result = detectLatinCyrillicConfusion("в о а и е");
    expect(result.isConfused).toBe(false);
  });
});
