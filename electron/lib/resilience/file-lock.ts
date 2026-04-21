import { promises as fs } from "fs";
import * as path from "path";
import lockfile from "proper-lockfile";
import { LOCK_RETRIES, LOCK_STALE_MS } from "./constants";

export interface FileLockOptions {
  retries?: number;
  stale?: number;
}

/**
 * Cross-process exclusive lock на файл.
 * Гарантирует: UI ↔ CLI ↔ second-instance не разрушают друг другу данные.
 * Если файла-цели ещё нет — создаётся пустым (proper-lockfile требует существующий путь).
 *
 * stale: если процесс завис, через N мс lock автоматически отпускается (защита от deadlock).
 */
export async function withFileLock<T>(
  filePath: string,
  fn: () => Promise<T>,
  opts: FileLockOptions = {}
): Promise<T> {
  await ensureFileExists(filePath);

  const release = await lockfile.lock(filePath, {
    retries: opts.retries ?? LOCK_RETRIES,
    stale: opts.stale ?? LOCK_STALE_MS,
    realpath: false,
  });

  try {
    return await fn();
  } finally {
    await release().catch(() => undefined);
  }
}

async function ensureFileExists(filePath: string): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  try {
    await fs.access(filePath);
  } catch {
    const handle = await fs.open(filePath, "a");
    await handle.close();
  }
}
