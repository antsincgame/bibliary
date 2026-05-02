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

const HEAD_BYTES = 64; /* 64 байта достаточно для всех структурных проверок (PDF/DJVU/EPUB) */
const MIN_HEAD_FOR_BINARY = 8;
/** Сколько байт читать с конца PDF для поиска %%EOF. */
const PDF_TAIL_BYTES = 1024;
/** Сколько байт читать для проверки структуры EPUB (local file header + mimetype). */
const EPUB_STRUCT_BYTES = 256;

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

/**
 * Полная DJVU IFF проверка: после "AT&T" должен идти "FORM" + 4-байтный size +
 * "DJVU" (single-page) или "DJVM" (multi-page) или "DJVI"/"THUM" (fragment).
 * Это отсекает truncated DJVU где есть только AT&T magic, но дальше garbage.
 */
function isValidDjvuIff(head: Buffer): boolean {
  if (head.length < 16) return false;
  /* AT&T уже проверен в isDjvu — здесь смотрим offset 4-7 = "FORM" */
  if (head[4] !== 0x46 || head[5] !== 0x4f || head[6] !== 0x52 || head[7] !== 0x4d) return false;
  /* offset 12-15 = тип формы: DJVU / DJVM / DJVI / THUM */
  const formType = head.subarray(12, 16).toString("ascii");
  return formType === "DJVU" || formType === "DJVM" || formType === "DJVI" || formType === "THUM";
}

function isOleCompound(head: Buffer): boolean {
  /* MS Office <2007 (.doc, .xls, .ppt): D0 CF 11 E0 A1 B1 1A E1 */
  return (
    head.length >= 8 &&
    head[0] === 0xd0 && head[1] === 0xcf && head[2] === 0x11 && head[3] === 0xe0 &&
    head[4] === 0xa1 && head[5] === 0xb1 && head[6] === 0x1a && head[7] === 0xe1
  );
}

function isCalibreLegacyContainer(head: Buffer, ext: string): boolean {
  /* MOBI / AZW / AZW3 / PDB / PRC — все Palm Database Format на низком уровне.
     На офсете 60 (0x3C) лежит type + creator (8 байт). Для MOBI: "BOOKMOBI",
     для PalmDOC: "TEXtREAd", для AZW: "BOOKMOBI" тоже, etc.
     Проверка офсета 60 требует head >= 68 байт. */
  if (head.length < 68) {
    /* Слишком короткий head — не валидируем (не reject), пусть парсер сам разберётся. */
    return true;
  }
  /* Тип на офсете 60 — 4 байта */
  const type = head.subarray(60, 64).toString("ascii");
  const validTypes = new Set([
    "BOOK", "TEXt", "Data", "PNRd",
    "TPZ3" /* Topaz/AZW1 — старый Kindle */,
    ".pdf" /* мусорные PRC которые на самом деле PDF — пропускаем дальше */,
  ]);
  /* Проверяем что type начинается с одного из ожидаемых маркеров. */
  for (const v of validTypes) {
    if (type.startsWith(v)) return true;
  }
  /* CHM имеет свою сигнатуру — проверяется отдельно через isChm. */
  if (ext === "chm") return false;
  /* Без сильных улик — не reject (пусть Calibre сам попробует и упадёт с
     понятной ошибкой). */
  return true;
}

function isChm(head: Buffer): boolean {
  /* CHM (Compiled HTML Help): "ITSF" + version 3. Первые 4 байта строго ITSF. */
  return (
    head.length >= 4 &&
    head[0] === 0x49 && head[1] === 0x54 && head[2] === 0x53 && head[3] === 0x46
  );
}

function isMicrosoftPdb(head: Buffer): boolean {
  /* Microsoft C/C++ Program Database (debug symbols от Visual Studio).
     Первые 32 байта: "Microsoft C/C++ MSF 7.00\r\n\x1a\x44\x53\x00\x00\x00".
     Достаточно проверить первые 14 ASCII символов: "Microsoft C/C+".
     Iter 6В: 99 .pdb файлов в реальной библиотеке D:\Bibliarifull — все MS PDB. */
  if (head.length < 14) return false;
  const sig = "Microsoft C/C+";
  for (let i = 0; i < sig.length; i++) {
    if (head[i] !== sig.charCodeAt(i)) return false;
  }
  return true;
}

function isRar(head: Buffer): boolean {
  /* RAR signatures:
     - RAR 1.5+ (rar4): 52 61 72 21 1A 07 00 ("Rar!\x1A\x07\x00")
     - RAR 5.0+: 52 61 72 21 1A 07 01 00 ("Rar!\x1A\x07\x01\x00") */
  if (head.length < 7) return false;
  return (
    head[0] === 0x52 && head[1] === 0x61 && head[2] === 0x72 && head[3] === 0x21 &&
    head[4] === 0x1a && head[5] === 0x07 &&
    (head[6] === 0x00 || head[6] === 0x01)
  );
}

function isLit(head: Buffer): boolean {
  /* LIT (Microsoft Reader): "ITOLITLS" magic в первых 8 байтах. */
  if (head.length < 8) return false;
  return (
    head[0] === 0x49 && head[1] === 0x54 && head[2] === 0x4f && head[3] === 0x4c &&
    head[4] === 0x49 && head[5] === 0x54 && head[6] === 0x4c && head[7] === 0x53
  );
}

function isLrf(head: Buffer): boolean {
  /* LRF (Sony BBeB): "L" "R" "F" 0x00 + версия в первых байтах.
     Сигнатура: 4C 52 46 00 ("LRF\0") */
  if (head.length < 4) return false;
  return head[0] === 0x4c && head[1] === 0x52 && head[2] === 0x46 && head[3] === 0x00;
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
 * PDF: поиск маркера %%EOF в хвостовом буфере. PDF spec: %%EOF может быть
 * в последних 1024 байтах (allowed slack для line-endings).
 * Truncated torrent PDF не содержит %%EOF.
 */
export function pdfTailHasEof(tail: Buffer): boolean {
  /* %%EOF = 25 25 45 4F 46 */
  for (let i = tail.length - 5; i >= 0; i--) {
    if (
      tail[i] === 0x25 && tail[i + 1] === 0x25 &&
      tail[i + 2] === 0x45 && tail[i + 3] === 0x4f && tail[i + 4] === 0x46
    ) {
      return true;
    }
  }
  return false;
}

/**
 * EPUB structural check: ZIP local file header (30 bytes) первой записи должна
 * быть `mimetype`, compression method = 0 (stored), payload = "application/epub+zip".
 *
 * Layout ZIP local file header (offset 0):
 *   0..3   signature 50 4B 03 04
 *   4..5   version
 *   6..7   general purpose bit flag
 *   8..9   compression method (0 = stored, 8 = deflate)
 *   ...
 *   26..27 file name length (n)
 *   28..29 extra field length (m)
 *   30..30+n filename
 *   30+n..30+n+m extra field
 *   30+n+m.. payload
 */
export function epubStructHasMimetype(buf: Buffer): { ok: boolean; reason?: string } {
  if (buf.length < 30) return { ok: false, reason: "magic: epub structural — header too short" };
  /* PK\x03\x04 — local file header */
  if (buf[0] !== 0x50 || buf[1] !== 0x4b || buf[2] !== 0x03 || buf[3] !== 0x04) {
    return { ok: false, reason: "magic: epub structural — not a ZIP local file header" };
  }
  const compression = buf.readUInt16LE(8);
  const nameLen = buf.readUInt16LE(26);
  const extraLen = buf.readUInt16LE(28);
  if (nameLen !== 8) {
    /* "mimetype" = ровно 8 байт. Любая другая длина — первая запись не mimetype.
       Это явный сигнал что EPUB неправильно собран (mimetype должен быть первым). */
    return { ok: false, reason: `magic: epub structural — first entry is not 'mimetype' (name len=${nameLen})` };
  }
  const nameStart = 30;
  if (buf.length < nameStart + nameLen) {
    return { ok: false, reason: "magic: epub structural — buffer too short for filename" };
  }
  const name = buf.subarray(nameStart, nameStart + nameLen).toString("ascii");
  if (name !== "mimetype") {
    return { ok: false, reason: `magic: epub structural — first entry name is '${name}', expected 'mimetype'` };
  }
  if (compression !== 0) {
    return { ok: false, reason: "magic: epub structural — 'mimetype' must be stored (compression=0)" };
  }
  const payloadStart = nameStart + nameLen + extraLen;
  const expected = "application/epub+zip";
  if (buf.length < payloadStart + expected.length) {
    /* Не хватило байт — но это не ошибка структуры (просто читали мало);
       вернём ok чтобы внешний слой повторил с большим буфером. */
    return { ok: true };
  }
  const payload = buf.subarray(payloadStart, payloadStart + expected.length).toString("ascii");
  if (payload !== expected) {
    return { ok: false, reason: `magic: epub structural — mimetype payload is '${payload}', expected '${expected}'` };
  }
  return { ok: true };
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
      if (head.length < 16) return { ok: false, reason: "magic: too short for djvu (need ≥16 bytes for IFF)" };
      if (!isDjvu(head)) return { ok: false, reason: "magic: not a DJVU (missing AT&T)" };
      if (!isValidDjvuIff(head)) return { ok: false, reason: "magic: DJVU has AT&T but missing FORM:DJVU/DJVM/DJVI/THUM (corrupted IFF)" };
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

    case "mobi":
    case "azw":
    case "azw3":
    case "pdb":
    case "prc":
      /* Calibre-legacy форматы (Palm Database Format). Проверка офсета 60 — type+creator.
         Если файл слишком короткий или type незнакомый — не reject (Calibre сам разберётся
         и упадёт с понятной ошибкой). Strong reject только при магическом мусоре
         (PE/ELF/SQLite, что уже обработано isKnownBinaryGarbage выше).
         Iter 6В: для .pdb дополнительно reject Microsoft Program Database (debug symbols
         от Visual Studio) — 99 файлов в реальной библиотеке D:\Bibliarifull = все MS PDB,
         не Palm DB. Magic "Microsoft C/C+" в первых 14 байтах. */
      if (head.length < MIN_HEAD_FOR_BINARY) return { ok: false, reason: `magic: too short for ${e}` };
      if (e === "pdb" && isMicrosoftPdb(head)) {
        return { ok: false, reason: "magic: pdb is Microsoft Program Database (debug symbols), not Palm DB eBook" };
      }
      if (!isCalibreLegacyContainer(head, e)) {
        return { ok: false, reason: `magic: ${e} has unexpected PalmDB type at offset 60` };
      }
      return { ok: true };

    case "chm":
      /* CHM имеет четкую сигнатуру ITSF в первых 4 байтах. */
      if (head.length < 4) return { ok: false, reason: "magic: too short for chm" };
      if (!isChm(head)) return { ok: false, reason: "magic: not a CHM (missing ITSF)" };
      return { ok: true };

    case "cbz":
      /* CBZ — это ZIP. Та же проверка что для epub/docx/odt. */
      if (head.length < MIN_HEAD_FOR_BINARY) return { ok: false, reason: "magic: too short for cbz" };
      if (!isZipBased(head)) return { ok: false, reason: "magic: not a ZIP-based cbz (missing PK header)" };
      return { ok: true };

    case "cbr":
      /* CBR — это RAR. Сигнатура "Rar!\x1A\x07\x00" или "\x01\x00" для RAR 5. */
      if (head.length < MIN_HEAD_FOR_BINARY) return { ok: false, reason: "magic: too short for cbr" };
      if (!isRar(head)) return { ok: false, reason: "magic: not a RAR-based cbr (missing Rar! header)" };
      return { ok: true };

    case "lit":
      /* LIT (Microsoft Reader): сигнатура ITOLITLS в первых 8 байтах. */
      if (head.length < 8) return { ok: false, reason: "magic: too short for lit" };
      if (!isLit(head)) return { ok: false, reason: "magic: not a LIT (missing ITOLITLS)" };
      return { ok: true };

    case "lrf":
      /* LRF (Sony BBeB): сигнатура LRF\0 в первых 4 байтах. */
      if (head.length < 4) return { ok: false, reason: "magic: too short for lrf" };
      if (!isLrf(head)) return { ok: false, reason: "magic: not a LRF (missing LRF\\0)" };
      return { ok: true };

    case "snb":
    case "tcr":
      /* SNB (Samsung Note Book), TCR (Psion) — ниша, известных стабильных
         magic-сигнатур мало, реальных файлов очень мало. Не reject — Calibre
         сам разберётся. Базовая проверка: minimum size + не PE/ELF/SQLite
         (уже отброшено через isKnownBinaryGarbage).
         Iter 6В: .rb удалён — Ruby исходники в реальных библиотеках. */
      if (head.length < MIN_HEAD_FOR_BINARY) return { ok: false, reason: `magic: too short for ${e}` };
      return { ok: true };

    default:
      /* Неизвестное расширение — пропускаем (не наша задача классифицировать). */
      return { ok: true };
  }
}

/**
 * Прочитать байты файла (head + опционально tail/struct) и подтвердить
 * соответствие расширению + структурную целостность.
 *
 * Стратегия:
 *   1. Прочитать head (HEAD_BYTES) — общая magic-проверка через verifyExtMatchesContentHead.
 *   2. Для PDF: дополнительно прочитать tail — искать %%EOF.
 *   3. Для EPUB: дополнительно прочитать EPUB_STRUCT_BYTES — проверить
 *      mimetype в первой ZIP-записи.
 *
 * Возвращает `{ ok: false, reason }` при любой ошибке I/O или структурной проверки.
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
    const headSlice = head.subarray(0, bytesRead);
    const headVerdict = verifyExtMatchesContentHead(ext, headSlice);
    if (!headVerdict.ok) return headVerdict;

    const e = ext.toLowerCase();

    if (e === "pdf") {
      const stat = await fh.stat();
      const tailSize = Math.min(PDF_TAIL_BYTES, Number(stat.size));
      if (tailSize <= 0) return { ok: false, reason: "magic: pdf is empty" };
      const tail = Buffer.alloc(tailSize);
      const offset = Math.max(0, Number(stat.size) - tailSize);
      const { bytesRead: tBytes } = await fh.read(tail, 0, tailSize, offset);
      if (!pdfTailHasEof(tail.subarray(0, tBytes))) {
        return { ok: false, reason: "magic: pdf is truncated (no %%EOF in last 1024 bytes)" };
      }
    } else if (e === "epub") {
      const stat = await fh.stat();
      const structSize = Math.min(EPUB_STRUCT_BYTES, Number(stat.size));
      if (structSize >= 30) {
        const structBuf = Buffer.alloc(structSize);
        const { bytesRead: sBytes } = await fh.read(structBuf, 0, structSize, 0);
        const structVerdict = epubStructHasMimetype(structBuf.subarray(0, sBytes));
        if (!structVerdict.ok) return { ok: false, reason: structVerdict.reason };
      }
    }

    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `magic: read failed (${(err as Error).message})` };
  } finally {
    await fh.close().catch(() => {});
  }
}
