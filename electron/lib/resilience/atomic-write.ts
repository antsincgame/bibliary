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
    await fs.rename(tmpPath, filePath);
  } catch (err) {
    if (opened) {
      await fs.unlink(tmpPath).catch((e) => console.error("[atomic-write] unlink tmp Error:", e));
    }
    throw err;
  }
}
