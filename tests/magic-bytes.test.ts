/**
 * Magic-byte detection — единичные тесты для поддерживаемых форматов
 * + интеграционный тест classifier'а на «грязных» файлах без расширения.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";

import {
  detectByMagic,
  isLikelyText,
  classifyTextContent,
  KNOWN_FILENAMES_NO_EXT,
} from "../electron/lib/scanner/folder-bundle/magic-bytes.ts";
import { discoverBundle } from "../electron/lib/scanner/folder-bundle/classifier.ts";

/* ─── detectByMagic: книги ───────────────────────────────────────────── */

test("detectByMagic: PDF (%PDF) → book", () => {
  const buf = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
  assert.equal(detectByMagic(buf), "book");
});

test("detectByMagic: DjVu (AT&T) → book", () => {
  const buf = Buffer.from("AT&TFORM\0\0\0\0DJVU", "latin1");
  assert.equal(detectByMagic(buf), "book");
});

/* ─── detectByMagic: картинки ────────────────────────────────────────── */

test("detectByMagic: PNG header → image", () => {
  const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(detectByMagic(buf), "image");
});

test("detectByMagic: JPEG (FF D8 FF) → image", () => {
  const buf = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
  assert.equal(detectByMagic(buf), "image");
});

test("detectByMagic: GIF89 → image", () => {
  const buf = Buffer.from("GIF89a", "ascii");
  assert.equal(detectByMagic(buf), "image");
});

test("detectByMagic: BMP (BM) → image", () => {
  const buf = Buffer.from([0x42, 0x4d, 0x36, 0x00, 0x00, 0x00, 0x00, 0x00]);
  assert.equal(detectByMagic(buf), "image");
});

test("detectByMagic: TIFF (II*\\0) → image", () => {
  const buf = Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00]);
  assert.equal(detectByMagic(buf), "image");
});

test("detectByMagic: WebP (RIFF...WEBP) → image", () => {
  const buf = Buffer.concat([
    Buffer.from("RIFF"),
    Buffer.from([0x00, 0x00, 0x00, 0x00]),
    Buffer.from("WEBP"),
  ]);
  assert.equal(detectByMagic(buf), "image");
});

test("detectByMagic: SVG XML → image", () => {
  const buf = Buffer.from("<?xml version=\"1.0\"?>\n<svg xmlns=\"...", "utf8");
  assert.equal(detectByMagic(buf), "image");
});

test("detectByMagic: pure SVG → image", () => {
  const buf = Buffer.from("<svg width=\"100\">", "utf8");
  assert.equal(detectByMagic(buf), "image");
});

/* ─── ZIP/архивы ─────────────────────────────────────────────────────── */

test("detectByMagic: ZIP (PK\\x03\\x04) → archive", () => {
  const buf = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]);
  assert.equal(detectByMagic(buf), "archive");
});

test("detectByMagic: ELF binary → archive (skip)", () => {
  const buf = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]);
  assert.equal(detectByMagic(buf), "archive");
});

test("detectByMagic: PE/DOS exe (MZ) → archive (skip)", () => {
  const buf = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);
  assert.equal(detectByMagic(buf), "archive");
});

test("detectByMagic: Mach-O (CA FE BA BE) → archive (skip)", () => {
  const buf = Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0x00, 0x00, 0x00, 0x02]);
  assert.equal(detectByMagic(buf), "archive");
});

/* ─── Component Pascal / Oberon (real bibliarifull case) ────────────── */

test("detectByMagic: Component Pascal .ocf (FCOo) → archive (skip, BlackBox-only)", () => {
  /* Реальные magic bytes из D:\\Bibliarifull (BlackBox modules).
     BlackBox-binary бесполезен без runtime → отправляем в archive (skipped). */
  const buf = Buffer.from([0x46, 0x43, 0x4f, 0x6f, 0x0a, 0x00, 0x00, 0x00]);
  assert.equal(detectByMagic(buf), "archive");
});

test("detectByMagic: Component Pascal .odc (CDOo) → archive (skip)", () => {
  const buf = Buffer.from([0x43, 0x44, 0x4f, 0x6f, 0x00, 0x00, 0x00, 0x00]);
  assert.equal(detectByMagic(buf), "archive");
});

test("detectByMagic: Component Pascal .osf (FSOo) → archive (skip)", () => {
  const buf = Buffer.from([0x46, 0x53, 0x4f, 0x6f, 0x00, 0x01, 0x10, 0x41]);
  assert.equal(detectByMagic(buf), "archive");
});

/* ─── HTML без расширения ───────────────────────────────────────────── */

test("detectByMagic: <!DOCTYPE html> → html-site", () => {
  const buf = Buffer.from("<!DOCTYPE html>\n<html>", "utf8");
  assert.equal(detectByMagic(buf), "html-site");
});

test("detectByMagic: <html → html-site", () => {
  const buf = Buffer.from("<html><head><title>", "utf8");
  assert.equal(detectByMagic(buf), "html-site");
});

/* ─── Не-сигнатурный текст возвращает null ─────────────────────────── */

test("detectByMagic: random ASCII (no magic) → null", () => {
  const buf = Buffer.from("Just some random text without markers");
  assert.equal(detectByMagic(buf), null);
});

test("detectByMagic: too short (<4 bytes) → null", () => {
  assert.equal(detectByMagic(Buffer.from([0x25])), null);
});

/* ─── isLikelyText ───────────────────────────────────────────────────── */

test("isLikelyText: ASCII printable text → text", () => {
  const buf = Buffer.from("Hello world\nThis is a text file with regular content.", "utf8");
  assert.equal(isLikelyText(buf), "text");
});

test("isLikelyText: UTF-16 BOM → text", () => {
  const buf = Buffer.from([0xff, 0xfe, 0x48, 0x00, 0x65, 0x00, 0x6c, 0x00]);
  assert.equal(isLikelyText(buf), "text");
});

test("isLikelyText: binary with NUL bytes → binary", () => {
  /* 5%+ NUL → binary */
  const buf = Buffer.alloc(100);
  for (let i = 0; i < 100; i++) buf[i] = i % 10 === 0 ? 0 : 0x41; /* 10% NUL */
  assert.equal(isLikelyText(buf), "binary");
});

test("isLikelyText: empty → text", () => {
  assert.equal(isLikelyText(Buffer.alloc(0)), "text");
});

/* ─── classifyTextContent ────────────────────────────────────────────── */

test("classifyTextContent: MIT License → metadata", () => {
  const buf = Buffer.from("MIT License\n\nCopyright (c) 2024 Authors\n\nPermission is hereby granted...", "utf8");
  assert.equal(classifyTextContent(buf), "metadata");
});

test("classifyTextContent: Dockerfile (FROM ubuntu) → code", () => {
  const buf = Buffer.from("FROM ubuntu:22.04\nRUN apt-get update", "utf8");
  assert.equal(classifyTextContent(buf), "code");
});

test("classifyTextContent: C #include → code", () => {
  const buf = Buffer.from("#include <stdio.h>\nint main() { return 0; }", "utf8");
  assert.equal(classifyTextContent(buf), "code");
});

test("classifyTextContent: Python import → code", () => {
  const buf = Buffer.from("from typing import List\nimport os\n\ndef main():", "utf8");
  assert.equal(classifyTextContent(buf), "code");
});

test("classifyTextContent: random prose → null", () => {
  const buf = Buffer.from("This is just a plain text file with no markers whatsoever.", "utf8");
  assert.equal(classifyTextContent(buf), null);
});

/* ─── KNOWN_FILENAMES_NO_EXT ─────────────────────────────────────────── */

test("KNOWN_FILENAMES_NO_EXT: includes LICENSE/Dockerfile/Makefile", () => {
  assert.equal(KNOWN_FILENAMES_NO_EXT["license"], "metadata");
  assert.equal(KNOWN_FILENAMES_NO_EXT["dockerfile"], "code");
  assert.equal(KNOWN_FILENAMES_NO_EXT["makefile"], "code");
});

/* ─── E2E: discoverBundle с реальными «грязными» файлами ─────────────── */

test("discoverBundle: PDF без расширения детектится как book", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "bundle-magic-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  /* Файл с magic %PDF, но без расширения */
  await writeFile(path.join(dir, "the_book"), Buffer.concat([
    Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a]), /* %PDF-1.7 */
    Buffer.alloc(64, 0x20), /* padding */
  ]));
  const b = await discoverBundle(dir);
  assert.ok(b.book, "book should be detected by magic bytes");
  assert.equal(b.book!.baseName, "the_book");
  assert.equal(b.book!.kind, "book");
});

test("discoverBundle: LICENSE → metadata, Dockerfile → code", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "bundle-noext-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, "main.pdf"), Buffer.concat([
    Buffer.from([0x25, 0x50, 0x44, 0x46]),
    Buffer.alloc(32),
  ]));
  await writeFile(path.join(dir, "LICENSE"), "MIT License\n\nCopyright (c) 2024");
  await writeFile(path.join(dir, "Dockerfile"), "FROM node:22\nWORKDIR /app");

  const b = await discoverBundle(dir);
  assert.equal(b.book?.relPath, "main.pdf");

  const license = b.sidecars.find((s) => s.baseName.toLowerCase() === "license");
  assert.ok(license, "LICENSE should be sidecar");
  assert.equal(license!.kind, "metadata", `LICENSE kind=${license!.kind}`);

  const dockerfile = b.sidecars.find((s) => s.baseName.toLowerCase() === "dockerfile");
  assert.ok(dockerfile, "Dockerfile should be sidecar");
  assert.equal(dockerfile!.kind, "code", `Dockerfile kind=${dockerfile!.kind}`);
});

test("discoverBundle: PNG image без расширения → image", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "bundle-png-noext-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, "main.pdf"), Buffer.from([0x25, 0x50, 0x44, 0x46]));
  /* PNG magic without .png extension */
  await writeFile(
    path.join(dir, "diagram"),
    Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]),
  );
  const b = await discoverBundle(dir);
  const diagram = b.sidecars.find((s) => s.baseName === "diagram");
  assert.ok(diagram, "diagram should be sidecar");
  assert.equal(diagram!.kind, "image");
});

test("discoverBundle: .ocf Component Pascal modules → archive (skipped, not unknown)", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "bundle-ocf-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, "lesson.pdf"), Buffer.from([0x25, 0x50, 0x44, 0x46]));
  await writeFile(
    path.join(dir, "S13.ocf"),
    Buffer.concat([Buffer.from([0x46, 0x43, 0x4f, 0x6f]), Buffer.alloc(64)]),
  );
  const b = await discoverBundle(dir);
  /* archive-файлы попадают в skipped, не sidecars — это намеренно. */
  const ocfSkipped = b.skipped.find((s) => s.ext === "ocf");
  assert.ok(ocfSkipped, `expected .ocf in skipped; got skipped=${b.skipped.length}, sidecars=${b.sidecars.length}`);
  assert.equal(ocfSkipped!.kind, "archive", `.ocf kind=${ocfSkipped!.kind}, expected archive (BlackBox binary)`);
});

test("discoverBundle: пустой файл не падает, остаётся unknown", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "bundle-empty-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, "main.pdf"), Buffer.from([0x25, 0x50, 0x44, 0x46]));
  await writeFile(path.join(dir, "empty.dat"), Buffer.alloc(0));
  const b = await discoverBundle(dir);
  const empty = b.sidecars.find((s) => s.baseName === "empty");
  assert.ok(empty);
  assert.equal(empty!.kind, "unknown", "empty file should remain unknown");
});

test("discoverBundle: вложенный _files/ с index.html → html-site", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "bundle-html-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, "main.pdf"), Buffer.from([0x25, 0x50, 0x44, 0x46]));
  const sub = path.join(dir, "examples_files");
  await mkdir(sub, { recursive: true });
  await writeFile(path.join(sub, "index.html"), "<html><body>example</body></html>");
  await writeFile(path.join(sub, "page2.html"), "<html>second</html>");
  const b = await discoverBundle(dir);
  const html = b.sidecars.filter((s) => s.kind === "html-site");
  assert.ok(html.length >= 1, `expected html-site sidecars; got: ${b.sidecars.map((s) => `${s.relPath}=${s.kind}`).join(", ")}`);
});
