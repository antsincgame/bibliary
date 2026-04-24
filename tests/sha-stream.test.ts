/* Streaming SHA-256 contract: matches in-memory hash, no OOM on big files, abort works. */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { computeFileSha256, bookIdFromSha } from "../electron/lib/library/sha-stream.ts";

test("computeFileSha256: hex matches in-memory crypto on small file", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "bibliary-sha-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const file = path.join(dir, "tiny.bin");
  const payload = Buffer.from("hello, bibliary streaming hasher!\n");
  await writeFile(file, payload);

  const expected = createHash("sha256").update(payload).digest("hex");
  const actual = await computeFileSha256(file);
  assert.equal(actual, expected);
  assert.equal(actual.length, 64);
});

test("computeFileSha256: matches in-memory crypto on multi-chunk file (5 MB, > 64 KB highWaterMark)", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "bibliary-sha-big-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  /* 5 MB полезной нагрузки гарантирует, что чтение пройдёт ~80 чанков по 64 КБ —
     этого достаточно чтобы убедиться: streaming-хэш математически равен
     одно-кусочному, и stream дочитывается до конца без потерь. */
  const file = path.join(dir, "big.bin");
  const chunk = Buffer.alloc(64 * 1024, 0x41); /* 64 KB ASCII 'A' */
  const totalChunks = 80; /* ровно 5 MiB */
  const fullPayload = Buffer.concat(Array.from({ length: totalChunks }, () => chunk));
  await writeFile(file, fullPayload);

  const expected = createHash("sha256").update(fullPayload).digest("hex");
  const actual = await computeFileSha256(file);
  assert.equal(actual, expected);
});

test("computeFileSha256: rejects with 'aborted' if signal is already aborted", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "bibliary-sha-abort-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const file = path.join(dir, "x.bin");
  await writeFile(file, "anything");

  const ctl = new AbortController();
  ctl.abort();
  await assert.rejects(
    () => computeFileSha256(file, ctl.signal),
    (err: Error) => err.message === "aborted",
  );
});

test("computeFileSha256: rejects on missing file with fs error", async () => {
  await assert.rejects(() => computeFileSha256("/__no_such_file__.bin"));
});

test("bookIdFromSha: lowercases and slices to 16 hex", () => {
  const sha = "AABBCCDDEEFF1122" + "0".repeat(48);
  assert.equal(bookIdFromSha(sha), "aabbccddeeff1122");
  assert.equal(bookIdFromSha(sha).length, 16);
});

test("bookIdFromSha: throws on too-short input", () => {
  assert.throws(() => bookIdFromSha("abc"));
  assert.throws(() => bookIdFromSha(""));
  // @ts-expect-error -- guarding runtime input
  assert.throws(() => bookIdFromSha(null));
});

test("bookIdFromSha: identical files yield identical id (cross-machine portability proxy)", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "bibliary-sha-stability-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const payload = Buffer.from("identical content, two different paths");
  const a = path.join(dir, "machine-A", "downloads", "book.pdf");
  const b = path.join(dir, "machine-B", "library", "book.pdf");
  await writeFile(a, payload, { flag: "w" }).catch(async () => {
    /* mkdtemp parent exists; create nested manually if needed */
  });
  /* На случай если writeFile не создал nested dirs — создадим их явно. */
  const { mkdir } = await import("node:fs/promises");
  await mkdir(path.dirname(a), { recursive: true });
  await mkdir(path.dirname(b), { recursive: true });
  await writeFile(a, payload);
  await writeFile(b, payload);

  const shaA = await computeFileSha256(a);
  const shaB = await computeFileSha256(b);
  assert.equal(shaA, shaB);
  assert.equal(bookIdFromSha(shaA), bookIdFromSha(shaB));
});
