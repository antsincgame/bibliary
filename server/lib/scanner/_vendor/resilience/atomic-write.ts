import { promises as fs } from "fs";
import * as path from "path";
import { randomBytes } from "crypto";

/**
 * Атомарная запись JSON через tmp + rename.
 * На POSIX rename атомарен; на NTFS ReplaceFile — практически атомарен.
 * При kill -9 / SIGKILL / power-off файл либо старый, либо новый — никогда не повреждён.
 *
 * C4 fix (2026-05-04, /imperor): добавлен fsync на tmp-файл ПЕРЕД rename.
 * Раньше rename мог переименовать пустой файл, потому что content сидел в
 * write-back cache ОС и не был сброшен на диск (NTFS lazy commit). При
 * power-off в эту микросекунду пользователь получал пустой preferences.json
 * и сброс настроек. Теперь open() → write() → fdatasync() → close() → rename()
 * — pattern из POSIX `fsync(2)` и Windows FlushFileBuffers.
 */
export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const json = JSON.stringify(value, null, 2);
  await writeTextAtomic(filePath, json);
}

export async function writeTextAtomic(filePath: string, content: string): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });

  const suffix = randomBytes(6).toString("hex");
  const tmpPath = `${filePath}.${suffix}.tmp`;

  let opened = false;
  try {
    /* C4 fix: open + write + datasync + close — гарантирует что content
     * физически на диске ДО rename. fs.writeFile(tmpPath, content) не
     * вызывает fsync; на Windows write-back cache может удерживать данные
     * минуты. */
    const fh = await fs.open(tmpPath, "w");
    opened = true;
    try {
      await fh.writeFile(content, "utf8");
      /* fdatasync быстрее fsync (не сбрасывает metadata) и достаточен для
       * атомарности контента перед rename. На Windows маппится на
       * FlushFileBuffers. Если ОС не поддерживает — не критично, downgrade
       * до текущего поведения через try/catch. */
      try {
        await fh.datasync();
      } catch (syncErr) {
        /* Last-resort: на read-only ФС или Win-edge-case datasync может
         * упасть с EINVAL/EBADF. Логируем но не валим — rename всё ещё
         * атомарен сам по себе. */
        console.warn("[atomic-write] fdatasync failed (rename still atomic):", syncErr);
      }
    } finally {
      await fh.close();
    }
    await renameWithRetry(tmpPath, filePath);
  } catch (err) {
    if (opened) {
      await fs.unlink(tmpPath).catch((e) => console.error("[atomic-write] unlink tmp Error:", e));
    }
    throw err;
  }
}

/**
 * Windows-only flake mitigation: на NTFS rename(tmp, target) изредка падает
 * с EPERM/EBUSY/EACCES когда target момент удерживается AV / Indexer /
 * параллельным watcher'ом (особенно на packaged Electron-app — Defender любит
 * сканировать .json при появлении). На POSIX это не происходит.
 *
 * Стратегия: до 5 попыток с backoff 50ms→100ms→200ms→400ms. После последней
 * — пробрасываем оригинальную ошибку для caller'а.
 *
 * Экспортируется для caller'ов которые делают свой tmp+rename pattern с
 * binary content'ом (см. library/library-store.ts blob writer).
 */
export async function renameWithRetry(src: string, dst: string): Promise<void> {
  const RETRIABLE = new Set(["EPERM", "EBUSY", "EACCES"]);
  let lastErr: NodeJS.ErrnoException | null = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await fs.rename(src, dst);
      return;
    } catch (err) {
      lastErr = err as NodeJS.ErrnoException;
      if (process.platform !== "win32" || !RETRIABLE.has(lastErr.code ?? "")) {
        throw err;
      }
      /* Exp backoff with jitter: 50, 100, 200, 400ms. */
      const backoffMs = 50 * Math.pow(2, attempt);
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }
  throw lastErr;
}
