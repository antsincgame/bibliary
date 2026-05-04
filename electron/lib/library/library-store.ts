/**
 * Content-Addressed Store (CAS) — хранит картинки и ассеты по SHA-256.
 *
 * Layout:  data/library/.blobs/{ab}/{abcdef…1234}.{ext}
 *
 * Гарантии:
 *   - Один и тот же Buffer → один файл, один sha256
 *   - Запись через .tmp + rename (атомарно)
 *   - Идемпотентно: повторный putBlob для того же содержимого — no-op
 *   - Запрещён выход за пределы .blobs/ (path traversal guard)
 */

import { promises as fs } from "fs";
import * as path from "path";
import { createHash, randomBytes } from "crypto";

const BLOBS_DIR = ".blobs";

const MIME_TO_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/tiff": "tiff",
  "image/bmp": "bmp",
  "application/pdf": "pdf",
  "application/octet-stream": "bin",
};

export interface BlobRef {
  sha256: string;
  absPath: string;
  ext: string;
  assetUrl: string;
}

function sha256hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function blobSubdir(sha: string): string {
  return sha.slice(0, 2);
}

function extFromMime(mimeType: string): string {
  return MIME_TO_EXT[mimeType] ?? "bin";
}

export function getBlobsRoot(libraryRoot: string): string {
  return path.join(libraryRoot, BLOBS_DIR);
}

export function getBlobPath(libraryRoot: string, sha256: string, ext: string): string {
  const sub = blobSubdir(sha256);
  const p = path.join(libraryRoot, BLOBS_DIR, sub, `${sha256}.${ext}`);
  const resolved = path.resolve(p);
  const blobsBase = path.resolve(path.join(libraryRoot, BLOBS_DIR));
  if (!resolved.startsWith(blobsBase)) {
    throw new Error(`path traversal blocked: ${resolved}`);
  }
  return resolved;
}

export function resolveAssetUrl(sha256: string): string {
  return `bibliary-asset://sha256/${sha256}`;
}

export async function putBlob(
  libraryRoot: string,
  buffer: Buffer,
  mimeType: string,
): Promise<BlobRef> {
  const sha = sha256hex(buffer);
  const ext = extFromMime(mimeType);
  const absPath = getBlobPath(libraryRoot, sha, ext);

  try {
    await fs.access(absPath);
    return { sha256: sha, absPath, ext, assetUrl: resolveAssetUrl(sha) };
  } catch {
    // not exists, write it
  }

  const dir = path.dirname(absPath);
  await fs.mkdir(dir, { recursive: true });

  /* C3 fix (2026-05-04, /imperor): добавляем PID + crypto-random чтобы
   * избежать коллизии когда параллельные импорты двух книг пишут blobs в
   * один и тот же тик (CAS-имя одинаковое только для идентичного контента,
   * но мы можем писать ИДЕНТИЧНУЮ обложку из двух книг одновременно). */
  const tmpPath = `${absPath}.tmp.${process.pid}.${Date.now()}.${randomBytes(8).toString("hex")}`;
  try {
    await fs.writeFile(tmpPath, buffer);
    await fs.rename(tmpPath, absPath);
  } catch (err) {
    try { await fs.unlink(tmpPath); } catch { /* ignore */ }
    throw err;
  }

  return { sha256: sha, absPath, ext, assetUrl: resolveAssetUrl(sha) };
}

export async function putFile(
  libraryRoot: string,
  absFilePath: string,
  mimeType: string,
): Promise<BlobRef> {
  const buffer = await fs.readFile(absFilePath);
  return putBlob(libraryRoot, buffer, mimeType);
}

export async function resolveBlobFromUrl(
  libraryRoot: string,
  assetUrl: string,
): Promise<string | null> {
  const prefix = "bibliary-asset://sha256/";
  if (!assetUrl.startsWith(prefix)) return null;
  const sha = assetUrl.slice(prefix.length);
  if (!/^[a-f0-9]{64}$/i.test(sha)) return null;

  const blobsBase = path.resolve(getBlobsRoot(libraryRoot));
  const sub = blobSubdir(sha);
  const dir = path.join(blobsBase, sub);

  try {
    const entries = await fs.readdir(dir);
    const match = entries.find((e) => e.startsWith(sha));
    if (match) {
      const resolved = path.resolve(path.join(dir, match));
      if (!resolved.startsWith(blobsBase)) return null;
      return resolved;
    }
  } catch {
    // dir doesn't exist
  }
  return null;
}
