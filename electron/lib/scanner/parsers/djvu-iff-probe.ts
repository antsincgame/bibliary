/**
 * Лёгкая in-process проверка DjVu — есть ли в файле текстовый OCR-слой.
 *
 * Парсит IFF-контейнер DjVu без spawn'а внешних утилит (нет накладных
 * расходов на CreateProcess + load DLL). Используется в preflight для
 * массовой классификации файлов: «text-bearing» vs «image-only scan».
 *
 * АЛГОРИТМ:
 *   1. Открываем файл, читаем первые 64 KB (хвоста не хватает — для DjVu
 *      bundled DIRM расположен в начале и содержит offsets всех страниц,
 *      но нам достаточно найти ХОТЬ ОДИН TXTa/TXTz chunk в этом окне).
 *   2. Проверяем magic bytes: `AT&TFORM`.
 *   3. Линейно сканируем chunk header'ы, ищем "TXTa" или "TXTz".
 *   4. Если попался FORM:DJVI или FORM:DJVU — рекурсивно сканируем внутри.
 *   5. Если нашли TXT* — hasTextLayer=true. Если IFF структура валидна, но
 *      TXT* нет в первых 64 KB — даём вердикт hasTextLayer=false (нижняя
 *      оценка: бывают редкие DjVu где TXT* запрятан после страниц 50+, но
 *      это <1% корпуса).
 *
 * ПОЧЕМУ 64 KB ДОСТАТОЧНО:
 *   В типичном bundled DjVu первые ~4-8 KB занимает FORM:DJVM + DIRM, а
 *   дальше идут компоненты страниц. Каждая страница (FORM:DJVU) начинается
 *   с INFO chunk, далее идёт INCL/Sjbz/BG44/FG44/ANTa/TXTa/TXTz. Если
 *   текстовый слой есть — он встречается в первой странице (или в DJVI
 *   shared resources), что укладывается в 64 KB с большим запасом.
 *
 * NOTE: эта проверка эвристическая для preflight. Финальное решение
 *   принимает parseDjvu() через runDjvutxt(). Probe только сужает «вилку»
 *   ожиданий пользователю до старта импорта.
 */

import { promises as fs } from "fs";

export interface DjvuProbeResult {
  /** Файл — валидный DjVu (magic bytes "AT&TFORM"). */
  valid: boolean;
  /** Найден TXTa или TXTz chunk в первых 64 KB. */
  hasTextLayer: boolean;
  /** Тип DjVu: multi-page (DJVM) или single-page (DJVU). null если invalid. */
  formType: "DJVM" | "DJVU" | null;
  /** Размер просканированного буфера. */
  scannedBytes: number;
  /** Полный размер файла (из fs.stat) — чтобы preflight не делал второй stat. */
  fileSize?: number;
  /** Если parseError — диагностика, что пошло не так. */
  parseError?: string;
}

const PROBE_WINDOW_BYTES = 64 * 1024;

export async function probeDjvuTextLayer(filePath: string): Promise<DjvuProbeResult> {
  const fh = await fs.open(filePath, "r");
  try {
    const stat = await fh.stat();
    const fileSize = stat.size;
    const toRead = Math.min(stat.size, PROBE_WINDOW_BYTES);
    if (toRead < 16) {
      return {
        valid: false,
        hasTextLayer: false,
        formType: null,
        scannedBytes: toRead,
        parseError: "file too small",
        fileSize,
      };
    }
    const buf = Buffer.alloc(toRead);
    const { bytesRead } = await fh.read(buf, 0, toRead, 0);
    const parsed = scanDjvuBuffer(buf.subarray(0, bytesRead));
    return { ...parsed, fileSize };
  } finally {
    await fh.close();
  }
}

/**
 * Синхронная версия — для сценариев когда буфер уже в памяти.
 * Используется тестами и для in-memory probing (например, после download).
 */
export function probeDjvuTextLayerSync(buffer: Buffer): DjvuProbeResult {
  return scanDjvuBuffer(buffer);
}

function scanDjvuBuffer(buf: Buffer): DjvuProbeResult {
  if (buf.length < 16) {
    return { valid: false, hasTextLayer: false, formType: null, scannedBytes: buf.length, parseError: "buffer too small" };
  }
  /* DjVu начинается с "AT&TFORM" (8 байт), затем 4 байта длины (BE), затем
     "DJVM" (multi-page) или "DJVU" (single-page). */
  if (buf.toString("ascii", 0, 4) !== "AT&T") {
    return { valid: false, hasTextLayer: false, formType: null, scannedBytes: buf.length, parseError: "missing AT&T magic" };
  }
  if (buf.toString("ascii", 4, 8) !== "FORM") {
    return { valid: false, hasTextLayer: false, formType: null, scannedBytes: buf.length, parseError: "missing FORM after AT&T" };
  }
  const topFormType = buf.toString("ascii", 12, 16);
  if (topFormType !== "DJVM" && topFormType !== "DJVU") {
    return {
      valid: false,
      hasTextLayer: false,
      formType: null,
      scannedBytes: buf.length,
      parseError: `unexpected top FORM type: ${topFormType}`,
    };
  }

  /* Линейный скан — ищем "TXTa" или "TXTz" как 4-byte ASCII в любом chunk
     header'е (или внутри FORM-вложенности). Самый дешёвый способ —
     просто прошагать буфер 4-byte "окнами" и сравнивать. False positives
     возможны если "TXTa" появится случайно в JB2/IW44 данных — но это
     крайне маловероятно (4 байта ASCII букв в случайной зоне ≈ 1 на
     многие гигабайты). */
  const formType: "DJVM" | "DJVU" = topFormType;
  const hasTextLayer = scanForTxtChunk(buf);

  return {
    valid: true,
    hasTextLayer,
    formType,
    scannedBytes: buf.length,
  };
}

/**
 * Ищет 4-байтную сигнатуру TXTa или TXTz, выровненную по началу слова,
 * предположительно расположенную ВЫРОВНЕННО к границе chunk header'а.
 *
 * IFF chunks: 4-byte ID + 4-byte BE length + body, padded to even.
 * Идём от начала, парсим chunk-за-chunk-ом — это надёжнее чем raw search,
 * не даёт false positives внутри JB2/BZZ data.
 */
function scanForTxtChunk(buf: Buffer): boolean {
  /* Старт top-level FORM: 8 байт (AT&T) + FORM(4) + length(4) + type(4) = 16.
     Далее идут вложенные chunks. */
  return walkFormChildren(buf, 12, buf.length, 0);
}

const MAX_RECURSION_DEPTH = 8;

/**
 * Идёт по children внутри FORM chunk: после FORM id + length + 4-byte type
 * идут sub-chunks. Каждый sub-chunk: id(4) + length(4 BE) + body, padded.
 *
 * @param formStart — offset где начинается FORM-id (4 ASCII bytes "FORM")
 * @param parentEnd — exclusive конец area parent FORM
 */
function walkFormChildren(buf: Buffer, formStart: number, parentEnd: number, depth: number): boolean {
  if (depth > MAX_RECURSION_DEPTH) return false;
  if (formStart + 12 > parentEnd) return false;
  /* Skip FORM id(4) + length(4) + sub-type(4) = 12 */
  let offset = formStart + 12;
  while (offset + 8 <= parentEnd && offset + 8 <= buf.length) {
    const chunkId = buf.toString("ascii", offset, offset + 4);
    /* sanity: chunk id должен быть из ASCII printable. */
    if (!/^[A-Za-z0-9 &@]{4}$/.test(chunkId)) {
      return false;
    }
    const chunkLen = buf.readUInt32BE(offset + 4);
    if (chunkId === "TXTa" || chunkId === "TXTz") {
      return true;
    }
    if (chunkId === "FORM") {
      /* Вложенный FORM — рекурсивный обход. */
      const innerEnd = Math.min(parentEnd, offset + 8 + chunkLen + (chunkLen & 1));
      if (walkFormChildren(buf, offset, innerEnd, depth + 1)) return true;
    }
    /* Шагаем: id(4) + len(4) + body(chunkLen) + padding к чётному. */
    const advance = 8 + chunkLen + (chunkLen & 1);
    if (advance < 8 || advance > parentEnd - offset) return false;
    offset += advance;
  }
  return false;
}
