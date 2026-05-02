import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import {
  detectImageMimeFromMagic,
  validateImageBuffer,
} from "../electron/lib/llm/image-preflight.ts";

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIG = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);

function pad(buf: Buffer, total: number): Buffer {
  const filler = Buffer.alloc(Math.max(0, total - buf.length), 0x00);
  return Buffer.concat([buf, filler]);
}

async function realPng(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 100, g: 150, b: 200 },
    },
  }).png().toBuffer();
}

test("detectImageMimeFromMagic: recognizes PNG by signature", () => {
  const buf = pad(PNG_SIG, 128);
  const verdict = detectImageMimeFromMagic(buf);
  assert.equal(verdict.ok, true);
  if (verdict.ok) assert.equal(verdict.mime, "image/png");
});

test("detectImageMimeFromMagic: recognizes JPEG by signature", () => {
  const buf = pad(JPEG_SIG, 256);
  const verdict = detectImageMimeFromMagic(buf);
  assert.equal(verdict.ok, true);
  if (verdict.ok) assert.equal(verdict.mime, "image/jpeg");
});

test("detectImageMimeFromMagic: recognizes WebP RIFF/WEBP layout", () => {
  const buf = Buffer.alloc(128);
  Buffer.from("RIFF").copy(buf, 0);
  Buffer.from("WEBP").copy(buf, 8);
  const verdict = detectImageMimeFromMagic(buf);
  assert.equal(verdict.ok, true);
  if (verdict.ok) assert.equal(verdict.mime, "image/webp");
});

test("detectImageMimeFromMagic: rejects empty buffer", () => {
  const verdict = detectImageMimeFromMagic(Buffer.alloc(0));
  assert.equal(verdict.ok, false);
  if (!verdict.ok) assert.match(verdict.reason, /empty/);
});

test("detectImageMimeFromMagic: rejects too-small buffer", () => {
  const verdict = detectImageMimeFromMagic(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  assert.equal(verdict.ok, false);
  if (!verdict.ok) assert.match(verdict.reason, /too small/);
});

test("detectImageMimeFromMagic: rejects unknown magic (PE executable disguised as PNG)", () => {
  const buf = Buffer.alloc(128);
  Buffer.from("MZ").copy(buf, 0);
  const verdict = detectImageMimeFromMagic(buf);
  assert.equal(verdict.ok, false);
  if (!verdict.ok) assert.match(verdict.reason, /unknown image format/);
});

test("validateImageBuffer: accepts a real 32x32 PNG generated via sharp", async () => {
  const buf = await realPng(32, 32);
  const verdict = await validateImageBuffer(buf);
  assert.equal(verdict.ok, true);
  if (verdict.ok) {
    assert.equal(verdict.mime, "image/png");
    assert.equal(verdict.width, 32);
    assert.equal(verdict.height, 32);
  }
});

test("validateImageBuffer: rejects a corrupt buffer (PNG header but garbage body)", async () => {
  const buf = Buffer.concat([PNG_SIG, Buffer.alloc(256, 0xff)]);
  const verdict = await validateImageBuffer(buf);
  assert.equal(verdict.ok, false);
  if (!verdict.ok) {
    assert.ok(
      /sharp|dimensions|too small/.test(verdict.reason),
      `unexpected reason: ${verdict.reason}`,
    );
  }
});

test("validateImageBuffer: rejects too-large buffer cap (12 MB)", async () => {
  const huge = Buffer.alloc(13 * 1024 * 1024, 0x89);
  PNG_SIG.copy(huge, 0);
  const verdict = await validateImageBuffer(huge);
  assert.equal(verdict.ok, false);
  if (!verdict.ok) assert.match(verdict.reason, /too large/);
});

test("validateImageBuffer: rejects 1x1 PNG (dimensions too small)", async () => {
  const buf = await realPng(1, 1);
  const verdict = await validateImageBuffer(buf);
  assert.equal(verdict.ok, false);
  if (!verdict.ok) assert.match(verdict.reason, /dimensions too small/);
});
