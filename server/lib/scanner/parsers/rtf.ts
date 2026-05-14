import { promises as fs } from "fs";
import * as path from "path";
import { cleanParagraph, looksLikeHeading, type BookParser, type ParseResult, type BookSection } from "./types.js";

/**
 * RTF parser — strips RTF control words via regex, then splits into
 * heading/paragraph sections the same way txtParser does.
 * No external dependency required.
 */
async function parseRtf(filePath: string): Promise<ParseResult> {
  const buf = await fs.readFile(filePath);
  let raw = buf.toString("latin1");
  const warnings: string[] = [];

  const codepageMatch = raw.match(/\\ansicpg(\d+)/);
  if (codepageMatch) {
    const cp = codepageMatch[1];
    if (cp === "1251") {
      raw = buf.toString("latin1");
      raw = decodeCp1251(raw);
    }
  }

  let text = stripRtf(raw);
  text = text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");

  const blocks = text.split(/\n\s*\n/).map((b) => cleanParagraph(b)).filter(Boolean);
  const sections: BookSection[] = [];
  let current: BookSection | null = null;
  let untitledIdx = 0;

  for (const block of blocks) {
    const lines = block.split("\n");
    if (lines.length === 1 && looksLikeHeading(lines[0])) {
      current = { level: 1, title: lines[0].trim(), paragraphs: [] };
      sections.push(current);
      continue;
    }
    if (!current) {
      untitledIdx++;
      current = { level: 1, title: `Section ${untitledIdx}`, paragraphs: [] };
      sections.push(current);
    }
    current.paragraphs.push(block.replace(/\n/g, " "));
  }

  const baseName = path.basename(filePath, path.extname(filePath));
  const withText = sections.filter((s) => s.paragraphs.length > 0);

  return {
    metadata: { title: baseName, warnings },
    sections: withText,
    rawCharCount: text.length,
  };
}

function stripRtf(rtf: string): string {
  let depth = 0;
  let out = "";
  let i = 0;
  while (i < rtf.length) {
    const ch = rtf[i];
    if (ch === "{") { depth++; i++; continue; }
    if (ch === "}") { depth = Math.max(0, depth - 1); i++; continue; }

    if (ch === "\\") {
      i++;
      if (i >= rtf.length) break;
      const next = rtf[i];
      if (next === "'" && i + 2 < rtf.length) {
        const hex = rtf.substring(i + 1, i + 3);
        const code = parseInt(hex, 16);
        if (!isNaN(code)) out += String.fromCharCode(code);
        i += 3;
        continue;
      }
      if (next === "\n" || next === "\r") { out += "\n"; i++; continue; }
      if (next === "\\") { out += "\\"; i++; continue; }
      if (next === "{") { out += "{"; i++; continue; }
      if (next === "}") { out += "}"; i++; continue; }

      let word = "";
      while (i < rtf.length && /[a-zA-Z]/.test(rtf[i])) { word += rtf[i]; i++; }

      let param = "";
      while (i < rtf.length && /[-0-9]/.test(rtf[i])) { param += rtf[i]; i++; }
      if (i < rtf.length && rtf[i] === " ") i++;

      if (word === "par" || word === "line") out += "\n";
      else if (word === "tab") out += "\t";
      else if (word === "u") {
        const code = parseInt(param, 10);
        if (!isNaN(code)) out += String.fromCodePoint(code < 0 ? code + 65536 : code);
        if (i < rtf.length && rtf[i] === "?") i++;
      }
      continue;
    }

    if (depth <= 1) out += ch;
    i++;
  }

  return out
    .replace(/[^\S\n]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeCp1251(latin1: string): string {
  const CP1251: Record<number, number> = {
    0xC0: 0x0410, 0xC1: 0x0411, 0xC2: 0x0412, 0xC3: 0x0413,
    0xC4: 0x0414, 0xC5: 0x0415, 0xC6: 0x0416, 0xC7: 0x0417,
    0xC8: 0x0418, 0xC9: 0x0419, 0xCA: 0x041A, 0xCB: 0x041B,
    0xCC: 0x041C, 0xCD: 0x041D, 0xCE: 0x041E, 0xCF: 0x041F,
    0xD0: 0x0420, 0xD1: 0x0421, 0xD2: 0x0422, 0xD3: 0x0423,
    0xD4: 0x0424, 0xD5: 0x0425, 0xD6: 0x0426, 0xD7: 0x0427,
    0xD8: 0x0428, 0xD9: 0x0429, 0xDA: 0x042A, 0xDB: 0x042B,
    0xDC: 0x042C, 0xDD: 0x042D, 0xDE: 0x042E, 0xDF: 0x042F,
    0xE0: 0x0430, 0xE1: 0x0431, 0xE2: 0x0432, 0xE3: 0x0433,
    0xE4: 0x0434, 0xE5: 0x0435, 0xE6: 0x0436, 0xE7: 0x0437,
    0xE8: 0x0438, 0xE9: 0x0439, 0xEA: 0x043A, 0xEB: 0x043B,
    0xEC: 0x043C, 0xED: 0x043D, 0xEE: 0x043E, 0xEF: 0x043F,
    0xF0: 0x0440, 0xF1: 0x0441, 0xF2: 0x0442, 0xF3: 0x0443,
    0xF4: 0x0444, 0xF5: 0x0445, 0xF6: 0x0446, 0xF7: 0x0447,
    0xF8: 0x0448, 0xF9: 0x0449, 0xFA: 0x044A, 0xFB: 0x044B,
    0xFC: 0x044C, 0xFD: 0x044D, 0xFE: 0x044E, 0xFF: 0x044F,
    0xA8: 0x0401, 0xB8: 0x0451,
  };
  let out = "";
  for (let i = 0; i < latin1.length; i++) {
    const code = latin1.charCodeAt(i);
    out += String.fromCharCode(CP1251[code] ?? code);
  }
  return out;
}

export const rtfParser: BookParser = { ext: "rtf", parse: parseRtf };
