import * as iconv from "iconv-lite";
import type { ParseResult } from "./parsers/types.js";

export interface MojibakeRepairStats {
  repairedLines: number;
}

export interface AllRepairsStats {
  doubleUtf8Lines: number;
  koi8rLines: number;
  cp1251Lines: number;
  totalRepairedLines: number;
}

interface TextQuality {
  cyrillic: number;
  suspiciousLatin1: number;
  control: number;
  mojibakeTokens: number;
  pdfGlyphGarble: number;
}

const MOJIBAKE_TOKENS = ["Ã", "Â", "Ð", "Ñ", "ð", "ñ", "Ç", "È", "Í", "Î", "Ï", "ß"];
const PDF_GLYPH_GARBLE = new Set(["Ł", "ł", "æ", "Æ", "Œ", "œ", "Ø", "ø", "ı", "˚", "ˇ", "˛", "˝", "ˆ", "˜"]);

/**
 * Classification result for a ParseResult's text quality.
 *
 * - "clean"          — text looks acceptable, no action needed
 * - "encoding_garble"— bytes were decoded with wrong encoding (double-UTF8, KOI8-R, CP1251).
 *                      Encoding repairs can/did fix this. No OCR retry required.
 * - "ocr_confusion"  — text layer has PDF glyph garble that encoding repairs cannot fix.
 *                      OCR retry is appropriate.
 */
export type TextProblemKind = "clean" | "encoding_garble" | "ocr_confusion";

function analyseTextQuality(text: string): TextQuality {
  let cyrillic = 0;
  let suspiciousLatin1 = 0;
  let control = 0;
  let mojibakeTokens = 0;
  let pdfGlyphGarble = 0;

  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (code >= 0x0400 && code <= 0x04ff) cyrillic += 1;
    if (code >= 0x00c0 && code <= 0x00ff) suspiciousLatin1 += 1;
    if (code >= 0x0080 && code <= 0x009f) control += 1;
    if (PDF_GLYPH_GARBLE.has(ch)) pdfGlyphGarble += 1;
  }

  for (const token of MOJIBAKE_TOKENS) {
    mojibakeTokens += text.split(token).length - 1;
  }

  return { cyrillic, suspiciousLatin1, control, mojibakeTokens, pdfGlyphGarble };
}

function scoreQuality(q: TextQuality): number {
  return q.cyrillic * 3 - q.suspiciousLatin1 * 2 - q.control * 5 - q.mojibakeTokens * 3 - q.pdfGlyphGarble * 3;
}

function hasRepairSignal(q: TextQuality): boolean {
  return q.suspiciousLatin1 + q.control + q.mojibakeTokens >= 4;
}

function canRoundTripLatin1(text: string): boolean {
  for (const ch of text) {
    if (ch.charCodeAt(0) > 0x00ff) return false;
  }
  return true;
}

// ─── Strategy 1: Double-UTF-8 (UTF-8 bytes decoded as CP1251) ────────────────

/**
 * Detects double-UTF-8 garble: UTF-8 Cyrillic bytes decoded as CP1251.
 *
 * UTF-8 Cyrillic uses 0xD0/0xD1 as lead bytes. In CP1251 these map to Р (U+0420) and
 * С (U+0421). In normal Russian/Ukrainian text Р+С together are roughly 8-10% of all
 * Cyrillic characters. In double-UTF-8 garble every Cyrillic character's first byte is
 * one of those two, so their combined ratio exceeds 35%.
 */
function isDoubleUtf8Garble(text: string): boolean {
  let cyrillicTotal = 0;
  let leadByteCount = 0;
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (code >= 0x0400 && code <= 0x04ff) {
      cyrillicTotal++;
      if (code === 0x0420 || code === 0x0421) leadByteCount++; // Р or С
    }
  }
  return cyrillicTotal >= 20 && leadByteCount / cyrillicTotal > 0.35;
}

/**
 * Repairs a single line of double-UTF-8 garble.
 *
 * Strategy: re-encode as CP1251 to recover the original UTF-8 bytes,
 * then decode those bytes as UTF-8. Quality score must improve for repair to apply.
 */
function repairDoubleUtf8Line(line: string): { text: string; repaired: boolean } {
  if (!isDoubleUtf8Garble(line)) return { text: line, repaired: false };
  try {
    const bytes = iconv.encode(line, "windows-1251");
    const candidate = bytes.toString("utf8");
    const before = analyseTextQuality(line);
    const after = analyseTextQuality(candidate);
    if (scoreQuality(after) > scoreQuality(before) + 10 && after.cyrillic > before.cyrillic) {
      return { text: candidate, repaired: true };
    }
  } catch {
    // Buffer.toString("utf8") can throw on invalid byte sequences produced by encode.
  }
  return { text: line, repaired: false };
}

// ─── Strategy 2: KOI8-R bytes decoded as CP1251 ──────────────────────────────

/**
 * Detects KOI8-R-as-CP1251 garble.
 *
 * KOI8-R uppercase Cyrillic starts at 0xC1 (А), while CP1251 starts at 0xC0.
 * This means every KOI8 letter maps to the NEXT letter in CP1251 order (А→Б, О→П, …).
 * The most common Russian letter `о` becomes `П` in this garble, so П appears
 * at ~3× its normal frequency while О nearly vanishes.
 */
function isKoi8rGarble(text: string): boolean {
  let cyrillicTotal = 0;
  let pCount = 0;
  let oCount = 0;
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (code >= 0x0400 && code <= 0x04ff) {
      cyrillicTotal++;
      if (code === 0x041f) pCount++; // П
      if (code === 0x041e) oCount++; // О
    }
  }
  if (cyrillicTotal < 40) return false;
  const pRatio = pCount / cyrillicTotal;
  const oRatio = oCount / cyrillicTotal;
  // Normal Russian: О ~11%, П ~3%. Garble: П is high, О is very low.
  return pRatio > 0.08 && oRatio < 0.02;
}

/**
 * Repairs a single line of KOI8-R-as-CP1251 garble.
 *
 * Strategy: re-encode as CP1251 to recover the original KOI8 bytes,
 * then decode as KOI8-R. Score must improve and Cyrillic count must not shrink.
 */
function repairKoi8rAsCp1251Line(line: string): { text: string; repaired: boolean } {
  if (!isKoi8rGarble(line)) return { text: line, repaired: false };
  try {
    const bytes = iconv.encode(line, "windows-1251");
    const candidate = iconv.decode(bytes, "koi8-r");
    const before = analyseTextQuality(line);
    const after = analyseTextQuality(candidate);
    if (scoreQuality(after) > scoreQuality(before) + 20 && after.cyrillic >= before.cyrillic * 0.9) {
      return { text: candidate, repaired: true };
    }
  } catch {
    // ignore
  }
  return { text: line, repaired: false };
}

// ─── Strategy 3: CP1251 decoded as Latin-1 (existing) ────────────────────────

export function repairMojibakeLine(line: string): { text: string; repaired: boolean } {
  if (line.length === 0 || !canRoundTripLatin1(line)) return { text: line, repaired: false };

  const before = analyseTextQuality(line);
  if (!hasRepairSignal(before)) return { text: line, repaired: false };

  const candidate = iconv.decode(Buffer.from(line, "latin1"), "windows-1251");
  const after = analyseTextQuality(candidate);
  const beforeScore = scoreQuality(before);
  const afterScore = scoreQuality(after);

  if (afterScore >= beforeScore + 12 && after.cyrillic > before.cyrillic) {
    return { text: candidate, repaired: true };
  }

  return { text: line, repaired: false };
}

// ─── Combined line repair ─────────────────────────────────────────────────────

interface LineRepairResult {
  text: string;
  strategy: "double-utf8" | "koi8r" | "cp1251" | null;
}

function repairLineWithAllStrategies(line: string): LineRepairResult {
  const du = repairDoubleUtf8Line(line);
  if (du.repaired) return { text: du.text, strategy: "double-utf8" };

  const kr = repairKoi8rAsCp1251Line(line);
  if (kr.repaired) return { text: kr.text, strategy: "koi8r" };

  const cp = repairMojibakeLine(line);
  if (cp.repaired) return { text: cp.text, strategy: "cp1251" };

  return { text: line, strategy: null };
}

// ─── Text-level helpers (used by repairParseResultMojibake for compat) ────────

export function repairMojibakeText(text: string): { text: string; repairedLines: number } {
  let repairedLines = 0;
  const lines = text.split(/\n/).map((line) => {
    const repaired = repairMojibakeLine(line);
    if (repaired.repaired) repairedLines += 1;
    return repaired.text;
  });
  return { text: lines.join("\n"), repairedLines };
}

function repairTextAllStrategies(
  text: string,
): { text: string; doubleUtf8Lines: number; koi8rLines: number; cp1251Lines: number } {
  let doubleUtf8Lines = 0;
  let koi8rLines = 0;
  let cp1251Lines = 0;
  const lines = text.split(/\n/).map((line) => {
    const result = repairLineWithAllStrategies(line);
    if (result.strategy === "double-utf8") doubleUtf8Lines++;
    else if (result.strategy === "koi8r") koi8rLines++;
    else if (result.strategy === "cp1251") cp1251Lines++;
    return result.text;
  });
  return { text: lines.join("\n"), doubleUtf8Lines, koi8rLines, cp1251Lines };
}

// ─── ParseResult-level repair ────────────────────────────────────────────────

/**
 * Repairs CP1251-as-Latin1 mojibake in a ParseResult (backward-compatible entry point).
 * For comprehensive multi-strategy repair use repairParseResultAllStrategies instead.
 */
export function repairParseResultMojibake(parsed: ParseResult): { parsed: ParseResult; stats: MojibakeRepairStats } {
  let repairedLines = 0;

  const repair = (text: string): string => {
    const result = repairMojibakeText(text);
    repairedLines += result.repairedLines;
    return result.text;
  };

  const sections = parsed.sections.map((section) => ({
    ...section,
    title: repair(section.title),
    paragraphs: section.paragraphs.map(repair),
  }));

  const metadata = {
    ...parsed.metadata,
    title: repair(parsed.metadata.title),
    author: parsed.metadata.author ? repair(parsed.metadata.author) : parsed.metadata.author,
    publisher: parsed.metadata.publisher ? repair(parsed.metadata.publisher) : parsed.metadata.publisher,
    warnings:
      repairedLines > 0
        ? [...(parsed.metadata.warnings ?? []), `mojibake-repair: repaired ${repairedLines} CP1251-as-Latin1 line(s)`]
        : parsed.metadata.warnings,
  };

  return {
    parsed: { ...parsed, metadata, sections },
    stats: { repairedLines },
  };
}

/**
 * Applies all encoding repair strategies (double-UTF-8, KOI8-R, CP1251) to a ParseResult.
 *
 * Each strategy is tried in priority order per line; the first successful repair wins.
 * Returns the repaired ParseResult, per-strategy counts, and the text problem classification
 * computed from pre-repair signals + repair outcomes.
 */
export function repairParseResultAllStrategies(
  parsed: ParseResult,
): { parsed: ParseResult; stats: AllRepairsStats; problem: TextProblemKind } {
  const stats: AllRepairsStats = { doubleUtf8Lines: 0, koi8rLines: 0, cp1251Lines: 0, totalRepairedLines: 0 };

  const repair = (text: string): string => {
    const result = repairTextAllStrategies(text);
    stats.doubleUtf8Lines += result.doubleUtf8Lines;
    stats.koi8rLines += result.koi8rLines;
    stats.cp1251Lines += result.cp1251Lines;
    return result.text;
  };

  const sections = parsed.sections.map((section) => ({
    ...section,
    title: repair(section.title),
    paragraphs: section.paragraphs.map(repair),
  }));

  stats.totalRepairedLines = stats.doubleUtf8Lines + stats.koi8rLines + stats.cp1251Lines;

  const warningParts: string[] = [];
  if (stats.doubleUtf8Lines > 0) warningParts.push(`${stats.doubleUtf8Lines} double-UTF-8`);
  if (stats.koi8rLines > 0) warningParts.push(`${stats.koi8rLines} KOI8-R-as-CP1251`);
  if (stats.cp1251Lines > 0) warningParts.push(`${stats.cp1251Lines} CP1251-as-Latin1`);

  const repairedTitle = repair(parsed.metadata.title);
  const repairedAuthor = parsed.metadata.author ? repair(parsed.metadata.author) : parsed.metadata.author;
  const repairedPublisher = parsed.metadata.publisher
    ? repair(parsed.metadata.publisher)
    : parsed.metadata.publisher;

  const metadata = {
    ...parsed.metadata,
    title: repairedTitle,
    author: repairedAuthor,
    publisher: repairedPublisher,
    warnings:
      warningParts.length > 0
        ? [
            ...(parsed.metadata.warnings ?? []),
            `encoding-repair: fixed ${stats.totalRepairedLines} line(s) [${warningParts.join(", ")}]`,
          ]
        : parsed.metadata.warnings,
  };

  const repairedParsed: ParseResult = { ...parsed, metadata, sections };

  const problem = classifyTextProblem(repairedParsed, stats);

  return { parsed: repairedParsed, stats, problem };
}

// ─── Text problem classification ─────────────────────────────────────────────

/**
 * Classifies the text quality of a ParseResult AFTER encoding repairs have been applied.
 *
 * Called internally by repairParseResultAllStrategies; the repairStats parameter
 * reflects repairs already performed on the passed parsed result.
 */
function classifyTextProblem(parsed: ParseResult, repairStats: AllRepairsStats): TextProblemKind {
  // If encoding repairs made significant impact the text was encoding_garble.
  // Threshold: >= 5 lines repaired, or encoding repairs dominated.
  const ENCODING_REPAIR_THRESHOLD = 5;
  if (repairStats.doubleUtf8Lines + repairStats.koi8rLines + repairStats.cp1251Lines >= ENCODING_REPAIR_THRESHOLD) {
    return "encoding_garble";
  }

  // Analyse remaining text for PDF glyph garble that encoding repairs cannot fix.
  const sample = parsed.sections
    .slice(0, 24)
    .map((section) => `${section.title}\n${section.paragraphs.slice(0, 8).join("\n")}`)
    .join("\n")
    .slice(0, 50_000);

  if (!sample.trim()) return "clean";

  const q = analyseTextQuality(sample);
  const suspicious = q.suspiciousLatin1 + q.control * 2 + q.mojibakeTokens * 3 + q.pdfGlyphGarble * 3;
  if (suspicious >= 240 && suspicious > q.cyrillic * 2) {
    return "ocr_confusion";
  }

  return "clean";
}

/**
 * Returns true if the ParseResult has severe mojibake that warrants an OCR retry.
 * Preserved for backward compatibility; prefer repairParseResultAllStrategies for new code.
 */
export function isSevereMojibakeParseResult(parsed: ParseResult): boolean {
  const sample = parsed.sections
    .slice(0, 24)
    .map((section) => `${section.title}\n${section.paragraphs.slice(0, 8).join("\n")}`)
    .join("\n")
    .slice(0, 50_000);
  const q = analyseTextQuality(sample);
  const suspicious = q.suspiciousLatin1 + q.control * 2 + q.mojibakeTokens * 3 + q.pdfGlyphGarble * 3;
  return suspicious >= 240 && suspicious > q.cyrillic * 2;
}
