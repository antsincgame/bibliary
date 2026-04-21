import type { BookSection, ParseResult } from "./parsers/index.js";

/**
 * Структурно-aware chunker. Не режет текст по средине абзацев. Старается
 * собирать чанки в районе `targetChars` ± `tolerance`, не выходя за границу
 * секции. Если параграф больше maxChars — он принудительно режется по
 * предложениям.
 *
 * Размер по символам, а не по токенам — для embeddings это эквивалентно
 * с поправкой ~3.5-4 символа/токен, e5-small comfortably ест до 512 токенов
 * = ~2000 символов. Дефолт targetChars=900 даёт 220-260 токенов на чанк.
 */

export interface BookChunk {
  /** uuid v5-like deterministic id (sha1 от "title|chapter|index|first40chars"). */
  id: string;
  bookTitle: string;
  bookAuthor?: string;
  bookSourcePath: string;
  chapterTitle: string;
  chapterIndex: number;
  chunkIndex: number;
  text: string;
  charCount: number;
  /** Опциональные тэги, выводимые из заголовка/языка. */
  tags: string[];
}

export interface ChunkerOptions {
  targetChars?: number;
  maxChars?: number;
  /** Минимум символов — мелкие куски склеиваются с соседом. */
  minChars?: number;
}

const DEFAULT_TARGET = 900;
const DEFAULT_MAX = 1600;
const DEFAULT_MIN = 280;

import { createHash } from "crypto";

function hashId(parts: string[]): string {
  const h = createHash("sha1").update(parts.join("|")).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

function splitLongParagraph(p: string, maxChars: number): string[] {
  if (p.length <= maxChars) return [p];
  const sentences = p.match(/[^.!?…]+[.!?…]+["»)]?\s*/g) ?? [p];
  const out: string[] = [];
  let buf = "";
  for (const s of sentences) {
    if (buf.length + s.length > maxChars && buf.length > 0) {
      out.push(buf.trim());
      buf = "";
    }
    if (s.length > maxChars) {
      const hardCut = s.match(new RegExp(`.{1,${maxChars}}`, "g")) ?? [s];
      for (const h of hardCut) out.push(h.trim());
      continue;
    }
    buf += s;
  }
  if (buf.trim()) out.push(buf.trim());
  return out.filter(Boolean);
}

function chunkSection(
  section: BookSection,
  chapterIndex: number,
  bookTitle: string,
  bookAuthor: string | undefined,
  bookSourcePath: string,
  baseTags: string[],
  opts: Required<ChunkerOptions>
): BookChunk[] {
  const result: BookChunk[] = [];
  let buffer: string[] = [];
  let bufferLen = 0;
  let chunkIdx = 0;

  const flush = (): void => {
    if (buffer.length === 0) return;
    const text = buffer.join("\n\n").trim();
    if (text.length === 0) {
      buffer = [];
      bufferLen = 0;
      return;
    }
    const id = hashId([bookSourcePath, String(chapterIndex), String(chunkIdx), text.slice(0, 64)]);
    result.push({
      id,
      bookTitle,
      bookAuthor,
      bookSourcePath,
      chapterTitle: section.title,
      chapterIndex,
      chunkIndex: chunkIdx,
      text,
      charCount: text.length,
      tags: baseTags,
    });
    chunkIdx++;
    buffer = [];
    bufferLen = 0;
  };

  for (const rawP of section.paragraphs) {
    for (const p of splitLongParagraph(rawP, opts.maxChars)) {
      if (bufferLen + p.length > opts.targetChars && bufferLen >= opts.minChars) {
        flush();
      }
      buffer.push(p);
      bufferLen += p.length;
      if (bufferLen >= opts.maxChars) flush();
    }
  }
  flush();
  return result;
}

export function chunkBook(
  parsed: ParseResult,
  bookSourcePath: string,
  opts: ChunkerOptions = {}
): BookChunk[] {
  const cfg: Required<ChunkerOptions> = {
    targetChars: opts.targetChars ?? DEFAULT_TARGET,
    maxChars: opts.maxChars ?? DEFAULT_MAX,
    minChars: opts.minChars ?? DEFAULT_MIN,
  };
  const baseTags: string[] = [];
  if (parsed.metadata.language) baseTags.push(`lang:${parsed.metadata.language.slice(0, 2)}`);

  const out: BookChunk[] = [];
  parsed.sections.forEach((section, idx) => {
    out.push(...chunkSection(section, idx, parsed.metadata.title, parsed.metadata.author, bookSourcePath, baseTags, cfg));
  });
  return out;
}
