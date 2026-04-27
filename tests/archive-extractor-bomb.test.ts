/* Anti-zip-bomb hard limits: file count, total bytes, compression ratio. */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import JSZip from "jszip";
import {
  extractArchive,
  cleanupExtractedDir,
} from "../electron/lib/library/archive-extractor.ts";

interface SandboxState {
  dir: string;
  cleanup: () => Promise<void>;
}

async function makeSandbox(prefix: string): Promise<SandboxState> {
  const dir = await mkdtemp(path.join(os.tmpdir(), `bibliary-${prefix}-`));
  return {
    dir,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true }).catch((err) => console.error("[archive-extractor-bomb/cleanup] rm Error:", err));
    },
  };
}

const MIN_TXT = "Chapter 1\n\nA tiny but valid book for archive tests.\n";
/** Plain .txt inside zips must meet import-candidate MIN_TEXT_BYTES (10 KiB). */
function txtForZipCandidate(base: string): string {
  const need = 10240 - Buffer.byteLength(base, "utf8");
  return need > 0 ? `${base}\n${"x".repeat(need)}` : base;
}

test("zip with N files >= max gets refused with explanatory warning", async (t) => {
  const sb = await makeSandbox("zip-too-many-files");
  t.after(sb.cleanup);

  const prevMax = process.env.BIBLIARY_ARCHIVE_MAX_FILES;
  /* Понижаем лимит для теста — реальный default 5000 неудобен. */
  process.env.BIBLIARY_ARCHIVE_MAX_FILES = "3";
  t.after(() => {
    if (prevMax === undefined) delete process.env.BIBLIARY_ARCHIVE_MAX_FILES;
    else process.env.BIBLIARY_ARCHIVE_MAX_FILES = prevMax;
  });

  const zip = new JSZip();
  for (let i = 0; i < 5; i++) zip.file(`book-${i}.txt`, MIN_TXT);
  const buf = await zip.generateAsync({ type: "nodebuffer" });
  const archivePath = path.join(sb.dir, "many.zip");
  await writeFile(archivePath, buf);

  const r = await extractArchive(archivePath);
  t.after(() => cleanupExtractedDir(r.tempDir));
  assert.equal(r.books.length, 0, "zip-bomb defense must refuse all entries");
  assert.ok(
    r.warnings.some((w) => /\d+ files \(>3 limit\)|zip-bomb/.test(w)),
    `expected file-count warning, got: ${JSON.stringify(r.warnings)}`,
  );
});

test("zip with extreme compression ratio gets refused", async (t) => {
  const sb = await makeSandbox("zip-bomb-ratio");
  t.after(sb.cleanup);

  /* Сжимаем 1 МБ нулей в крошечный zip — ratio будет огромным. */
  const prevRatio = process.env.BIBLIARY_ARCHIVE_MAX_RATIO;
  process.env.BIBLIARY_ARCHIVE_MAX_RATIO = "20";
  t.after(() => {
    if (prevRatio === undefined) delete process.env.BIBLIARY_ARCHIVE_MAX_RATIO;
    else process.env.BIBLIARY_ARCHIVE_MAX_RATIO = prevRatio;
  });

  const zip = new JSZip();
  /* 1 MB нулей — в zip ужмётся в ~1 КБ (ratio ~1000:1). */
  zip.file("zeros.txt", Buffer.alloc(1024 * 1024, 0));
  const buf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 9 } });
  const archivePath = path.join(sb.dir, "bomb.zip");
  await writeFile(archivePath, buf);

  const r = await extractArchive(archivePath);
  t.after(() => cleanupExtractedDir(r.tempDir));
  assert.equal(r.books.length, 0);
  assert.ok(
    r.warnings.some((w) => /compression ratio.*limit|zip-bomb/.test(w)),
    `expected ratio warning, got: ${JSON.stringify(r.warnings)}`,
  );
});

test("zip with too large estimated extracted size gets refused", async (t) => {
  const sb = await makeSandbox("zip-too-large");
  t.after(sb.cleanup);

  const prevBytes = process.env.BIBLIARY_ARCHIVE_MAX_BYTES;
  /* Лимит 100 КБ для теста; помещаем 200 КБ контента в один файл. */
  process.env.BIBLIARY_ARCHIVE_MAX_BYTES = String(100 * 1024);
  t.after(() => {
    if (prevBytes === undefined) delete process.env.BIBLIARY_ARCHIVE_MAX_BYTES;
    else process.env.BIBLIARY_ARCHIVE_MAX_BYTES = prevBytes;
  });

  /* Чтобы избежать срабатывания ratio-check, делаем файл со СЛУЧАЙНЫМ
     контентом (несжимаемым) — ratio будет ~1:1. */
  const random = Buffer.alloc(200 * 1024);
  for (let i = 0; i < random.length; i++) random[i] = (Math.random() * 256) | 0;
  const zip = new JSZip();
  zip.file("big.txt", random);
  const buf = await zip.generateAsync({ type: "nodebuffer" });
  const archivePath = path.join(sb.dir, "huge.zip");
  await writeFile(archivePath, buf);

  const r = await extractArchive(archivePath);
  t.after(() => cleanupExtractedDir(r.tempDir));
  assert.equal(r.books.length, 0);
  assert.ok(
    r.warnings.some((w) => /would extract|aborted .* after extracting/.test(w)),
    `expected size-limit warning, got: ${JSON.stringify(r.warnings)}`,
  );
});

test("normal small zip with N supported books extracts all of them", async (t) => {
  const sb = await makeSandbox("zip-normal");
  t.after(sb.cleanup);

  const zip = new JSZip();
  zip.file("a.txt", txtForZipCandidate(MIN_TXT));
  zip.file("b.txt", txtForZipCandidate(MIN_TXT + "different"));
  zip.file("README.md", "non-book file ignored"); /* unsupported, должен skip */
  const buf = await zip.generateAsync({ type: "nodebuffer" });
  const archivePath = path.join(sb.dir, "normal.zip");
  await writeFile(archivePath, buf);

  const r = await extractArchive(archivePath);
  t.after(() => cleanupExtractedDir(r.tempDir));
  assert.equal(r.books.length, 2, `expected 2 books, got ${r.books.length}`);
  assert.equal(r.warnings.length, 0, `unexpected warnings: ${JSON.stringify(r.warnings)}`);
});

test("rar/cbr/7z return single warning, no books, do not throw", async (t) => {
  const sb = await makeSandbox("zip-unsupported-types");
  t.after(sb.cleanup);

  for (const ext of ["rar", "cbr", "7z"] as const) {
    const archivePath = path.join(sb.dir, `x.${ext}`);
    await writeFile(archivePath, "not really an archive");
    const r = await extractArchive(archivePath);
    t.after(() => cleanupExtractedDir(r.tempDir));
    assert.equal(r.books.length, 0);
    assert.ok(r.warnings.length >= 1);
  }
});
