/**
 * Vendored drop-in for node-appwrite's `InputFile` (was imported from
 * `"node-appwrite/file"`). Produces the `UploadableFile` shape the file
 * store consumes — `FileStore.createFile` (storage-shim.ts) reads
 * `.name`, `.type`, and `await .arrayBuffer()`.
 *
 * Both factories are synchronous: the originals were too, and the three
 * call sites use the result without `await`. `fromPath` defers the read
 * into `arrayBuffer()` — the file store buffers the whole body anyway,
 * so this matches the existing memory profile (nothing streamed across
 * that boundary even with the real SDK).
 */

import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

import type { UploadableFile } from "../datastore.js";

/** Copy into a fresh ArrayBuffer — `Buffer#buffer` is `ArrayBufferLike`
 *  (may be a SharedArrayBuffer slice); callers want a plain ArrayBuffer. */
function toArrayBuffer(buf: Buffer): ArrayBuffer {
  const ab = new ArrayBuffer(buf.byteLength);
  new Uint8Array(ab).set(buf);
  return ab;
}

export const InputFile = {
  fromBuffer(buffer: Buffer | Uint8Array, filename: string): UploadableFile {
    const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    return {
      name: filename,
      type: "",
      size: buf.byteLength,
      arrayBuffer: () => Promise.resolve(toArrayBuffer(buf)),
    };
  },
  fromPath(path: string, filename?: string): UploadableFile {
    return {
      name: filename ?? basename(path),
      type: "",
      size: statSync(path).size,
      arrayBuffer: async () => toArrayBuffer(await readFile(path)),
    };
  },
};
