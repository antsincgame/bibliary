/**
 * Encoding Detector — авто-определение и декодирование байтового буфера в UTF-8.
 *
 * Phase A+B Iter 9.2 (rev. 2 colibri-roadmap.md). Предназначен для решения
 * проблемы старых русских торрент-дампов: TXT/FB2/HTML/RTF в windows-1251,
 * KOI8-R, DOS-866 без UTF-8 BOM и без явных деклараций.
 *
 * АРХИТЕКТУРА (приоритеты от высшего к низшему):
 *
 *   1. BOM (UTF-8/UTF-16 BOM) — машинно-однозначная сигнатура, верим всегда.
 *   2. **In-content declaration** для XML/HTML:
 *        <?xml version="1.0" encoding="windows-1251"?>     (FB2/EPUB/XML)
 *        <meta charset="windows-1251">                       (HTML5)
 *        <meta http-equiv="content-type" content="...; charset=...">  (HTML4)
 *      Автор файла явно указал — **более авторитетно** чем chardet-эвристика.
 *   3. chardet — JS-port byte-pattern detection (для русских кодировок ~95% точность).
 *   4. UTF-8 как default — последний fallback.
 *
 * ИСПОЛЬЗОВАНИЕ:
 *
 *   const buf = await fs.readFile(file);
 *   const { text, encoding, warnings } = decodeBuffer(buf);
 *   // text — UTF-8 строка готовая к парсингу
 *   // encoding — что было определено (для логов и warnings)
 *
 * Поддерживается: utf-8, utf-16le/be, windows-1251, KOI8-R, IBM866 (DOS-866),
 * ISO-8859-5, и ~250 других через iconv-lite.
 *
 * НЕ ИСПОЛЬЗУЕМ:
 *  - jschardet (LGPL-2.1; chardet под MIT — единственный совместимый вариант)
 *  - Node TextDecoder без явной кодировки — он не угадывает, всегда UTF-8
 *
 * Performance: chardet.detect() ~1ms на 4 KB sample, не блокирует.
 *  Для файлов > 4 KB читаем только начальный sample buffer (saнsibility).
 */

import * as chardet from "chardet";
import * as iconv from "iconv-lite";

export interface DecodeResult {
  /** UTF-8 строка готовая для парсинга. */
  text: string;
  /** Детектированная кодировка (для логов и warnings). */
  encoding: string;
  /**
   * Источник определения:
   *   - "bom"     — обнаружена UTF-8/UTF-16 BOM
   *   - "xml"     — XML declaration `<?xml encoding="..."?>`
   *   - "html"    — HTML `<meta charset>` или `<meta http-equiv>`
   *   - "chardet" — chardet byte-pattern detection
   *   - "default" — fallback на UTF-8
   *   - "hint"    — caller передал hint encoding явно
   */
  source: "bom" | "xml" | "html" | "chardet" | "default" | "hint";
  /** Не критичные предупреждения (низкая уверенность, fallback и т.п.). */
  warnings: string[];
}

export interface DecodeOptions {
  /**
   * Явный hint от caller (если знаем формат и тип content).
   * Применяется ТОЛЬКО если BOM/inline-declaration не найдены.
   */
  fallbackEncoding?: string;
  /**
   * Парсить XML declaration `<?xml encoding=...?>` (для FB2/EPUB/OEB).
   * Default: false. Включаем только для парсеров XML-форматов.
   */
  parseXmlDeclaration?: boolean;
  /**
   * Парсить HTML `<meta charset>` / `<meta http-equiv>` (для HTML/HTM/XHTML).
   * Default: false. Включаем только для HTML-парсеров.
   */
  parseHtmlMeta?: boolean;
  /**
   * Sample size в байтах для chardet detection. Default 16 KB.
   * Большие сэмплы дороже но точнее на коротких текстах с малыми вкраплениями.
   */
  sampleSize?: number;
}

const DEFAULT_SAMPLE_SIZE = 16 * 1024;

/**
 * Главная функция: декодирует byte buffer в UTF-8 строку с авто-detection.
 *
 * @param buf — буфер из fs.readFile()
 * @param opts — опциональные подсказки (XML/HTML parsing flags, fallback)
 * @returns { text, encoding, source, warnings }
 */
export function decodeBuffer(buf: Buffer, opts: DecodeOptions = {}): DecodeResult {
  const warnings: string[] = [];

  /* === Шаг 0: empty buffer — нечего детектить, ранний return === */
  if (buf.length === 0) {
    return { text: "", encoding: "utf-8", source: "default", warnings };
  }

  /* === Шаг 1: BOM detection (highest authority) === */
  const bom = detectBom(buf);
  if (bom) {
    return {
      text: decodeWithBom(buf, bom),
      encoding: bom,
      source: "bom",
      warnings,
    };
  }

  /* === Шаг 2: in-content declaration === */
  if (opts.parseXmlDeclaration === true) {
    const xmlEnc = detectXmlDeclaration(buf, opts.sampleSize ?? DEFAULT_SAMPLE_SIZE);
    if (xmlEnc) {
      return decodeAsEncoding(buf, xmlEnc, "xml", warnings);
    }
  }
  if (opts.parseHtmlMeta === true) {
    const htmlEnc = detectHtmlMeta(buf, opts.sampleSize ?? DEFAULT_SAMPLE_SIZE);
    if (htmlEnc) {
      return decodeAsEncoding(buf, htmlEnc, "html", warnings);
    }
  }

  /* === Шаг 3: chardet byte-pattern detection === */
  const sample =
    buf.length > (opts.sampleSize ?? DEFAULT_SAMPLE_SIZE)
      ? buf.subarray(0, opts.sampleSize ?? DEFAULT_SAMPLE_SIZE)
      : buf;
  const detected = chardet.detect(sample);
  if (detected) {
    const normalized = normalizeEncodingName(detected);
    if (normalized && iconv.encodingExists(normalized)) {
      return decodeAsEncoding(buf, normalized, "chardet", warnings);
    }
    warnings.push(`chardet detected ${detected} but iconv-lite cannot decode it`);
  }

  /* === Шаг 4: hint от caller === */
  if (opts.fallbackEncoding && iconv.encodingExists(opts.fallbackEncoding)) {
    return decodeAsEncoding(buf, opts.fallbackEncoding, "hint", warnings);
  }

  /* === Шаг 5: default UTF-8 === */
  warnings.push("encoding could not be detected; falling back to UTF-8");
  return {
    text: buf.toString("utf8"),
    encoding: "utf-8",
    source: "default",
    warnings,
  };
}

/**
 * Определяет только BOM. Возвращает имя кодировки или null.
 * Не делает iconv-decode — только распознаёт сигнатуру.
 */
export function detectBom(buf: Buffer): string | null {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return "utf-8";
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    /* Может быть UTF-16 LE или UTF-32 LE (FF FE 00 00). */
    if (buf.length >= 4 && buf[2] === 0x00 && buf[3] === 0x00) {
      return "utf-32le";
    }
    return "utf-16le";
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return "utf-16be";
  }
  if (buf.length >= 4 && buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0xfe && buf[3] === 0xff) {
    return "utf-32be";
  }
  return null;
}

/**
 * Декодирует buffer с известной BOM. Срезает BOM-байты.
 */
function decodeWithBom(buf: Buffer, bom: string): string {
  switch (bom) {
    case "utf-8":
      return buf.subarray(3).toString("utf8");
    case "utf-16le":
      return buf.subarray(2).toString("utf16le");
    case "utf-16be": {
      /* Node не имеет нативного utf16be — byte-swap руками. */
      const swapped = Buffer.allocUnsafe(buf.length - 2);
      for (let i = 2; i + 1 < buf.length; i += 2) {
        swapped[i - 2] = buf[i + 1]!;
        swapped[i - 1] = buf[i]!;
      }
      return swapped.toString("utf16le");
    }
    case "utf-32le":
    case "utf-32be":
      /* iconv-lite поддерживает utf-32. */
      return iconv.decode(buf.subarray(4), bom);
    default:
      return buf.toString("utf8");
  }
}

/**
 * Извлекает encoding из XML declaration: `<?xml version="1.0" encoding="windows-1251"?>`.
 * Читает первые `sampleSize` байт как ASCII (declaration всегда ASCII-совместима).
 */
function detectXmlDeclaration(buf: Buffer, sampleSize: number): string | null {
  const head = buf.subarray(0, Math.min(sampleSize, 1024)).toString("latin1");
  /* XML decl должна быть в самом начале документа (после optional whitespace).
     Регулярка строгая: <?xml ... encoding="..." ... ?> */
  const match = head.match(/^\s*<\?xml\s+[^?]*?encoding\s*=\s*["']([^"']+)["']/i);
  if (match) {
    const enc = normalizeEncodingName(match[1]);
    if (enc && iconv.encodingExists(enc)) return enc;
  }
  return null;
}

/**
 * Извлекает charset из HTML `<meta charset>` или `<meta http-equiv>`.
 * HTML5: `<meta charset="windows-1251">`
 * HTML4: `<meta http-equiv="Content-Type" content="text/html; charset=windows-1251">`
 */
function detectHtmlMeta(buf: Buffer, sampleSize: number): string | null {
  const head = buf.subarray(0, Math.min(sampleSize, 4096)).toString("latin1");
  /* HTML5 short form. */
  const html5 = head.match(/<meta\s+[^>]*charset\s*=\s*["']?([a-z0-9_\-]+)["'\s>/]/i);
  if (html5) {
    const enc = normalizeEncodingName(html5[1]);
    if (enc && iconv.encodingExists(enc)) return enc;
  }
  /* HTML4 http-equiv. */
  const html4 = head.match(
    /<meta\s+[^>]*http-equiv\s*=\s*["']content-type["'][^>]*content\s*=\s*["'][^"']*charset\s*=\s*([a-z0-9_\-]+)/i,
  );
  if (html4) {
    const enc = normalizeEncodingName(html4[1]);
    if (enc && iconv.encodingExists(enc)) return enc;
  }
  return null;
}

/**
 * Декодирует через iconv-lite + проверка ошибок.
 */
function decodeAsEncoding(
  buf: Buffer,
  encoding: string,
  source: DecodeResult["source"],
  warnings: string[],
): DecodeResult {
  try {
    const text = iconv.decode(buf, encoding);
    return { text, encoding, source, warnings };
  } catch (err) {
    warnings.push(
      `iconv-lite failed to decode as ${encoding}: ${err instanceof Error ? err.message : String(err)}; falling back to UTF-8`,
    );
    return {
      text: buf.toString("utf8"),
      encoding: "utf-8",
      source: "default",
      warnings,
    };
  }
}

/**
 * Нормализует имя кодировки к виду, принятому в iconv-lite.
 * Например: "WINDOWS-1251" → "windows-1251", "cp866" → "ibm866", и т.д.
 */
function normalizeEncodingName(raw: string): string | null {
  const lower = raw.trim().toLowerCase().replace(/_/g, "-");
  /* iconv-lite принимает большинство канонических имён напрямую. */
  const aliases: Record<string, string> = {
    "cp866": "ibm866",
    "cp1251": "windows-1251",
    "windows1251": "windows-1251",
    "win-1251": "windows-1251",
    "cp1252": "windows-1252",
    "windows1252": "windows-1252",
    "koi8r": "koi8-r",
    "koi8u": "koi8-u",
    "macroman": "macintosh",
    "iso8859-1": "iso-8859-1",
    "iso88591": "iso-8859-1",
    "iso8859-5": "iso-8859-5",
  };
  return aliases[lower] ?? lower;
}

/**
 * Утилита для тестов и отладки: список поддерживаемых кодировок.
 */
export function isEncodingSupported(name: string): boolean {
  const normalized = normalizeEncodingName(name);
  return normalized !== null && iconv.encodingExists(normalized);
}
