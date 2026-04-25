import { promises as fs } from "fs";
import * as path from "path";
import { randomBytes } from "crypto";

/**
 * Атомарная запись JSON через tmp + rename.
 * На POSIX rename атомарен; на NTFS ReplaceFile — практически атомарен.
 * При kill -9 / SIGKILL / power-off файл либо старый, либо новый — никогда не повреждён.
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

  let written = false;
  try {
    await fs.writeFile(tmpPath, content, "utf8");
    written = true;
    await fs.rename(tmpPath, filePath);
  } catch (err) {
    if (written) {
      await fs.unlink(tmpPath).catch((err) => console.error("[atomic-write] unlink tmp Error:", err));
    }
    throw err;
  }
}
