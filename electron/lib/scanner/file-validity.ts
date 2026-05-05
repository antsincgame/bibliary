/**
 * File Validity — детектор заведомо мусорных файлов перед попыткой импорта.
 *
 * НЕ ПУТАТЬ с `import-magic-guard.ts` (тот строго требует `%PDF`/`AT&T`/etc).
 * Этот модуль — лояльный, ловит ТОЛЬКО заведомо мусорные файлы:
 *
 *   - **Incomplete BitTorrent download**: торрент-клиент пред-аллоцирует файл
 *     правильным размером, но недокачанные блоки заполнены sentinel-байтами
 *     (обычно 0xFF; иногда 0x00 на sparse NTFS).
 *   - **Sparse-allocated, never written**: файл создан с size > 0, но fs не
 *     записал данные (например после Crash во время копирования).
 *   - **Uniform garbage**: весь файл — повторение одного байта.
 *
 * Стратегия: multi-sample проверка из 4 точек (начало, 25%, 75%, конец) с
 * жёсткой логикой согласия — отбрасываем только когда ВСЕ 4 пробы говорят
 * «uniform», и значение одно и то же (FF/00/single-byte). False positive
 * на нестандартных PDF/DJVU исключён — нормальные книги имеют энтропию
 * выше 0 в любом куске тела.
 *
 * См. user Q1=A (Imperor 2026-05-05): «лояльно к %PDF/AT&T, строго к
 * 0xFF/0x00». См. также file-walker.ts + dead-import-purger.ts.
 */

import { promises as fs } from "fs";

/** Размер каждой пробы (первая, 25%, 75%, последняя). */
const SAMPLE_SIZE = 4096;
/** Минимальный размер файла для проверки (меньше — пропускаем, walker уже отрезал < 10KB). */
const MIN_FILE_SIZE = 16_384;
/** Максимум уникальных байт в "uniform" пробе. 1 = строгий single-byte; здесь даём
 *  немного простора для очень редких bit-flip в недокачанных блоках. */
const UNIFORM_UNIQUE_BYTES_THRESHOLD = 2;

export interface FileValidityResult {
  valid: boolean;
  /** Когда valid=false — причина для логов / warnings / UI. */
  reason?: string;
  /** Когда valid=false — диагностика для UI («первые байты: FF FF FF...»). */
  diagnostic?: string;
}

/**
 * Проверяет одну пробу: uniform или нет, и каким байтом заполнена.
 * Возвращает { uniform, byte } — uniform=true когда уникальных байт ≤ threshold.
 */
function classifySample(buf: Buffer): { uniform: boolean; byte: number } {
  if (buf.length === 0) return { uniform: true, byte: 0 };
  const seen = new Set<number>();
  for (const b of buf) {
    seen.add(b);
    if (seen.size > UNIFORM_UNIQUE_BYTES_THRESHOLD) {
      return { uniform: false, byte: -1 };
    }
  }
  /* Uniform: возвращаем первый байт как «доминирующий». */
  return { uniform: true, byte: buf[0]! };
}

/**
 * Multi-sample проверка файла на incomplete-torrent / uniform-garbage.
 *
 * Возвращает `valid: false` ТОЛЬКО когда все 4 пробы uniform И байт одинаковый
 * (0xFF, 0x00 или любой single byte). Любая нормальная книга имеет хотя бы один
 * non-uniform участок (PDF header, EPUB ZIP, DJVU IFF, текст и т.д.), даже если
 * сжат или зашифрован.
 *
 * Производительность: 4×4KB = 16KB чтения на файл. На SSD ~ 1ms на файл.
 */
export async function detectIncompleteFile(filePath: string): Promise<FileValidityResult> {
  let fh;
  try {
    fh = await fs.open(filePath, "r");
  } catch (err) {
    return {
      valid: false,
      reason: `file-validity: cannot open (${(err as Error).message})`,
    };
  }
  try {
    const stat = await fh.stat();
    const size = Number(stat.size);
    if (size < MIN_FILE_SIZE) {
      /* Слишком маленький — пропускаем (walker уже отрезает <10KB; здесь
         просто guard от пограничных случаев). Не reject. */
      return { valid: true };
    }

    /* 4 пробы: начало, 25%, 75%, конец. */
    const offsets: number[] = [
      0,
      Math.floor(size * 0.25),
      Math.floor(size * 0.75),
      Math.max(0, size - SAMPLE_SIZE),
    ];

    const samples: Array<{ uniform: boolean; byte: number }> = [];
    const buf = Buffer.alloc(SAMPLE_SIZE);
    for (const off of offsets) {
      const want = Math.min(SAMPLE_SIZE, size - off);
      if (want <= 0) continue;
      const { bytesRead } = await fh.read(buf, 0, want, off);
      if (bytesRead <= 0) continue;
      samples.push(classifySample(buf.subarray(0, bytesRead)));
    }

    if (samples.length === 0) {
      return { valid: false, reason: "file-validity: empty file" };
    }

    /* Reject ТОЛЬКО когда все пробы uniform и байт совпадает. */
    const allUniform = samples.every((s) => s.uniform);
    if (!allUniform) return { valid: true };

    const firstByte = samples[0]!.byte;
    const sameByte = samples.every((s) => s.byte === firstByte);
    if (!sameByte) {
      /* Все uniform, но разные байты — exotic, например padded archive с
         разными сегментами. Не reject — пусть парсер разбирается. */
      return { valid: true };
    }

    /* Жёсткое срабатывание: вся 4×4KB пробы заполнены одним и тем же байтом. */
    const hex = firstByte.toString(16).toUpperCase().padStart(2, "0");
    let kind: string;
    if (firstByte === 0xff) kind = "incomplete BitTorrent download (sentinel 0xFF)";
    else if (firstByte === 0x00) kind = "sparse-allocated, never written (sentinel 0x00)";
    else kind = `uniform garbage (single byte 0x${hex} repeated)`;

    /* Diagnostic для UI — первые 16 байт, как есть. */
    const diagBuf = Buffer.alloc(16);
    const { bytesRead: dBytes } = await fh.read(diagBuf, 0, 16, 0);
    const diagHex = Array.from(diagBuf.subarray(0, dBytes))
      .map((b) => b.toString(16).toUpperCase().padStart(2, "0"))
      .join(" ");

    return {
      valid: false,
      reason: `file-validity: ${kind}`,
      diagnostic: `First 16 bytes: ${diagHex}`,
    };
  } catch (err) {
    return {
      valid: false,
      reason: `file-validity: read failed (${(err as Error).message})`,
    };
  } finally {
    await fh.close().catch(() => {});
  }
}

/**
 * Sync-вариант для уже прочитанных байт (для тестов и для случая, когда head
 * прочитан другим этапом). Не делает I/O. Если samples=[] — считается valid
 * (отсутствие данных не повод reject; используй detectIncompleteFile для files).
 */
export function classifyFileSamples(samples: Buffer[]): FileValidityResult {
  if (samples.length === 0) return { valid: true };
  const classified = samples.map((s) => classifySample(s));
  const allUniform = classified.every((c) => c.uniform);
  if (!allUniform) return { valid: true };
  const firstByte = classified[0]!.byte;
  const sameByte = classified.every((c) => c.byte === firstByte);
  if (!sameByte) return { valid: true };
  const hex = firstByte.toString(16).toUpperCase().padStart(2, "0");
  let kind: string;
  if (firstByte === 0xff) kind = "incomplete BitTorrent download (sentinel 0xFF)";
  else if (firstByte === 0x00) kind = "sparse-allocated, never written (sentinel 0x00)";
  else kind = `uniform garbage (single byte 0x${hex} repeated)`;
  return { valid: false, reason: `file-validity: ${kind}` };
}
