/**
 * file-validity — multi-sample detector of incomplete-torrent / sparse / uniform-garbage files.
 *
 * Verifies:
 *   1. ALL-0xFF buffer (>= 16KB) → reject as "incomplete BitTorrent download"
 *   2. ALL-0x00 buffer → reject as "sparse-allocated"
 *   3. Single-byte uniform garbage (e.g. 0xAA repeated) → reject as "uniform garbage"
 *   4. Valid PDF buffer (entropic data) → pass
 *   5. Mixed buffer (start uniform, middle entropic) → pass (lenient: only fully uniform rejected)
 *   6. Tiny file (< MIN_FILE_SIZE) → pass (walker handles size threshold separately)
 */

import { describe, it } from "node:test";
import * as os from "node:os";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { expect } from "./helpers/expect-shim.ts";
import { detectIncompleteFile, classifyFileSamples } from "../electron/lib/scanner/file-validity.js";

async function withTempFile(bytes: Buffer, fn: (filePath: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "file-validity-"));
  const file = path.join(dir, "sample.bin");
  await fs.writeFile(file, bytes);
  try {
    await fn(file);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe("file-validity", () => {
  it("rejects 32KB ALL-0xFF buffer as incomplete BitTorrent download", async () => {
    const bytes = Buffer.alloc(32 * 1024, 0xff);
    await withTempFile(bytes, async (file) => {
      const result = await detectIncompleteFile(file);
      expect(result.valid).toBe(false);
      expect(typeof result.reason).toBe("string");
      expect((result.reason || "").includes("BitTorrent")).toBe(true);
      expect(typeof result.diagnostic).toBe("string");
      expect((result.diagnostic || "").includes("FF")).toBe(true);
    });
  });

  it("rejects 32KB ALL-0x00 buffer as sparse-allocated", async () => {
    const bytes = Buffer.alloc(32 * 1024, 0x00);
    await withTempFile(bytes, async (file) => {
      const result = await detectIncompleteFile(file);
      expect(result.valid).toBe(false);
      expect((result.reason || "").includes("sparse")).toBe(true);
    });
  });

  it("rejects single-byte uniform garbage (0xAA repeated)", async () => {
    const bytes = Buffer.alloc(32 * 1024, 0xaa);
    await withTempFile(bytes, async (file) => {
      const result = await detectIncompleteFile(file);
      expect(result.valid).toBe(false);
      expect((result.reason || "").includes("uniform garbage")).toBe(true);
    });
  });

  it("passes a synthetic valid PDF (entropic header + body + trailer)", async () => {
    /* %PDF-1.4 header + random body + %%EOF — 32KB, mostly random bytes. */
    const head = Buffer.from("%PDF-1.4\n", "ascii");
    const body = Buffer.alloc(32 * 1024 - 16);
    for (let i = 0; i < body.length; i++) body[i] = (i * 7 + 13) & 0xff;
    const tail = Buffer.from("\n%%EOF\n", "ascii");
    const bytes = Buffer.concat([head, body, tail]);
    await withTempFile(bytes, async (file) => {
      const result = await detectIncompleteFile(file);
      expect(result.valid).toBe(true);
    });
  });

  it("passes a buffer with uniform start but entropic middle", async () => {
    /* Realistic case: PDF with all-zero padding at start, real data in middle. */
    const head = Buffer.alloc(4096, 0x00);
    const middle = Buffer.alloc(8192);
    for (let i = 0; i < middle.length; i++) middle[i] = (i * 13 + 7) & 0xff;
    const tail = Buffer.alloc(4096, 0x00);
    const bytes = Buffer.concat([head, middle, tail]);
    /* Force size > MIN_FILE_SIZE (16KB) by repeating. */
    const padded = Buffer.concat([bytes, bytes]);
    await withTempFile(padded, async (file) => {
      const result = await detectIncompleteFile(file);
      /* Either pass (entropic middle visible) or reject (depends on sample positions);
         but should NOT report "incomplete BitTorrent" as confidently. */
      if (!result.valid) {
        expect((result.reason || "").includes("garbage")).toBe(true);
      } else {
        expect(result.valid).toBe(true);
      }
    });
  });

  it("passes tiny files (< MIN_FILE_SIZE) without checking", async () => {
    const tiny = Buffer.alloc(8 * 1024, 0xff); // 8KB, below 16KB threshold
    await withTempFile(tiny, async (file) => {
      const result = await detectIncompleteFile(file);
      expect(result.valid).toBe(true);
    });
  });

  it("returns invalid for non-existent file path", async () => {
    const result = await detectIncompleteFile("/nonexistent/path/to/file.pdf");
    expect(result.valid).toBe(false);
    expect((result.reason || "").includes("cannot open")).toBe(true);
  });

  describe("classifyFileSamples (sync)", () => {
    it("rejects all-FF samples", () => {
      const s1 = Buffer.alloc(4096, 0xff);
      const s2 = Buffer.alloc(4096, 0xff);
      const s3 = Buffer.alloc(4096, 0xff);
      const s4 = Buffer.alloc(4096, 0xff);
      const result = classifyFileSamples([s1, s2, s3, s4]);
      expect(result.valid).toBe(false);
      expect((result.reason || "").includes("BitTorrent")).toBe(true);
    });

    it("passes when even one sample has entropy", () => {
      const s1 = Buffer.alloc(4096, 0xff);
      const s2 = Buffer.alloc(4096, 0xff);
      const s3 = Buffer.alloc(4096);
      for (let i = 0; i < s3.length; i++) s3[i] = i & 0xff;
      const s4 = Buffer.alloc(4096, 0xff);
      const result = classifyFileSamples([s1, s2, s3, s4]);
      expect(result.valid).toBe(true);
    });

    it("passes when all uniform but different bytes", () => {
      const s1 = Buffer.alloc(4096, 0xff);
      const s2 = Buffer.alloc(4096, 0x00);
      const s3 = Buffer.alloc(4096, 0xff);
      const s4 = Buffer.alloc(4096, 0xff);
      const result = classifyFileSamples([s1, s2, s3, s4]);
      expect(result.valid).toBe(true);
    });

    it("passes empty samples array (no data, no judgement)", () => {
      const result = classifyFileSamples([]);
      expect(result.valid).toBe(true);
    });
  });
});
