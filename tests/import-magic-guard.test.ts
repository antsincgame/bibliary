/**
 * Magic-guard sanity checks: makes sure `verifyExtMatchesContent*` accepts
 * legitimate book heads and rejects renamed binaries / garbage masquerading
 * as books.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import {
  verifyExtMatchesContent,
  verifyExtMatchesContentHead,
} from "../electron/lib/library/import-magic-guard.ts";

function head(...bytes: number[]): Buffer {
  return Buffer.from(bytes);
}

test("verifyExtMatchesContentHead: accepts valid PDF magic", () => {
  const v = verifyExtMatchesContentHead("pdf", head(0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37));
  assert.equal(v.ok, true);
});

test("verifyExtMatchesContentHead: rejects PE/MZ renamed as .pdf", () => {
  const v = verifyExtMatchesContentHead("pdf", head(0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00));
  assert.equal(v.ok, false);
  assert.match(v.reason ?? "", /windows-executable/);
});

test("verifyExtMatchesContentHead: rejects ELF renamed as .epub", () => {
  const v = verifyExtMatchesContentHead("epub", head(0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00));
  assert.equal(v.ok, false);
  assert.match(v.reason ?? "", /elf-executable/);
});

test("verifyExtMatchesContentHead: rejects BlackBox .ocf masquerading as .pdf", () => {
  const v = verifyExtMatchesContentHead("pdf", head(0x46, 0x43, 0x4f, 0x6f, 0x00, 0x00, 0x00, 0x00));
  assert.equal(v.ok, false);
  assert.match(v.reason ?? "", /component-pascal/);
});

test("verifyExtMatchesContentHead: accepts ZIP-based EPUB", () => {
  const v = verifyExtMatchesContentHead("epub", head(0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00));
  assert.equal(v.ok, true);
});

test("verifyExtMatchesContentHead: rejects PDF labelled as .epub", () => {
  const v = verifyExtMatchesContentHead("epub", head(0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37));
  assert.equal(v.ok, false);
  assert.match(v.reason ?? "", /not a ZIP-based epub/);
});

test("verifyExtMatchesContentHead: accepts DJVU AT&T magic", () => {
  const v = verifyExtMatchesContentHead("djvu", head(0x41, 0x54, 0x26, 0x54, 0x46, 0x4f, 0x52, 0x4d));
  assert.equal(v.ok, true);
});

test("verifyExtMatchesContentHead: accepts OLE compound for .doc", () => {
  const v = verifyExtMatchesContentHead("doc", head(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1));
  assert.equal(v.ok, true);
});

test("verifyExtMatchesContentHead: rejects ZIP labelled as .doc", () => {
  const v = verifyExtMatchesContentHead("doc", head(0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00));
  assert.equal(v.ok, false);
});

test("verifyExtMatchesContentHead: accepts <?xml fb2", () => {
  const buf = Buffer.from("<?xml version=\"1.0\" encoding=\"utf-8\"?>", "utf8");
  const v = verifyExtMatchesContentHead("fb2", buf);
  assert.equal(v.ok, true);
});

test("verifyExtMatchesContentHead: accepts <FictionBook fb2 with BOM", () => {
  const buf = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from("<FictionBook xmlns=\"...\">", "utf8"),
  ]);
  const v = verifyExtMatchesContentHead("fb2", buf);
  assert.equal(v.ok, true);
});

test("verifyExtMatchesContentHead: rejects binary fb2", () => {
  const v = verifyExtMatchesContentHead("fb2", head(0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07));
  assert.equal(v.ok, false);
});

test("verifyExtMatchesContentHead: accepts {\\rtf for .rtf", () => {
  const buf = Buffer.from("{\\rtf1\\ansi", "utf8");
  const v = verifyExtMatchesContentHead("rtf", buf);
  assert.equal(v.ok, true);
});

test("verifyExtMatchesContentHead: rejects pdf header for .rtf", () => {
  const v = verifyExtMatchesContentHead("rtf", head(0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37));
  assert.equal(v.ok, false);
});

test("verifyExtMatchesContentHead: txt rejects binary", () => {
  const v = verifyExtMatchesContentHead("txt", head(0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00));
  assert.equal(v.ok, false);
});

test("verifyExtMatchesContentHead: html accepts plain text", () => {
  const buf = Buffer.from("<!doctype html><html><head>", "utf8");
  const v = verifyExtMatchesContentHead("html", buf);
  assert.equal(v.ok, true);
});

test("verifyExtMatchesContentHead: pdf rejected when too short", () => {
  const v = verifyExtMatchesContentHead("pdf", head(0x25, 0x50));
  assert.equal(v.ok, false);
});

test("verifyExtMatchesContentHead: unknown extension returns ok (not our job)", () => {
  const v = verifyExtMatchesContentHead("xyz", head(0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00));
  assert.equal(v.ok, true);
});

test("verifyExtMatchesContent: returns reason on missing file", async () => {
  const v = await verifyExtMatchesContent("/nope/does/not/exist.pdf", "pdf");
  assert.equal(v.ok, false);
  assert.match(v.reason ?? "", /cannot open/);
});

test("verifyExtMatchesContent: real PDF on disk passes", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "bibliary-magic-pdf-"));
  try {
    const f = path.join(dir, "fake.pdf");
    await writeFile(f, Buffer.from("%PDF-1.7\n%fake content for tests", "binary"));
    const v = await verifyExtMatchesContent(f, "pdf");
    assert.equal(v.ok, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("verifyExtMatchesContent: renamed exe on disk fails", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "bibliary-magic-exe-"));
  try {
    const f = path.join(dir, "renamed.pdf");
    /* Realistic-ish DOS stub */
    await writeFile(f, Buffer.from([
      0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00,
      0xff, 0xff, 0x00, 0x00, 0xb8, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ]));
    const v = await verifyExtMatchesContent(f, "pdf");
    assert.equal(v.ok, false);
    assert.match(v.reason ?? "", /windows-executable/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
