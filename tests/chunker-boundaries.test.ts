/**
 * tests/chunker-boundaries.test.ts
 *
 * Unit-тесты для electron/lib/scanner/chunker.ts. Раньше chunker не имел
 * прямого покрытия: его поведение видно только косвенно через
 * library-cas-pipeline и smoke. Регрессия в chunker'е (например,
 * chunkId перестал быть детерминированным после рефакторинга) тихо
 * портит весь датасет: при повторном ingest старые точки не дедуплицируются,
 * vectordb наполняется дубликатами.
 *
 * Контракт chunker'а:
 *   - target/min/max char budgets соблюдаются
 *   - chunks НЕ пересекают границу секции (chapter)
 *   - chunkId — sha1(bookSourcePath|chapterIndex|chunkIndex|first64chars),
 *     детерминирован для одного и того же текста
 *   - длинный параграф режется по предложениям, не по середине слова
 *   - параграф длиннее maxChars без знаков препинания режется hard-cut'ом
 *   - language tag берётся из metadata.language (первые 2 символа → "lang:xx")
 *   - empty parsed.sections → empty chunks
 *   - chapterTitle прокидывается в каждый chunk
 *   - chunkIndex монотонно растёт внутри одной главы и сбрасывается на новой
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chunkBook } from "../electron/lib/scanner/chunker.ts";
import type { BookSection, ParseResult } from "../server/lib/scanner/parsers/index.ts";

function makeParseResult(sections: BookSection[], language?: string, title = "Test Book", author?: string): ParseResult {
  return {
    metadata: {
      title,
      author,
      language,
      warnings: [],
    },
    sections,
    rawCharCount: sections.reduce((s, sec) => s + sec.paragraphs.reduce((ss, p) => ss + p.length, 0), 0),
  };
}

function paragraph(words: number, char = "x"): string {
  /* Строит параграф из ~`words` пробело-разделённых псевдо-слов. */
  return Array.from({ length: words }, (_, i) => `${char}${i}`).join(" ");
}

/* ─── target/min/max budgets ──────────────────────────────────────── */

test("[chunker] respects target chars: short paragraphs аккумулируются до target, потом flush", () => {
  /* 5 параграфов по ~150 chars → суммарно ~750. target=900, min=280
     → должен собрать 1 чанк со всеми 5. */
  const sections: BookSection[] = [{
    level: 2, title: "Ch1",
    paragraphs: Array.from({ length: 5 }, () => "x".repeat(140) + "."),
  }];
  const chunks = chunkBook(makeParseResult(sections), "/path/book.txt");
  assert.equal(chunks.length, 1, "short paras pack into one chunk");
  assert.ok(chunks[0].charCount <= 900, `chunk under target, got ${chunks[0].charCount}`);
});

test("[chunker] respects max chars: каждый chunk не больше maxChars", () => {
  const sections: BookSection[] = [{
    level: 2, title: "Long",
    paragraphs: Array.from({ length: 20 }, () => paragraph(60)), /* ~ 200 chars каждый */
  }];
  const chunks = chunkBook(makeParseResult(sections), "/p.txt", { targetChars: 600, maxChars: 1000, minChars: 200 });
  for (const ch of chunks) {
    assert.ok(ch.charCount <= 1000, `chunk #${ch.chunkIndex} exceeds maxChars: ${ch.charCount}`);
  }
});

test("[chunker] respects min chars: финальный мелкий буфер не отбрасывается, выпускается как отдельный chunk", () => {
  /* 1 короткий параграф < minChars — chunker всё равно flush'ит, иначе
     контент пропадёт. */
  const sections: BookSection[] = [{
    level: 2, title: "Tiny",
    paragraphs: ["hello world."],
  }];
  const chunks = chunkBook(makeParseResult(sections), "/p.txt");
  assert.equal(chunks.length, 1);
  assert.ok(chunks[0].text.includes("hello world"));
});

/* ─── chapter boundaries ───────────────────────────────────────────── */

test("[chunker] chunks НЕ пересекают chapter boundary", () => {
  /* Каждая глава — короткий текст, недостаточный для target. Chunker всё
     равно должен выпустить отдельный chunk для каждой главы. */
  const sections: BookSection[] = [
    { level: 2, title: "First", paragraphs: ["only one para in first."] },
    { level: 2, title: "Second", paragraphs: ["only one para in second."] },
    { level: 2, title: "Third", paragraphs: ["only one para in third."] },
  ];
  const chunks = chunkBook(makeParseResult(sections), "/p.txt");
  assert.equal(chunks.length, 3, "one chunk per chapter, no merging across chapter boundary");
  assert.equal(chunks[0].chapterTitle, "First");
  assert.equal(chunks[0].chapterIndex, 0);
  assert.equal(chunks[1].chapterTitle, "Second");
  assert.equal(chunks[1].chapterIndex, 1);
  assert.equal(chunks[2].chapterTitle, "Third");
  assert.equal(chunks[2].chapterIndex, 2);
});

test("[chunker] chunkIndex монотонно растёт внутри главы и сбрасывается на новой", () => {
  /* Большая глава — несколько чанков с index 0,1,2... затем новая глава
     с index снова 0. */
  const longCh: BookSection = {
    level: 2, title: "BigCh",
    paragraphs: Array.from({ length: 30 }, () => paragraph(80) + "."), /* ~24×80 chars × 30 → много чанков */
  };
  const smallCh: BookSection = {
    level: 2, title: "SmallCh",
    paragraphs: ["short."],
  };
  const chunks = chunkBook(makeParseResult([longCh, smallCh]), "/p.txt", { targetChars: 800, maxChars: 1200, minChars: 200 });
  /* Все chunks из главы 0 — chunkIndex от 0 до N. */
  const ch0 = chunks.filter((c) => c.chapterIndex === 0);
  const ch1 = chunks.filter((c) => c.chapterIndex === 1);
  assert.ok(ch0.length >= 2, `expected ≥2 chunks in big chapter, got ${ch0.length}`);
  assert.equal(ch1.length, 1, "small chapter → 1 chunk");
  /* Монотонность 0,1,2,... */
  for (let i = 0; i < ch0.length; i++) {
    assert.equal(ch0[i].chunkIndex, i, `ch0 chunk position ${i} must have chunkIndex=${i}`);
  }
  /* Reset на новой главе. */
  assert.equal(ch1[0].chunkIndex, 0, "chunkIndex resets per chapter");
});

/* ─── deterministic id ─────────────────────────────────────────────── */

test("[chunker] chunkId детерминирован для одинакового текста + позиции", () => {
  const sections: BookSection[] = [{
    level: 2, title: "Ch",
    paragraphs: ["alpha beta gamma. ".repeat(10)],
  }];
  const a = chunkBook(makeParseResult(sections), "/path/a.txt");
  const b = chunkBook(makeParseResult(sections), "/path/a.txt");
  assert.equal(a.length, b.length);
  for (let i = 0; i < a.length; i++) {
    assert.equal(a[i].id, b[i].id, "same input → same id");
  }
});

test("[chunker] chunkId меняется при изменении bookSourcePath (id зависит от пути)", () => {
  const sections: BookSection[] = [{
    level: 2, title: "Ch",
    paragraphs: ["same body content here."],
  }];
  const a = chunkBook(makeParseResult(sections), "/path/a.txt");
  const b = chunkBook(makeParseResult(sections), "/path/b.txt");
  assert.notEqual(a[0].id, b[0].id, "different bookSourcePath → different id");
});

test("[chunker] chunkId формат: UUID-like 8-4-4-4-12 hex", () => {
  const sections: BookSection[] = [{
    level: 2, title: "Ch",
    paragraphs: ["body"],
  }];
  const chunks = chunkBook(makeParseResult(sections), "/p.txt");
  assert.match(chunks[0].id, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/,
    `chunkId must be UUID-like, got: ${chunks[0].id}`);
});

/* ─── splitLongParagraph ───────────────────────────────────────────── */

test("[chunker] длинный параграф режется по предложениям, не по середине слова", () => {
  /* Параграф длиннее maxChars, состоящий из ясных предложений с точками.
     splitLongParagraph должен разрезать ровно по границе предложения. */
  const longSent = "First sentence here is reasonable in length. ";
  const para = longSent.repeat(30); /* ~ 1380 chars > maxChars=1000 */
  const sections: BookSection[] = [{
    level: 2, title: "Long",
    paragraphs: [para],
  }];
  const chunks = chunkBook(makeParseResult(sections), "/p.txt", { targetChars: 600, maxChars: 1000, minChars: 200 });
  assert.ok(chunks.length >= 2, `expected ≥2 chunks for long para, got ${chunks.length}`);
  /* Каждый chunk заканчивается на предложение (точка/вопрос/восклицание/многоточие). */
  for (const ch of chunks) {
    assert.match(ch.text, /[.!?…]\s*$/, `chunk #${ch.chunkIndex} should end with sentence punct, got: ${ch.text.slice(-30)}`);
  }
});

test("[chunker] параграф без знаков препинания и длиннее maxChars режется hard-cut'ом", () => {
  /* Сплошной текст без точек длиной 3000 chars. Sentence regex не сработает,
     fallback на hard substring split. */
  const para = "x".repeat(3000);
  const sections: BookSection[] = [{
    level: 2, title: "Hardcut",
    paragraphs: [para],
  }];
  const chunks = chunkBook(makeParseResult(sections), "/p.txt", { targetChars: 800, maxChars: 1000, minChars: 200 });
  assert.ok(chunks.length >= 3, `expected ≥3 hard-cut chunks for 3000-char para, got ${chunks.length}`);
  /* Никакой chunk не превышает maxChars. */
  for (const ch of chunks) {
    assert.ok(ch.charCount <= 1000, `chunk exceeds maxChars: ${ch.charCount}`);
  }
});

/* ─── language tag ─────────────────────────────────────────────────── */

test("[chunker] добавляет lang:xx tag из metadata.language (первые 2 chars)", () => {
  const sections: BookSection[] = [{ level: 2, title: "Ch", paragraphs: ["body"] }];
  const ru = chunkBook(makeParseResult(sections, "ru"), "/p.txt");
  assert.deepEqual(ru[0].tags, ["lang:ru"]);
  const en = chunkBook(makeParseResult(sections, "en"), "/p.txt");
  assert.deepEqual(en[0].tags, ["lang:en"]);
  /* "english" → "en" (первые 2). */
  const long = chunkBook(makeParseResult(sections, "english"), "/p.txt");
  assert.deepEqual(long[0].tags, ["lang:en"]);
});

test("[chunker] пустой language → no lang tag", () => {
  const sections: BookSection[] = [{ level: 2, title: "Ch", paragraphs: ["body"] }];
  const chunks = chunkBook(makeParseResult(sections), "/p.txt");
  assert.deepEqual(chunks[0].tags, []);
});

/* ─── boundary cases ───────────────────────────────────────────────── */

test("[chunker] empty sections → empty chunks", () => {
  const chunks = chunkBook(makeParseResult([]), "/p.txt");
  assert.deepEqual(chunks, []);
});

test("[chunker] section с пустыми paragraphs → no chunk emitted", () => {
  const sections: BookSection[] = [{ level: 2, title: "Empty", paragraphs: [] }];
  const chunks = chunkBook(makeParseResult(sections), "/p.txt");
  assert.equal(chunks.length, 0, "пустая глава не порождает chunk");
});

test("[chunker] chunkBook прокидывает bookTitle и bookAuthor в каждый chunk", () => {
  const sections: BookSection[] = [
    { level: 2, title: "Ch1", paragraphs: ["a."] },
    { level: 2, title: "Ch2", paragraphs: ["b."] },
  ];
  const chunks = chunkBook(makeParseResult(sections, undefined, "My Book", "Author X"), "/p.txt");
  for (const ch of chunks) {
    assert.equal(ch.bookTitle, "My Book");
    assert.equal(ch.bookAuthor, "Author X");
    assert.equal(ch.bookSourcePath, "/p.txt");
  }
});

test("[chunker] charCount === text.length для каждого chunk (контракт для дальнейшего embedding)", () => {
  const sections: BookSection[] = [{
    level: 2, title: "Ch",
    paragraphs: Array.from({ length: 10 }, () => paragraph(40)),
  }];
  const chunks = chunkBook(makeParseResult(sections), "/p.txt");
  for (const ch of chunks) {
    assert.equal(ch.charCount, ch.text.length, "charCount must match text.length");
    assert.ok(ch.charCount > 0, "no empty chunks");
    assert.equal(ch.text, ch.text.trim(), "text must be trimmed");
  }
});

test("[chunker] параграфы внутри одного chunk соединены через `\\n\\n` (paragraph separator)", () => {
  /* Несколько коротких параграфов, попадают в один chunk → разделитель `\n\n`. */
  const sections: BookSection[] = [{
    level: 2, title: "Ch",
    paragraphs: ["first para here.", "second para here.", "third para here."],
  }];
  const chunks = chunkBook(makeParseResult(sections), "/p.txt");
  assert.equal(chunks.length, 1);
  /* Все три параграфа должны быть, разделённые \n\n. */
  assert.match(chunks[0].text, /first para here\./);
  assert.match(chunks[0].text, /second para here\./);
  assert.match(chunks[0].text, /third para here\./);
  assert.match(chunks[0].text, /\.\n\n/, "paragraphs separated by \\n\\n");
});
