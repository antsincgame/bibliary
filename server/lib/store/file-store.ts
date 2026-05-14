import { mkdirSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { Database as DbType } from "better-sqlite3";

import { type Config, loadConfig } from "../../config.js";
import type { RawFileDoc, StorageLike, UploadableFile } from "../datastore.js";

/**
 * Solo-mode `Storage` shim — filesystem-backed, mimics the slice of
 * node-appwrite's `Storage` the server calls (`createFile`, `getFile`,
 * `getFileDownload`, `deleteFile`).
 *
 * Layout: `<BIBLIARY_DATA_DIR>/storage/<bucketId>/<fileId>` for the
 * bytes; file metadata (original name, size, mime) lives in the
 * `_solo_files` table of the solo SQLite db so `getFile` can answer
 * `.name` / `.sizeOriginal` without statting + guessing.
 *
 * The Appwrite path reads the whole file body into memory on download
 * (`getFileDownload` has no range support — see library/datasets.ts),
 * so the shim matching that all-in-memory contract is correct, not a
 * regression: `getFileDownload` returns a Buffer.
 */

/** Appwrite-shaped 404 so callers' `isStoreErrorCode(err, 404)` keeps working. */
function notFound(bucketId: string, fileId: string): Error & { code: number } {
  const err = new Error(
    `File with the requested ID could not be found (${bucketId}/${fileId}).`,
  ) as Error & { code: number; type: string };
  err.code = 404;
  err.type = "storage_file_not_found";
  return err;
}

/* bucketId comes from the BUCKETS constant (trusted) and fileId from
 * ID.unique() (hex). Validate anyway — these become path segments and
 * a stray "../" would be a traversal. */
const SAFE_SEGMENT = /^[a-zA-Z0-9_-]+$/;
function assertSafe(segment: string, label: string): void {
  if (!SAFE_SEGMENT.test(segment)) {
    throw new Error(`[solo-storage] unsafe ${label}: "${segment}"`);
  }
}

interface FileMetaRow {
  bucketId: string;
  fileId: string;
  name: string;
  size: number;
  mimeType: string | null;
  createdAt: string;
}

export class FileStore implements StorageLike {
  private readonly storageRoot: string;

  constructor(
    private readonly db: DbType,
    cfg: Config = loadConfig(),
  ) {
    this.storageRoot = resolve(cfg.BIBLIARY_DATA_DIR, "storage");
  }

  private bucketDir(bucketId: string): string {
    assertSafe(bucketId, "bucketId");
    const dir = join(this.storageRoot, bucketId);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  private filePath(bucketId: string, fileId: string): string {
    assertSafe(fileId, "fileId");
    return join(this.bucketDir(bucketId), fileId);
  }

  private toFileDoc(row: FileMetaRow): RawFileDoc {
    return {
      $id: row.fileId,
      bucketId: row.bucketId,
      name: row.name,
      sizeOriginal: row.size,
      mimeType: row.mimeType ?? "application/octet-stream",
      $createdAt: row.createdAt,
      $updatedAt: row.createdAt,
      $permissions: [],
      signature: "",
      chunksTotal: 1,
      chunksUploaded: 1,
    };
  }

  async createFile(
    bucketId: string,
    fileId: string,
    file: UploadableFile,
    _permissions?: string[],
  ): Promise<RawFileDoc> {
    const path = this.filePath(bucketId, fileId);
    const bytes = Buffer.from(await file.arrayBuffer());
    await writeFile(path, bytes);

    const row: FileMetaRow = {
      bucketId,
      fileId,
      name: file.name || `${fileId}.bin`,
      size: bytes.byteLength,
      mimeType: file.type || null,
      createdAt: new Date().toISOString(),
    };
    /* INSERT OR REPLACE: createFile against an existing id overwrites,
     * which is fine for solo mode — ids come from ID.unique(). */
    this.db
      .prepare(
        `INSERT OR REPLACE INTO "_solo_files"
           ("bucketId","fileId","name","size","mimeType","createdAt")
         VALUES (?,?,?,?,?,?)`,
      )
      .run(row.bucketId, row.fileId, row.name, row.size, row.mimeType, row.createdAt);

    return this.toFileDoc(row);
  }

  async getFile(bucketId: string, fileId: string): Promise<RawFileDoc> {
    const row = this.db
      .prepare(`SELECT * FROM "_solo_files" WHERE "bucketId" = ? AND "fileId" = ?`)
      .get(bucketId, fileId) as FileMetaRow | undefined;
    if (!row) throw notFound(bucketId, fileId);
    return this.toFileDoc(row);
  }

  async getFileDownload(bucketId: string, fileId: string): Promise<Buffer> {
    /* Require the metadata row first — keeps "file exists" authoritative
     * in one place (a stray byte file with no row is treated as absent). */
    const row = this.db
      .prepare(`SELECT 1 FROM "_solo_files" WHERE "bucketId" = ? AND "fileId" = ?`)
      .get(bucketId, fileId);
    if (!row) throw notFound(bucketId, fileId);
    try {
      return await readFile(this.filePath(bucketId, fileId));
    } catch (err) {
      if (err && typeof err === "object" && (err as { code?: string }).code === "ENOENT") {
        throw notFound(bucketId, fileId);
      }
      throw err;
    }
  }

  async deleteFile(bucketId: string, fileId: string): Promise<Record<string, never>> {
    const res = this.db
      .prepare(`DELETE FROM "_solo_files" WHERE "bucketId" = ? AND "fileId" = ?`)
      .run(bucketId, fileId);
    if (res.changes === 0) throw notFound(bucketId, fileId);
    /* force:true — tolerate the byte file already being gone; the
     * metadata row was the source of truth and it's now deleted. */
    await rm(this.filePath(bucketId, fileId), { force: true });
    return {};
  }
}
