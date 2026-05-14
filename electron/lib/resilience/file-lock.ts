import { promises as fs } from "fs";
import * as path from "path";
import lockfile from "proper-lockfile";
import { LOCK_RETRIES, LOCK_STALE_MS } from "./constants.js";

export interface FileLockOptions {
  retries?: number;
  stale?: number;
}

/**
 * Process-wide defaults for withFileLock(). Values come from
 * preferences/store at boot via configureFileLockDefaults(). Per-call
 * `opts` always wins.
 */
const runtimeDefaults: Required<FileLockOptions> = {
  retries: LOCK_RETRIES,
  stale: LOCK_STALE_MS,
};

export function configureFileLockDefaults(partial: Partial<FileLockOptions>): void {
  if (typeof partial.retries === "number") runtimeDefaults.retries = partial.retries;
  if (typeof partial.stale === "number") runtimeDefaults.stale = partial.stale;
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
    retries: opts.retries ?? runtimeDefaults.retries,
    stale: opts.stale ?? runtimeDefaults.stale,
    realpath: false,
  });

  try {
    return await fn();
  } finally {
    await release().catch((err) => console.error("[file-lock/withLock] release Error:", err));
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
