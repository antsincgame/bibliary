/**
 * Walker partial-sibling probe — Иt 10 smart-routing.
 *
 * Проверяем что walker отбрасывает файлы, у которых рядом есть partial-маркер
 * (`.!ut`, `.crdownload`, `.part` etc.) — это индикатор недокачанного torrent
 * download, импорт такого файла гарантированно падает или даёт мусорные данные.
 *
 * Дополнительно проверяем, что отбраковывается ТОЛЬКО конкретный файл —
 * другие форматы той же книги в той же папке (если есть полный download)
 * проходят дальше нормально.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { walkSupportedFiles } from "../electron/lib/library/file-walker.ts";
import { SUPPORTED_BOOK_EXTS } from "../electron/lib/library/types.ts";

/** Make a 12 KB binary buffer to pass minBytes (10 KB) check. */
function pdfPayload(): Buffer {
  const head = Buffer.from("%PDF-1.7\n", "ascii");
  const body = Buffer.alloc(12 * 1024 - head.length, 0x20);
  return Buffer.concat([head, body]);
}

async function setupDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "walker-partial-"));
}

async function collect(dir: string, opts: Parameters<typeof walkSupportedFiles>[2]): Promise<string[]> {
  const out: string[] = [];
  for await (const f of walkSupportedFiles(dir, SUPPORTED_BOOK_EXTS, opts)) out.push(f);
  return out;
}

test("walker.partial-sibling: skips book.pdf when book.pdf.!ut exists", async () => {
  const dir = await setupDir();
  try {
    const bookPath = path.join(dir, "book.pdf");
    const utPath = bookPath + ".!ut";
    await writeFile(bookPath, pdfPayload());
    await writeFile(utPath, Buffer.alloc(1024));
    const skipped: Array<{ file: string; marker: string }> = [];
    const files = await collect(dir, {
      rejectPartialSiblings: true,
      onPartialReject: (file, marker) => skipped.push({ file, marker }),
    });
    assert.equal(files.length, 0, "book.pdf must be skipped due to .!ut sibling");
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0]!.marker, ".!ut");
    assert.match(skipped[0]!.file, /book\.pdf$/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("walker.partial-sibling: skips only the partial file, other formats pass", async () => {
  const dir = await setupDir();
  try {
    const pdfPath = path.join(dir, "book.pdf");
    const epubPath = path.join(dir, "book.epub");
    const utPath = pdfPath + ".!ut";
    await writeFile(pdfPath, pdfPayload());
    /* Valid EPUB ZIP local file header with mimetype entry */
    const epubHead = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x00, 0x00]),
      Buffer.alloc(16, 0),                                  // CRC + sizes
      Buffer.from([0x08, 0x00, 0x00, 0x00]),                // name len 8, extra 0
      Buffer.from("mimetype", "ascii"),
      Buffer.from("application/epub+zip", "ascii"),
    ]);
    const epubPayload = Buffer.concat([epubHead, Buffer.alloc(12 * 1024)]);
    await writeFile(epubPath, epubPayload);
    await writeFile(utPath, Buffer.alloc(1024));
    const skipped: string[] = [];
    const files = await collect(dir, {
      rejectPartialSiblings: true,
      onPartialReject: (file) => skipped.push(file),
    });
    /* book.pdf отбракован (есть .!ut), book.epub проходит (нет .!ut) */
    assert.equal(skipped.length, 1);
    assert.match(skipped[0]!, /book\.pdf$/);
    assert.equal(files.length, 1);
    assert.match(files[0]!, /book\.epub$/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("walker.partial-sibling: detects .crdownload, .part, .partial, .aria2", async () => {
  const dir = await setupDir();
  try {
    const variants: Array<[string, string]> = [
      ["chrome.pdf", ".crdownload"],
      ["firefox.pdf", ".part"],
      ["generic.pdf", ".partial"],
      ["aria.pdf", ".aria2"],
      ["safari.pdf", ".download"],
      ["bitcomet.pdf", ".bc!"],
    ];
    for (const [name] of variants) {
      await writeFile(path.join(dir, name), pdfPayload());
    }
    for (const [name, suffix] of variants) {
      await writeFile(path.join(dir, name + suffix), Buffer.alloc(512));
    }
    const skipped: Array<{ file: string; marker: string }> = [];
    const files = await collect(dir, {
      rejectPartialSiblings: true,
      onPartialReject: (file, marker) => skipped.push({ file, marker }),
    });
    assert.equal(files.length, 0, "all files have partial siblings → all skipped");
    assert.equal(skipped.length, variants.length);
    const markers = skipped.map((s) => s.marker).sort();
    assert.deepEqual(markers, variants.map(([, m]) => m).sort());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("walker.partial-sibling: rejectPartialSiblings=false leaves files alone", async () => {
  const dir = await setupDir();
  try {
    const bookPath = path.join(dir, "book.pdf");
    await writeFile(bookPath, pdfPayload());
    await writeFile(bookPath + ".!ut", Buffer.alloc(512));
    const files = await collect(dir, { rejectPartialSiblings: false });
    /* default = false: walker не делает probe → файл проходит */
    assert.equal(files.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("walker.partial-sibling: nested folder also covered", async () => {
  const dir = await setupDir();
  try {
    const sub = path.join(dir, "Author - Book - 2024");
    await mkdir(sub, { recursive: true });
    const bookPath = path.join(sub, "main.djvu");
    /* DJVU IFF: AT&T + FORM + 4-byte size + DJVU + padding to 12 KB */
    const djvuHead = Buffer.concat([
      Buffer.from([0x41, 0x54, 0x26, 0x54]),
      Buffer.from([0x46, 0x4f, 0x52, 0x4d]),
      Buffer.from([0x00, 0x00, 0x10, 0x00]),
      Buffer.from("DJVU", "ascii"),
    ]);
    await writeFile(bookPath, Buffer.concat([djvuHead, Buffer.alloc(12 * 1024)]));
    await writeFile(bookPath + ".!ut", Buffer.alloc(64));
    const skipped: string[] = [];
    const files = await collect(dir, {
      rejectPartialSiblings: true,
      onPartialReject: (file) => skipped.push(file),
    });
    assert.equal(files.length, 0);
    assert.equal(skipped.length, 1);
    assert.match(skipped[0]!, /main\.djvu$/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
