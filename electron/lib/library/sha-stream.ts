/**
 * Streaming SHA-256 — обязательный контракт ingest-пайплайна.
 *
 * Книги бывают по 50–500 МБ (научные PDF, отсканированные тома). Если читать
 * их через `fs.readFile`/`readFileSync`, V8 heap наполняется одним массивом
 * байт и при пакетном импорте 10–50k книг неизбежен OOM. Поэтому весь
 * production-код считает SHA через `fs.createReadStream` с маленьким
 * highWaterMark — байты идут в `crypto.Hash` чанками и сразу освобождаются GC.
 *
 * Контракт:
 *   - Никогда не использовать `fs.readFile`/`readFileSync` для подсчёта SHA.
 *   - Поддержка отмены через AbortSignal — длинные книги можно остановить.
 *   - Возвращаемый id (`bookIdFromSha`) — стабилен на любой машине: два
 *     одинаковых файла на двух машинах получают один и тот же id.
 */

import { createReadStream } from "fs";
import { createHash } from "crypto";

/** Размер чанка чтения. 64 КБ — компромисс между syscalls и heap pressure. */
const READ_CHUNK_BYTES = 64 * 1024;

/** Длина хэша в hex-символах для slug папки книги. 16 hex = 64 бит ID. */
const BOOK_ID_HEX_LEN = 16;

/**
 * Считает SHA-256 содержимого файла потоково. Не читает файл целиком в память.
 *
 * @param absPath абсолютный путь к файлу.
 * @param signal опциональный AbortSignal — если abort'ится, поток уничтожается
 *   и promise reject'ится `Error("aborted")`.
 * @returns hex-строка из 64 символов (SHA-256).
 * @throws ошибка чтения файла или `Error("aborted")` если signal сработал.
 */
export function computeFileSha256(absPath: string, signal?: AbortSignal): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }

    const hash = createHash("sha256");
    const stream = createReadStream(absPath, { highWaterMark: READ_CHUNK_BYTES });

    let settled = false;
    const done = (err: Error | null, value?: string): void => {
      if (settled) return;
      settled = true;
      if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);
      if (err) reject(err);
      else resolve(value as string);
    };

    let abortHandler: (() => void) | null = null;
    if (signal) {
      abortHandler = (): void => {
        stream.destroy();
        done(new Error("aborted"));
      };
      signal.addEventListener("abort", abortHandler, { once: true });
    }

    stream.on("data", (chunk) => {
      hash.update(chunk);
    });
    stream.on("end", () => done(null, hash.digest("hex")));
    stream.on("error", (err) => done(err));
  });
}

/**
 * Slug книги = первые 16 hex SHA-256 от содержимого. 64 бит достаточно для
 * 50k записей: вероятность коллизии ~3e-15 (по rough birthday bound).
 *
 * Контракт стабильности: одинаковый файл → одинаковый bookId независимо от
 * машины, имени файла или папки. Это позволяет переносить `data/library/`
 * между машинами без переупорядочивания каталога.
 */
export function bookIdFromSha(sha256Hex: string): string {
  if (typeof sha256Hex !== "string" || sha256Hex.length < BOOK_ID_HEX_LEN) {
    throw new Error(`bookIdFromSha: invalid SHA "${sha256Hex}" (need >= ${BOOK_ID_HEX_LEN} hex chars)`);
  }
  return sha256Hex.slice(0, BOOK_ID_HEX_LEN).toLowerCase();
}
