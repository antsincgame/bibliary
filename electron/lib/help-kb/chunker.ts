/**
 * Help-KB chunker (Phase 4.1 — Karpathy Wiki style).
 *
 * Разбивает Markdown-документ на семантические чанки по заголовкам.
 * В отличие от book chunker, мы НЕ пытаемся склеивать абзацы — каждый
 * раздел документа самодостаточен и должен искаться независимо.
 *
 * Стратегия:
 *   1. Скан по строкам, накопление в текущий "section".
 *   2. Заголовок (#, ##, ###) ⇒ flush текущего section + старт нового
 *      с heading'ом из заголовка.
 *   3. Если section > MAX_CHUNK_CHARS — split по \n\n границам.
 *   4. Меньше MIN_CHUNK_CHARS — склеить с предыдущим (если возможно).
 *
 * Output: HelpChunk[] с pre-attached metadata (source, heading, level).
 */

const MIN_CHUNK_CHARS = 200;
const MAX_CHUNK_CHARS = 2000;

export interface HelpChunk {
  /** Уникальный seed для deterministic uuid (source + heading + index). */
  seed: string;
  /** Имя исходного файла (basename без расширения). */
  source: string;
  /** Title документа (первый H1) или basename. */
  docTitle: string;
  /** Иерархия заголовков от корня (["Fine-tuning", "Pre-flight check"]). */
  headingPath: string[];
  /** Markdown-сырой текст чанка. */
  text: string;
  /** Длина в символах (для UI/диагностики). */
  charCount: number;
}

interface OpenSection {
  headingPath: string[];
  buffer: string[];
}

function pushChunk(open: OpenSection, source: string, docTitle: string, text: string, out: HelpChunk[]): void {
  out.push({
    seed: `${source}::${open.headingPath.join("/")}::${out.length}`,
    source,
    docTitle,
    headingPath: [...open.headingPath],
    text,
    charCount: text.length,
  });
}

/** Если параграф сам по себе > MAX — режем по символам с soft-перевесом на конец предложения. */
function splitOversizedParagraph(p: string): string[] {
  const parts: string[] = [];
  let remaining = p;
  while (remaining.length > MAX_CHUNK_CHARS) {
    /* Ищем последнюю границу предложения внутри окна [MAX*0.6..MAX] */
    const window = remaining.slice(0, MAX_CHUNK_CHARS);
    const sentenceBreak = Math.max(
      window.lastIndexOf(". "),
      window.lastIndexOf("! "),
      window.lastIndexOf("? "),
      window.lastIndexOf("\n"),
    );
    const cut = sentenceBreak > MAX_CHUNK_CHARS * 0.6 ? sentenceBreak + 1 : MAX_CHUNK_CHARS;
    parts.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining.length > 0) parts.push(remaining);
  return parts;
}

function flushSection(open: OpenSection, source: string, docTitle: string, out: HelpChunk[]): void {
  const text = open.buffer.join("\n").trim();
  if (text.length === 0) return;
  if (text.length <= MAX_CHUNK_CHARS) {
    pushChunk(open, source, docTitle, text, out);
    return;
  }
  /* Большой section — сначала режем по \n\n границам, потом overflow-параграфы
     дополнительно режем по предложениям, чтобы НИКОГДА не превысить MAX. */
  const rawParts = text.split(/\n\n+/);
  const parts: string[] = [];
  for (const p of rawParts) {
    if (p.length > MAX_CHUNK_CHARS) {
      parts.push(...splitOversizedParagraph(p));
    } else {
      parts.push(p);
    }
  }
  let acc: string[] = [];
  let accLen = 0;
  for (const p of parts) {
    const pLen = p.length + 2;
    if (accLen + pLen > MAX_CHUNK_CHARS && acc.length > 0) {
      pushChunk(open, source, docTitle, acc.join("\n\n"), out);
      acc = [p];
      accLen = pLen;
    } else {
      acc.push(p);
      accLen += pLen;
    }
  }
  if (acc.length > 0) {
    pushChunk(open, source, docTitle, acc.join("\n\n"), out);
  }
}

/**
 * Склеивает соседние мелкие чанки ТОЛЬКО если у них одинаковый headingPath
 * (один и тот же раздел разбит на короткие абзацы). Никогда не сливает
 * соседние подразделы — это бы стёрло attribution, которое агент использует
 * для цитирования источника пользователю.
 */
function mergeTinyAdjacentChunks(chunks: HelpChunk[]): HelpChunk[] {
  if (chunks.length < 2) return chunks;
  const out: HelpChunk[] = [];
  for (const c of chunks) {
    const prev = out[out.length - 1];
    const samePath = prev && prev.headingPath.join("/") === c.headingPath.join("/");
    if (
      prev
      && samePath
      && c.charCount < MIN_CHUNK_CHARS
      && prev.charCount + c.charCount < MAX_CHUNK_CHARS
    ) {
      prev.text = `${prev.text}\n\n${c.text}`;
      prev.charCount = prev.text.length;
    } else {
      out.push({ ...c });
    }
  }
  return out;
}

export function chunkMarkdown(markdown: string, sourceBasename: string): HelpChunk[] {
  const lines = markdown.split(/\r?\n/);
  const out: HelpChunk[] = [];
  let docTitle = sourceBasename;
  let currentPath: string[] = [];
  let buffer: string[] = [];

  const flushIfAny = (): void => {
    if (buffer.length === 0) return;
    flushSection({ headingPath: currentPath.slice(), buffer }, sourceBasename, docTitle, out);
    buffer = [];
  };

  let inCodeFence = false;
  for (const line of lines) {
    /* Код-блоки не парсим как заголовки */
    if (/^```/.test(line)) {
      inCodeFence = !inCodeFence;
      buffer.push(line);
      continue;
    }
    if (inCodeFence) {
      buffer.push(line);
      continue;
    }
    const headingMatch = /^(#{1,3})\s+(.+?)\s*$/.exec(line);
    if (headingMatch) {
      flushIfAny();
      const level = headingMatch[1].length;
      const title = headingMatch[2].replace(/[*_`]/g, "").trim();
      if (level === 1 && docTitle === sourceBasename) docTitle = title;
      /* Truncate path до (level-1), затем push текущий */
      currentPath = currentPath.slice(0, level - 1);
      currentPath.push(title);
      continue;
    }
    buffer.push(line);
  }
  flushIfAny();
  return mergeTinyAdjacentChunks(out);
}
