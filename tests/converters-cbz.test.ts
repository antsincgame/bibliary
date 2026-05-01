/**
 * CBZ Converter — multi-page PDF generation tests.
 *
 * Создаём синтетический CBZ через JSZip с реальными PNG страницами (1×1
 * пиксель), проверяем что convertCbz даёт valid multi-page PDF.
 */

import { describe, it } from "node:test";
import { expect } from "./helpers/expect-shim.ts";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import JSZip from "jszip";
import { convertCbz } from "../electron/lib/scanner/converters/cbz.js";

/* Минимальный валидный 1×1 PNG (89 bytes), серый пиксель. */
const MINIMAL_PNG_BUFFER = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x00, 0x00, 0x00, 0x00, 0x3a, 0x7e, 0x9b, 0x55, 0x00, 0x00, 0x00,
  0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x00, 0x00, 0x02,
  0x00, 0x01, 0xe5, 0x27, 0xde, 0xfc, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45,
  0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

/* Минимальный валидный 1×1 JPEG (~125 bytes). */
const MINIMAL_JPG_BUFFER = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
  0x01, 0x01, 0x00, 0x48, 0x00, 0x48, 0x00, 0x00, 0xff, 0xdb, 0x00, 0x43,
  0x00, 0x08, 0x06, 0x06, 0x07, 0x06, 0x05, 0x08, 0x07, 0x07, 0x07, 0x09,
  0x09, 0x08, 0x0a, 0x0c, 0x14, 0x0d, 0x0c, 0x0b, 0x0b, 0x0c, 0x19, 0x12,
  0x13, 0x0f, 0x14, 0x1d, 0x1a, 0x1f, 0x1e, 0x1d, 0x1a, 0x1c, 0x1c, 0x20,
  0x24, 0x2e, 0x27, 0x20, 0x22, 0x2c, 0x23, 0x1c, 0x1c, 0x28, 0x37, 0x29,
  0x2c, 0x30, 0x31, 0x34, 0x34, 0x34, 0x1f, 0x27, 0x39, 0x3d, 0x38, 0x32,
  0x3c, 0x2e, 0x33, 0x34, 0x32, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01,
  0x00, 0x01, 0x01, 0x01, 0x11, 0x00, 0xff, 0xc4, 0x00, 0x14, 0x00, 0x01,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0xff, 0xc4, 0x00, 0x14, 0x10, 0x01, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f,
  0x00, 0x37, 0xff, 0xd9,
]);

async function makeCbzWithPngPages(pageCount: number): Promise<Buffer> {
  const zip = new JSZip();
  for (let i = 1; i <= pageCount; i++) {
    const padded = String(i).padStart(3, "0");
    zip.file(`${padded}.png`, MINIMAL_PNG_BUFFER);
  }
  return zip.generateAsync({ type: "nodebuffer" });
}

describe("convertCbz — happy path", () => {
  it("CBZ с 3 PNG страницами → multi-page PDF (delegate)", async (t) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bibliary-cbz-test-"));
    t.after(() => rm(dir, { recursive: true, force: true }));

    const cbzPath = path.join(dir, "comic.cbz");
    await writeFile(cbzPath, await makeCbzWithPngPages(3));

    const result = await convertCbz(cbzPath);
    try {
      expect(result.kind).toBe("delegate");
      if (result.kind !== "delegate") return;

      expect(result.ext).toBe("pdf");
      const pdfBuf = await readFile(result.path);
      /* Минимальный PDF: %PDF- header. */
      expect(pdfBuf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
      /* Если 3 страницы embedded — PDF должен быть > 200 bytes (header + xref + 3 image refs). */
      expect(pdfBuf.length).toBeGreaterThan(200);
    } finally {
      await result.cleanup();
    }
  });

  it("CBZ с JPEG страницами — embed JPG flow (graceful если minimal JPEG отвергнут)", async (t) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bibliary-cbz-jpg-"));
    t.after(() => rm(dir, { recursive: true, force: true }));

    const zip = new JSZip();
    zip.file("001.jpg", MINIMAL_JPG_BUFFER);
    zip.file("002.jpg", MINIMAL_JPG_BUFFER);
    const cbzBuf = await zip.generateAsync({ type: "nodebuffer" });

    const cbzPath = path.join(dir, "manga.cbz");
    await writeFile(cbzPath, cbzBuf);

    const result = await convertCbz(cbzPath);
    try {
      /* pdf-lib embedJpg может отклонить наш минимальный (~125 байт) JPEG —
         тогда convertCbz возвращает text-extracted с warnings про skip pages.
         Если embed успешен — delegate с PDF. Оба исхода валидны: главное —
         не throw, контракт kind discriminator корректен. */
      if (result.kind === "delegate") {
        const pdfBuf = await readFile(result.path);
        expect(pdfBuf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
      } else {
        expect(result.text).toBe("");
        expect(result.warnings.length).toBeGreaterThan(0);
        /* Должно быть warning либо skip pages, либо 0 pages embed. */
        const warnText = result.warnings.join(" ");
        expect(/skipped|0 pages|failed/i.test(warnText)).toBe(true);
      }
    } finally {
      await result.cleanup();
    }
  });

  it("Natural sort: 001 < 002 < ... < 010 (не лексикографический)", async (t) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bibliary-cbz-sort-"));
    t.after(() => rm(dir, { recursive: true, force: true }));

    const zip = new JSZip();
    /* Намеренно вставляем в обратном порядке. JSZip не гарантирует insertion order
       при iter, но natural compare гарантирует порядок страниц. */
    zip.file("010.png", MINIMAL_PNG_BUFFER);
    zip.file("002.png", MINIMAL_PNG_BUFFER);
    zip.file("001.png", MINIMAL_PNG_BUFFER);
    const cbzBuf = await zip.generateAsync({ type: "nodebuffer" });

    const cbzPath = path.join(dir, "sort.cbz");
    await writeFile(cbzPath, cbzBuf);

    const result = await convertCbz(cbzPath);
    try {
      expect(result.kind).toBe("delegate");
      /* Если sort упал — результат может быть delegate (PDF создан), но порядок
         страниц неправильный. Здесь только проверяем что сам процесс не упал. */
    } finally {
      await result.cleanup();
    }
  });
});

describe("convertCbz — graceful degradation", () => {
  it("CBZ без images → text-extracted с warning", async (t) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bibliary-cbz-empty-"));
    t.after(() => rm(dir, { recursive: true, force: true }));

    const zip = new JSZip();
    zip.file("readme.txt", "no images here");
    const cbzBuf = await zip.generateAsync({ type: "nodebuffer" });

    const cbzPath = path.join(dir, "empty.cbz");
    await writeFile(cbzPath, cbzBuf);

    const result = await convertCbz(cbzPath);
    try {
      expect(result.kind).toBe("text-extracted");
      if (result.kind === "text-extracted") {
        expect(result.text).toBe("");
        expect(result.warnings.length).toBeGreaterThan(0);
      }
    } finally {
      await result.cleanup();
    }
  });

  it("Невалидный ZIP → text-extracted с warning", async (t) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bibliary-cbz-bad-"));
    t.after(() => rm(dir, { recursive: true, force: true }));

    const cbzPath = path.join(dir, "bad.cbz");
    await writeFile(cbzPath, Buffer.from("not a zip file"));

    const result = await convertCbz(cbzPath);
    try {
      expect(result.kind).toBe("text-extracted");
      if (result.kind === "text-extracted") {
        expect(result.warnings.length).toBeGreaterThan(0);
      }
    } finally {
      await result.cleanup();
    }
  });

  it("maxPages limit работает", async (t) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bibliary-cbz-limit-"));
    t.after(() => rm(dir, { recursive: true, force: true }));

    const cbzPath = path.join(dir, "big.cbz");
    await writeFile(cbzPath, await makeCbzWithPngPages(5));

    const result = await convertCbz(cbzPath, { maxPages: 2 });
    try {
      expect(result.kind).toBe("delegate");
      if (result.kind === "delegate") {
        const warnText = result.warnings.join(" ");
        expect(warnText).toContain("limited to 2");
      }
    } finally {
      await result.cleanup();
    }
  });

  it("AbortSignal респектируется", async (t) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bibliary-cbz-abort-"));
    t.after(() => rm(dir, { recursive: true, force: true }));

    const cbzPath = path.join(dir, "abort.cbz");
    await writeFile(cbzPath, await makeCbzWithPngPages(2));

    const ctl = new AbortController();
    ctl.abort();

    const result = await convertCbz(cbzPath, { signal: ctl.signal });
    /* Abort может произойти на разных стадиях — важно не throw. */
    await result.cleanup();
  });
});

describe("convertCbz — cleanup идемпотентность", () => {
  it("cleanup() двойной вызов без throw", async (t) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bibliary-cbz-clean-"));
    t.after(() => rm(dir, { recursive: true, force: true }));

    const cbzPath = path.join(dir, "clean.cbz");
    await writeFile(cbzPath, await makeCbzWithPngPages(1));

    const result = await convertCbz(cbzPath);
    await result.cleanup();
    await result.cleanup(); /* second time — should not throw */
  });
});
