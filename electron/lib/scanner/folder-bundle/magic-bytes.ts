/**
 * Magic-byte детектор для файлов без расширения или с неинформативным
 * расширением (.dat / .bin / .ocf / .odc / .osf и т.п.).
 *
 * Принцип: читаем первые 32 байта файла, сравниваем с известными
 * сигнатурами. Возвращаем `FileKind` или `null` если ничего не подошло.
 *
 * Это намеренно НЕ заменяет ext-классификатор, а работает в паре с ним:
 *   1. Сначала классифицируется по расширению (быстро, без I/O)
 *   2. Если результат `unknown` — пробуем magic bytes
 *   3. Если magic bytes не дали ответа — пробуем text-эвристику (ASCII ratio)
 *
 * Этот модуль — pure (никакого fs / sync I/O), все функции принимают `Buffer`.
 */

import type { FileKind } from "./classifier.js";

/** Имена файлов без расширения, которые мы знаем точно. */
export const KNOWN_FILENAMES_NO_EXT: Record<string, FileKind> = {
  "license":            "metadata",
  "licence":            "metadata",
  "copying":            "metadata",
  "copyright":          "metadata",
  "readme":             "metadata",
  "authors":            "metadata",
  "contributors":       "metadata",
  "changelog":          "metadata",
  "history":            "metadata",
  "notice":             "metadata",
  /* код-без-расширения */
  "dockerfile":         "code",
  "makefile":           "code",
  "rakefile":           "code",
  "gemfile":            "code",
  "procfile":           "code",
  "vagrantfile":        "code",
  "jenkinsfile":        "code",
};

/**
 * Детект по первым байтам файла. Передавать как минимум 16 байт; если
 * `head.length < 4` — функция вернёт `null`.
 */
export function detectByMagic(head: Buffer): FileKind | null {
  if (head.length < 4) return null;

  /* ── Книги ─────────────────────────────────────────────────────────── */
  /* PDF: "%PDF" */
  if (head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46) return "book";

  /* DjVu: "AT&T" + "FORM" + "DJVU" — обычно `AT&TFORM\0\0\0\0DJV` */
  if (head[0] === 0x41 && head[1] === 0x54 && head[2] === 0x26 && head[3] === 0x54) return "book";

  /* MOBI / PalmDOC: "BOOKMOBI" в первых 60 байтах часто, но самые надёжные
     первые байты — название базы данных PalmDB; пропустим, оставим ext. */

  /* ── Картинки ──────────────────────────────────────────────────────── */
  /* PNG: 89 50 4E 47 0D 0A 1A 0A */
  if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return "image";

  /* JPEG: FF D8 FF */
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image";

  /* GIF: "GIF8" */
  if (head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x38) return "image";

  /* BMP: "BM" */
  if (head[0] === 0x42 && head[1] === 0x4d) return "image";

  /* TIFF: II*\0  или MM\0* */
  if ((head[0] === 0x49 && head[1] === 0x49 && head[2] === 0x2a && head[3] === 0x00) ||
      (head[0] === 0x4d && head[1] === 0x4d && head[2] === 0x00 && head[3] === 0x2a)) return "image";

  /* WebP: RIFF....WEBP */
  if (head.length >= 12 &&
      head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46 &&
      head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50) return "image";

  /* ── ZIP-based: EPUB / DOCX / ODT / etc. ───────────────────────────── */
  /* "PK\x03\x04" — ZIP entry */
  if (head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) {
    /* Без расширения — оставляем как archive (ingest сам разберётся через
       7z-bin если внутри книга). С расширением .epub/.docx/.odt — уже
       обработано классификатором по ext. */
    return "archive";
  }

  /* ── Бинарные / опасные ────────────────────────────────────────────── */
  /* ELF: 7F 45 4C 46 */
  if (head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46) return "archive"; /* skipped downstream */

  /* PE/DOS executable: "MZ" */
  if (head[0] === 0x4d && head[1] === 0x5a) return "archive";

  /* Mach-O: CA FE BA BE / CF FA ED FE / CE FA ED FE */
  if ((head[0] === 0xca && head[1] === 0xfe && head[2] === 0xba && head[3] === 0xbe) ||
      (head[0] === 0xcf && head[1] === 0xfa && head[2] === 0xed && head[3] === 0xfe) ||
      (head[0] === 0xce && head[1] === 0xfa && head[2] === 0xed && head[3] === 0xfe)) return "archive";

  /* ── Component Pascal / Oberon (BlackBox) — реальный кейс из D:\\Bibliarifull
       Эти форматы можно прочитать только в BlackBox-runtime; для нашего
       pipeline они бесполезны → отправляем в archive (далее → skipped).
       - "FCOo" .ocf — компилированные модули кода
       - "CDOo" .odc — документы (текст в проприетарном формате)
       - "FSOo" .osf — структурированные данные / storage
   ───────────────────────────────────────────────────────────────────── */
  if (head[0] === 0x46 && head[1] === 0x43 && head[2] === 0x4f && head[3] === 0x6f) return "archive"; /* .ocf */
  if (head[0] === 0x43 && head[1] === 0x44 && head[2] === 0x4f && head[3] === 0x6f) return "archive"; /* .odc */
  if (head[0] === 0x46 && head[1] === 0x53 && head[2] === 0x4f && head[3] === 0x6f) return "archive"; /* .osf */

  /* ── Чистая XML / SVG ──────────────────────────────────────────────── */
  /* SVG starts with <?xml or <svg (после возможного UTF-8 BOM) */
  let textStart = head;
  if (head.length >= 3 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) {
    textStart = head.subarray(3);
  }
  const lead = textStart.subarray(0, Math.min(16, textStart.length)).toString("utf8").trim().toLowerCase();
  if (lead.startsWith("<svg")) return "image";
  if (lead.startsWith("<?xml") && /svg\b/.test(textStart.subarray(0, 200).toString("utf8").toLowerCase())) return "image";

  /* HTML без расширения */
  if (lead.startsWith("<!doctype html") || lead.startsWith("<html") || lead.startsWith("<head")) return "html-site";

  /* JSON */
  if (lead.startsWith("{") || lead.startsWith("[")) {
    /* Грубый признак — но для bundle-import metadata полезно. */
    return "metadata";
  }

  return null;
}

/**
 * Грубый детект «это текст?»: процент ASCII-печатных символов или
 * утвердительный UTF-8 декод без replacement chars.
 *
 * Возвращает:
 *   - "text"   если файл выглядит как текст (≥70% ASCII printable + LF/CR/TAB)
 *   - "binary" иначе
 */
export function isLikelyText(head: Buffer): "text" | "binary" {
  if (head.length === 0) return "text";
  /* UTF-16 BOM детект — это уже текст. */
  if (head.length >= 2 && (
    (head[0] === 0xff && head[1] === 0xfe) ||
    (head[0] === 0xfe && head[1] === 0xff)
  )) return "text";

  let printable = 0;
  let nul = 0;
  for (let i = 0; i < head.length; i++) {
    const b = head[i]!;
    if (b === 0) nul++;
    else if (b === 0x09 || b === 0x0a || b === 0x0d) printable++;
    else if (b >= 0x20 && b <= 0x7e) printable++;
    else if (b >= 0x80) printable++; /* возможный UTF-8 multibyte */
  }
  if (nul / head.length > 0.05) return "binary";
  if (printable / head.length >= 0.7) return "text";
  return "binary";
}

/**
 * Эвристика для текстового файла без расширения: по содержимому понимает
 * что это `code` (есть код-маркеры), `metadata` (license/readme), или
 * `unknown`.
 */
export function classifyTextContent(head: Buffer): FileKind | null {
  const text = head.subarray(0, Math.min(2048, head.length)).toString("utf8");
  const lower = text.toLowerCase();

  /* License/copyright */
  if (/\b(mit license|apache license|bsd license|gnu general public|copyright \(c\))/i.test(text)) {
    return "metadata";
  }

  /* Dockerfile / Makefile signatures */
  if (/^FROM\s+[\w\-./:]+/m.test(text)) return "code"; /* Docker */
  if (/^[\w\-]+:\s*\n\t/m.test(text)) return "code";   /* Make */

  /* Common code markers (cross-language) */
  if (/^(#include|#pragma|using namespace|import\s+\w+|from\s+\w+\s+import|package\s+\w+)/m.test(text)) {
    return "code";
  }

  /* Plain HTML без doctype */
  if (/<html\b/i.test(lower) || /<body\b/i.test(lower)) return "html-site";

  return null;
}
