/* Streaming file walker: filters supported formats, recurses, respects abort. */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { walkSupportedFiles } from "../electron/lib/library/file-walker.ts";
import type { SupportedExt } from "../server/lib/scanner/parsers/index.ts";

const SUPPORTED: ReadonlySet<SupportedExt> = new Set(["pdf", "epub", "fb2", "txt", "docx"]);

async function setupFixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "bibliary-walker-test-"));
  await writeFile(path.join(root, "a.pdf"), "fake pdf");
  await writeFile(path.join(root, "b.epub"), "fake epub");
  await writeFile(path.join(root, "ignore.bin"), "binary");
  await writeFile(path.join(root, "archive.zip"), "PK\x03\x04");
  const sub = path.join(root, "nested", "deep");
  await mkdir(sub, { recursive: true });
  await writeFile(path.join(sub, "c.txt"), "hello world ".repeat(2000));
  await writeFile(path.join(sub, "d.unknown"), "skip me");
  return root;
}

test("walkSupportedFiles: yields supported files recursively, skips unknown", async (t) => {
  const root = await setupFixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  const found: string[] = [];
  for await (const file of walkSupportedFiles(root, SUPPORTED, { minFileBytes: 0 })) {
    found.push(path.relative(root, file).replace(/\\/g, "/"));
  }
  found.sort();
  assert.deepEqual(found, ["a.pdf", "b.epub", "nested/deep/c.txt"]);
});

test("walkSupportedFiles: includeArchives=true yields archive files", async (t) => {
  const root = await setupFixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  const found: string[] = [];
  for await (const file of walkSupportedFiles(root, SUPPORTED, { includeArchives: true, minFileBytes: 0 })) {
    found.push(path.relative(root, file).replace(/\\/g, "/"));
  }
  found.sort();
  assert.deepEqual(found, ["a.pdf", "archive.zip", "b.epub", "nested/deep/c.txt"]);
});

test("walkSupportedFiles: stops walking after signal abort", async (t) => {
  const root = await setupFixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  const ctl = new AbortController();
  ctl.abort();
  const found: string[] = [];
  for await (const file of walkSupportedFiles(root, SUPPORTED, { signal: ctl.signal })) {
    found.push(file);
  }
  assert.deepEqual(found, []);
});

test("walkSupportedFiles: handles unreadable directory silently", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bibliary-walker-empty-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const out: string[] = [];
  for await (const file of walkSupportedFiles(path.join(root, "does-not-exist"), SUPPORTED)) {
    out.push(file);
  }
  assert.deepEqual(out, []);
});

test("walkSupportedFiles: skips noisy pseudo-book paths inside corpus folders", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bibliary-walker-noise-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  await mkdir(path.join(root, "Forum_1426"), { recursive: true });
  await writeFile(path.join(root, "Forum_1426", "lesson.pdf"), "x".repeat(20_000));

  await mkdir(path.join(root, "Book A", "html"), { recursive: true });
  await writeFile(path.join(root, "Book A", "html", "chapter01.html"), "x".repeat(80_000));

  await mkdir(path.join(root, "Course", "assets"), { recursive: true });
  await writeFile(path.join(root, "Course", "assets", "notes.pdf"), "x".repeat(20_000));

  await writeFile(path.join(root, "valid-book.pdf"), "x".repeat(20_000));
  await writeFile(path.join(root, "valid-book.txt"), "x".repeat(40_000));

  const found: string[] = [];
  for await (const file of walkSupportedFiles(root, SUPPORTED, { minFileBytes: 0 })) {
    found.push(path.relative(root, file).replace(/\\/g, "/"));
  }
  found.sort();
  assert.deepEqual(found, ["valid-book.pdf", "valid-book.txt"]);
});
