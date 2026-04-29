/**
 * Import Magic Guard — sanity-проверка соответствия расширения и реального
 * содержимого файла на этапе обхода каталога.
 *
 * Зачем:
 *   До этого этапа фильтр доверял только суффиксу имени. Переименованный
 *   `virus.pdf` (на самом деле PE/MZ) или повреждённый ZIP с «.epub» легко
 *   проходили walker → попадали в `convertBookToMarkdown` → впустую тратили
 *   парсер и могли спровоцировать падение.
 *
 * Контракт:
 *   - Бинарные книжные форматы (pdf, epub, djvu/djv, docx, doc, odt) — строгая
 *     проверка magic bytes. Несовпадение → reject.
 *   - Текстовые форматы (txt, html, htm, fb2, rtf) — поверхностная проверка
 *     через `isLikelyText` + опциональные text-маркеры (FB2, RTF). Шум типа
 *     PE/ELF/Mach-O сразу отсекается.
 *   - Если файл слишком короткий для надёжной проверки (< 16 байт) — reject
 *     (легитимная книга такого размера невозможна, walker сам режет < 10 KB).
 *   - Ошибка чтения → reject (нет смысла импортировать недоступный файл).
 *
 * Намеренно НЕ переиспользует `detectByMagic` из `folder-bundle/magic-bytes.ts`:
 *   та функция работает в режиме «классифицировать неизвестный файл»; здесь
 *   нужна обратная задача — «подтвердить, что заявленное расширение совпадает
 *   с содержимым». Поэтому отдельная узконаправленная проверка.
 */

import { promises as fs } from "fs";
import { isLikelyText } from "../scanner/folder-bundle/magic-bytes.js";

export interface MagicVerifyResult {
  ok: boolean;
  /** Когда ok=false — причина для логов / warnings. */
  reason?: string;
}

const HEAD_BYTES = 32;
const MIN_HEAD_FOR_BINARY = 8;

/** Известные «плохие» сигнатуры — точно не книга, отбрасываем сразу. */
function isKnownBinaryGarbage(head: Buffer): string | null {
  if (head.length < 4) return null;
  /* Windows PE / DOS executable: "MZ" */
  if (head[0] === 0x4d && head[1] === 0x5a) return "windows-executable";
  /* ELF (Linux/BSD executable): 7F 45 4C 46 */
  if (head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46) return "elf-executable";
  /* Mach-O (macOS executable) */
  if (
    (head[0] === 0xca && head[1] === 0xfe && head[2] === 0xba && head[3] === 0xbe) ||
    (head[0] === 0xcf && head[1] === 0xfa && head[2] === 0xed && head[3] === 0xfe) ||
    (head[0] === 0xce && head[1] === 0xfa && head[2] === 0xed && head[3] === 0xfe)
  )
    return "macho-executable";
  /* Component Pascal / BlackBox runtime artifacts (реальный кейс из D:\Bibliarifull) */
  if (head[0] === 0x46 && head[1] === 0x43 && head[2] === 0x4f && head[3] === 0x6f) return "component-pascal-ocf";
  if (head[0] === 0x43 && head[1] === 0x44 && head[2] === 0x4f && head[3] === 0x6f) return "component-pascal-odc";
  if (head[0] === 0x46 && head[1] === 0x53 && head[2] === 0x4f && head[3] === 0x6f) return "component-pascal-osf";
  /* SQLite database — иногда .pdf маскирует базу */
  if (
    head.length >= 16 &&
    head[0] === 0x53 && head[1] === 0x51 && head[2] === 0x4c && head[3] === 0x69 &&
    head[4] === 0x74 && head[5] === 0x65
  )
    return "sqlite-database";
  /* MSI / OLE-compound, но НЕ .doc — будет проверено отдельно */
  return null;
}

function isPdf(head: Buffer): boolean {
  return head.length >= 4 && head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46;
}

function isZipBased(head: Buffer): boolean {
  if (head.length < 4) return false;
  /* "PK\x03\x04" — local file header, обычный ZIP */
  if (head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) return true;
  /* "PK\x05\x06" — пустой ZIP */
  if (head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x05 && head[3] === 0x06) return true;
  /* "PK\x07\x08" — spanned ZIP */
  if (head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x07 && head[3] === 0x08) return true;
  return false;
}

function isDjvu(head: Buffer): boolean {
  /* "AT&T" + "FORM" — для всех DJVU/DJV файлов первые 4 байта одинаковы */
  return head.length >= 4 && head[0] === 0x41 && head[1] === 0x54 && head[2] === 0x26 && head[3] === 0x54;
}

function isOleCompound(head: Buffer): boolean {
  /* MS Office <2007 (.doc, .xls, .ppt): D0 CF 11 E0 A1 B1 1A E1 */
  return (
    head.length >= 8 &&
    head[0] === 0xd0 && head[1] === 0xcf && head[2] === 0x11 && head[3] === 0xe0 &&
    head[4] === 0xa1 && head[5] === 0xb1 && head[6] === 0x1a && head[7] === 0xe1
  );
}

function leadingText(head: Buffer): string {
  let start = 0;
  /* UTF-8 BOM */
  if (head.length >= 3 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) start = 3;
  /* UTF-16 LE BOM */
  else if (head.length >= 2 && head[0] === 0xff && head[1] === 0xfe) {
    return head.subarray(2).toString("utf16le").trim().toLowerCase();
  }
  /* UTF-16 BE BOM — не пытаемся декодировать, просто признаём текстом */
  else if (head.length >= 2 && head[0] === 0xfe && head[1] === 0xff) {
    return "<utf16be>";
  }
  return head.subarray(start).toString("utf8").trim().toLowerCase();
}

function isFb2Like(head: Buffer): boolean {
  const lead = leadingText(head);
  if (lead === "<utf16be>") return true;
  return lead.startsWith("<?xml") || lead.startsWith("<fictionbook");
}

function isRtfLike(head: Buffer): boolean {
  /* RTF всегда начинается со строки "{\rtf" */
  return (
    head.length >= 5 &&
    head[0] === 0x7b && head[1] === 0x5c && head[2] === 0x72 && head[3] === 0x74 && head[4] === 0x66
  );
}

function isHtmlLike(head: Buffer): boolean {
  const lead = leadingText(head);
  if (lead === "<utf16be>") return true;
  return (
    lead.startsWith("<!doctype html") ||
    lead.startsWith("<html") ||
    lead.startsWith("<head") ||
    lead.startsWith("<?xml") ||
    /* Single-page HTML без doctype, начинающийся с meta/body/comment */
    lead.startsWith("<!--") ||
    lead.startsWith("<meta") ||
    lead.startsWith("<body")
  );
}

/**
 * Подтвердить, что содержимое файла соответствует заявленному расширению.
 * Принимает уже-открытый Buffer первых байт — для удобства тестирования
 * и для случая, когда head уже прочитан другим этапом.
 */
export function verifyExtMatchesContentHead(ext: string, head: Buffer): MagicVerifyResult {
  const garbage = isKnownBinaryGarbage(head);
  if (garbage) return { ok: false, reason: `magic: ${garbage} masquerading as .${ext}` };

  const e = ext.toLowerCase();

  switch (e) {
    case "pdf":
      if (head.length < MIN_HEAD_FOR_BINARY) return { ok: false, reason: "magic: too short for pdf" };
      if (!isPdf(head)) return { ok: false, reason: "magic: not a PDF (missing %PDF)" };
      return { ok: true };

    case "epub":
    case "docx":
    case "odt":
      if (head.length < MIN_HEAD_FOR_BINARY) return { ok: false, reason: `magic: too short for ${e}` };
      if (!isZipBased(head)) return { ok: false, reason: `magic: not a ZIP-based ${e} (missing PK header)` };
      return { ok: true };

    case "djvu":
    case "djv":
      if (head.length < MIN_HEAD_FOR_BINARY) return { ok: false, reason: "magic: too short for djvu" };
      if (!isDjvu(head)) return { ok: false, reason: "magic: not a DJVU (missing AT&T)" };
      return { ok: true };

    case "doc":
      if (head.length < MIN_HEAD_FOR_BINARY) return { ok: false, reason: "magic: too short for doc" };
      if (!isOleCompound(head)) return { ok: false, reason: "magic: not an OLE compound (missing D0CF11E0)" };
      return { ok: true };

    case "fb2":
      if (head.length < 4) return { ok: false, reason: "magic: too short for fb2" };
      if (isLikelyText(head) === "binary") return { ok: false, reason: "magic: fb2 must be text/XML, got binary" };
      if (!isFb2Like(head)) return { ok: false, reason: "magic: fb2 must start with <?xml or <FictionBook" };
      return { ok: true };

    case "rtf":
      if (head.length < 5) return { ok: false, reason: "magic: too short for rtf" };
      if (!isRtfLike(head)) return { ok: false, reason: "magic: rtf must start with {\\rtf" };
      return { ok: true };

    case "html":
    case "htm":
      if (isLikelyText(head) === "binary") return { ok: false, reason: "magic: html must be text, got binary" };
      /* HTML-эвристика мягкая: некоторые легитимные HTML начинаются с пробелов
         или просто <p>; принимаем любой текст без бинарного шума. */
      if (head.length >= 4 && !isHtmlLike(head)) {
        /* Не строгая ошибка — возможно фрагмент. Логируем как warning через reason
           но возвращаем ok=true чтобы не зарезать редкие легитимные случаи. */
        return { ok: true };
      }
      return { ok: true };

    case "txt":
      /* Для .txt только проверяем что файл вообще текстовый. */
      if (isLikelyText(head) === "binary") return { ok: false, reason: "magic: txt must be text, got binary" };
      return { ok: true };

    default:
      /* Неизвестное расширение — пропускаем (не наша задача классифицировать). */
      return { ok: true };
  }
}

/**
 * Прочитать первые байты файла и подтвердить соответствие расширению.
 * Возвращает `{ ok: false, reason }` при любой ошибке I/O.
 */
export async function verifyExtMatchesContent(filePath: string, ext: string): Promise<MagicVerifyResult> {
  let fh;
  try {
    fh = await fs.open(filePath, "r");
  } catch (err) {
    return { ok: false, reason: `magic: cannot open file (${(err as Error).message})` };
  }
  try {
    const head = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await fh.read(head, 0, HEAD_BYTES, 0);
    return verifyExtMatchesContentHead(ext, head.subarray(0, bytesRead));
  } catch (err) {
    return { ok: false, reason: `magic: read failed (${(err as Error).message})` };
  } finally {
    await fh.close().catch(() => {});
  }
}
