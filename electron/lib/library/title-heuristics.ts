const NOISE_BOOK_TITLES = new Set([
  "предисловие",
  "введение",
  "оглавление",
  "содержание",
  "об авторе",
  "об авторх",
  "об авторах",
  "about the author",
  "about the authors",
  "contents",
  "table of contents",
  "foreword",
  "preface",
  "introduction",
  "copyright",
  "colophon",
  "title page",
]);

const STRUCTURAL_TITLE_RE = /^(?:chapter|section|page|глава|раздел|страница)\s+[0-9ivxlcdm]+$/iu;

/**
 * PDF hex-string в Document Info: `<A8D4E0E8...>`. Старые российские PDF
 * (особенно сканы из PRO100/FineReader) пишут Title как **сырые байты в
 * CP1251**, обёрнутые в `<...>` вместо UTF-16BE с BOM. pdfjs / pdf-inspector
 * возвращают это как литерал, без декодирования.
 */
const PDF_HEX_STRING_RE = /^\s*<\s*([0-9A-Fa-f\s]+?)\s*>\s*$/;

/**
 * `looksLikeUselessHexBlob` — последняя сетка от мусора. Например, если
 * декодер не справился, и в title прорвалось что-то вроде "ёфаиосо..." —
 * хотя бы не показываем его пользователю.
 *
 * Эвристика: ≥80% символов вне диапазона нормального текста (управляющие,
 * крайне редкие unicode-блоки), плюс длина ≥ 30 символов (короткие фразы
 * пропускаем — "Ёж" нормальный заголовок).
 */
function looksLikeUselessHexBlob(value: string): boolean {
  if (value.length < 30) return false;
  let weird = 0;
  for (const ch of value) {
    const cp = ch.codePointAt(0)!;
    /* Контролы и Private Use Area — точно мусор. */
    if (cp < 0x20 || (cp >= 0xe000 && cp <= 0xf8ff)) {
      weird += 1;
      continue;
    }
    /* Замещающий символ U+FFFD (decoder failure). */
    if (cp === 0xfffd) {
      weird += 1;
    }
  }
  return weird / value.length >= 0.5;
}

/* CP1251 decode table: PDF Title из российских OCR-сканов часто кодируется
 * Windows-1251 байтами, упакованными в hex-string. Если первая попытка
 * (UTF-16BE) даёт высокий weird-ratio, пробуем CP1251 как fallback. */
const CP1251_HIGH: Record<number, string> = {
  0x80: "Ђ", 0x81: "Ѓ", 0x82: "‚", 0x83: "ѓ", 0x84: "„", 0x85: "…", 0x86: "†", 0x87: "‡",
  0x88: "€", 0x89: "‰", 0x8a: "Љ", 0x8b: "‹", 0x8c: "Њ", 0x8d: "Ќ", 0x8e: "Ћ", 0x8f: "Џ",
  0x90: "ђ", 0x91: "‘", 0x92: "’", 0x93: "“", 0x94: "”", 0x95: "•", 0x96: "–", 0x97: "—",
  0x99: "™", 0x9a: "љ", 0x9b: "›", 0x9c: "њ", 0x9d: "ќ", 0x9e: "ћ", 0x9f: "џ",
  0xa0: "\u00a0", 0xa1: "Ў", 0xa2: "ў", 0xa3: "Ј", 0xa4: "¤", 0xa5: "Ґ", 0xa6: "¦", 0xa7: "§",
  0xa8: "Ё", 0xa9: "©", 0xaa: "Є", 0xab: "«", 0xac: "¬", 0xad: "\u00ad", 0xae: "®", 0xaf: "Ї",
  0xb0: "°", 0xb1: "±", 0xb2: "І", 0xb3: "і", 0xb4: "ґ", 0xb5: "µ", 0xb6: "¶", 0xb7: "·",
  0xb8: "ё", 0xb9: "№", 0xba: "є", 0xbb: "»", 0xbc: "ј", 0xbd: "Ѕ", 0xbe: "ѕ", 0xbf: "ї",
};

function decodeCp1251(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) {
    if (byte < 0x80) {
      out += String.fromCharCode(byte);
    } else if (byte >= 0xc0) {
      /* C0..FF → А..я (Cyrillic block U+0410..U+044F). */
      out += String.fromCharCode(0x0410 + (byte - 0xc0));
    } else {
      out += CP1251_HIGH[byte] ?? String.fromCharCode(0xfffd);
    }
  }
  return out;
}

function decodeUtf16Be(bytes: Uint8Array): string {
  if (bytes.length % 2 !== 0) return "\ufffd";
  let out = "";
  for (let i = 0; i < bytes.length; i += 2) {
    const cp = (bytes[i]! << 8) | bytes[i + 1]!;
    out += String.fromCharCode(cp);
  }
  return out;
}

/**
 * Оценить «осмысленность» декодированного заголовка.
 *
 * Возвращает доля «обычных» символов (Latin / Cyrillic / Greek / общая
 * пунктуация / цифры / пробел) в строке. Низкая доля → декод выдал мусор
 * (CJK иероглифы для русского текста, замещающий U+FFFD, control chars).
 */
function readableRatio(text: string): number {
  if (text.length === 0) return 0;
  let good = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (
      (cp >= 0x0020 && cp <= 0x007e) /* ASCII printable */
      || (cp >= 0x00a0 && cp <= 0x024f) /* Latin-1 + Latin Extended */
      || (cp >= 0x0370 && cp <= 0x03ff) /* Greek */
      || (cp >= 0x0400 && cp <= 0x04ff) /* Cyrillic */
      || (cp >= 0x2000 && cp <= 0x206f) /* General punctuation */
      || (cp >= 0x2070 && cp <= 0x209f) /* Super/subscripts */
      || (cp >= 0x20a0 && cp <= 0x20cf) /* Currency */
      || cp === 0x00a9 /* © */
      || cp === 0x2116 /* № */
    ) {
      good += 1;
    }
  }
  return good / text.length;
}

/**
 * Расшифровать PDF hex-string title (`<A8D4...>`) через несколько кодировок,
 * выбрать вариант с максимальной долей читаемых символов.
 *
 * Старая версия использовала только U+FFFD-ratio — UTF-16BE интерпретация
 * CP1251 байтов давала валидные (но абсурдные) CJK иероглифы и проходила
 * метрику. Теперь выбираем по `readableRatio`: только декод с ≥85% символов
 * из «нормальных» Unicode-блоков считается успешным.
 *
 * @returns декодированная строка или undefined если ни одна кодировка не
 *          дала вменяемого результата.
 */
export function decodePdfHexTitle(raw: string): string | undefined {
  const m = PDF_HEX_STRING_RE.exec(raw);
  if (!m) return undefined;
  const hex = m[1]!.replace(/\s+/g, "");
  if (hex.length === 0 || hex.length % 2 !== 0) return undefined;

  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }

  /* Перебираем варианты декода, считаем readableRatio для каждого. */
  const candidates: Array<{ text: string; label: string }> = [];

  /* UTF-16BE с BOM (PDF spec) — приоритет. */
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    candidates.push({
      text: decodeUtf16Be(bytes.subarray(2)),
      label: "utf16be-bom",
    });
  }
  /* CP1251 — частый случай для российских OCR-сканов. */
  candidates.push({ text: decodeCp1251(bytes), label: "cp1251" });
  /* UTF-16BE без BOM — на случай если BOM забыли. */
  candidates.push({ text: decodeUtf16Be(bytes), label: "utf16be-no-bom" });
  /* PDFDocEncoding ≈ Latin-1 для bytes 0x20-0x7E — fallback. */
  candidates.push({
    text: Array.from(bytes)
      .map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : "\ufffd"))
      .join(""),
    label: "ascii-only",
  });

  let best: string | undefined;
  let bestRatio = -1;
  for (const c of candidates) {
    const cleaned = c.text.replace(/[\u0000-\u001f\u007f]/g, "").trim();
    if (cleaned.length === 0) continue;
    const ratio = readableRatio(cleaned);
    if (ratio > bestRatio) {
      bestRatio = ratio;
      best = cleaned;
    }
  }

  /* Принимаем результат только если ≥80% символов из «нормальных» блоков.
   * Иначе декодер не справился — пусть caller уйдёт в filename fallback. */
  if (!best || bestRatio < 0.8) return undefined;
  return best;
}

function normalizeTitleCandidate(value: string): string {
  return value
    .trim()
    .replace(/^[\s"'`([{]+|[\s"'`)\].,:;!?]+$/gu, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/**
 * Санитизация title до того как он попадёт в каталог. Вызывается каждым
 * парсером (pdf, pdf-inspector, djvu) перед `pickBestBookTitle`.
 *
 * Действия:
 *  1. PDF hex-string `<A8D4...>` → декодировать (CP1251 / UTF-16BE).
 *  2. Если декод не сработал ИЛИ результат — мусор (control chars / U+FFFD)
 *     → вернуть undefined (чтобы вызывающий ушёл в filename fallback).
 *  3. Trim. Длинные strings (> 200 chars) считаем подозрительными.
 */
export function sanitizeRawTitle(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  if (PDF_HEX_STRING_RE.test(trimmed)) {
    const decoded = decodePdfHexTitle(trimmed);
    if (!decoded) return undefined;
    if (looksLikeUselessHexBlob(decoded)) return undefined;
    return decoded;
  }

  if (looksLikeUselessHexBlob(trimmed)) return undefined;

  /* Параноя: длинный (≥250) title без пробелов — заведомо мусор (хеш, base64). */
  if (trimmed.length >= 250 && !/\s/.test(trimmed)) return undefined;

  return trimmed;
}

export function isLowValueBookTitle(value: string | null | undefined): boolean {
  if (!value || !value.trim()) return true;
  const normalized = normalizeTitleCandidate(value);
  if (!normalized) return true;
  return NOISE_BOOK_TITLES.has(normalized) || STRUCTURAL_TITLE_RE.test(normalized);
}

export function pickBestBookTitle(...candidates: Array<string | null | undefined>): string | undefined {
  let fallback: string | undefined;
  for (const candidate of candidates) {
    /* Прогоняем КАЖДЫЙ кандидат через sanitizer: PDF hex / control chars
     * не должны попасть в каталог даже если они «не low-value». */
    const sanitized = sanitizeRawTitle(candidate);
    if (!sanitized) continue;
    fallback ??= sanitized;
    if (!isLowValueBookTitle(sanitized)) {
      return sanitized;
    }
  }
  return fallback;
}
