import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "fs";
import * as path from "path";
import * as os from "os";
import {
  putBlob,
  getBlobPath,
  resolveAssetUrl,
  resolveBlobFromUrl,
  getBlobsRoot,
} from "../electron/lib/library/library-store.js";

let tmpRoot: string;

before(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bibliary-cas-test-"));
});

after(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("CAS library-store", () => {
  it("putBlob stores buffer and returns sha256 + assetUrl", async () => {
    const buf = Buffer.from("test image data 123");
    const ref = await putBlob(tmpRoot, buf, "image/png");

    assert.ok(ref.sha256.length === 64, `sha256 should be 64 hex chars: ${ref.sha256}`);
    assert.equal(ref.ext, "png");
    assert.ok(ref.assetUrl.startsWith("bibliary-asset://sha256/"), `assetUrl: ${ref.assetUrl}`);
    assert.ok(ref.absPath.includes(".blobs"), `absPath should contain .blobs: ${ref.absPath}`);

    const stored = await fs.readFile(ref.absPath);
    assert.deepEqual(stored, buf);
  });

  it("putBlob is idempotent — same buffer produces same sha and no error", async () => {
    const buf = Buffer.from("dedup test content");
    const ref1 = await putBlob(tmpRoot, buf, "image/jpeg");
    const ref2 = await putBlob(tmpRoot, buf, "image/jpeg");

    assert.equal(ref1.sha256, ref2.sha256);
    assert.equal(ref1.absPath, ref2.absPath);
  });

  it("different content produces different sha", async () => {
    const ref1 = await putBlob(tmpRoot, Buffer.from("content-A"), "image/png");
    const ref2 = await putBlob(tmpRoot, Buffer.from("content-B"), "image/png");

    assert.notEqual(ref1.sha256, ref2.sha256);
  });

  it("getBlobPath blocks path traversal", () => {
    assert.throws(
      () => getBlobPath(tmpRoot, "../../../etc/passwd", "png"),
      /path traversal/,
    );
  });

  it("resolveAssetUrl formats correctly", () => {
    const url = resolveAssetUrl("abcdef1234567890".repeat(4));
    assert.ok(url.startsWith("bibliary-asset://sha256/"), `url: ${url}`);
  });

  it("resolveBlobFromUrl resolves stored blob", async () => {
    const buf = Buffer.from("resolve test data");
    const ref = await putBlob(tmpRoot, buf, "image/webp");

    const resolved = await resolveBlobFromUrl(tmpRoot, ref.assetUrl);
    assert.ok(resolved !== null, "should resolve");
    assert.equal(resolved, ref.absPath);
  });

  it("resolveBlobFromUrl returns null for unknown sha", async () => {
    const resolved = await resolveBlobFromUrl(
      tmpRoot,
      "bibliary-asset://sha256/" + "0".repeat(64),
    );
    assert.equal(resolved, null);
  });

  it("resolveBlobFromUrl returns null for invalid URL format", async () => {
    assert.equal(await resolveBlobFromUrl(tmpRoot, "https://example.com"), null);
    assert.equal(await resolveBlobFromUrl(tmpRoot, "bibliary-asset://sha256/short"), null);
  });

  it("getBlobsRoot points to .blobs under library root", () => {
    const root = getBlobsRoot("/some/path");
    assert.ok(root.endsWith(".blobs"), `root: ${root}`);
  });

  it("blob file is placed in 2-char subdirectory", async () => {
    const buf = Buffer.from("subdir test");
    const ref = await putBlob(tmpRoot, buf, "image/png");
    const parentDir = path.basename(path.dirname(ref.absPath));
    assert.equal(parentDir.length, 2, `subdirectory should be 2 chars: ${parentDir}`);
    assert.equal(parentDir, ref.sha256.slice(0, 2));
  });
});
