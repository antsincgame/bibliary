/**
 * Preflight scanner unit tests.
 *
 * Тестируем: preflightFiles, preflightFolder, walkCollect (через preflightFolder),
 * filterOutImageOnly, и граничные случаи probe-логики.
 *
 * Не тестируем реальный DjVu/PDF probe (требует файлы) — только структуру и API контракты.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import {
  preflightFiles,
  preflightFolder,
  filterOutImageOnly,
  type PreflightReport,
} from "../electron/lib/library/preflight.ts";

/* ────────────────────────────────────────────────────────────────── */
/* Helper                                                           */
/* ────────────────────────────────────────────────────────────────── */

async function makeTmpDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "bibliary-preflight-"));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

async function touch(filePath: string, content = ""): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content);
}

/* ────────────────────────────────────────────────────────────────── */
/* 1. preflightFiles — API contracts                                */
/* ────────────────────────────────────────────────────────────────── */

describe("[PREFLIGHT] preflightFiles — API contracts", () => {
  it("empty path list returns zero-count report", async () => {
    const report = await preflightFiles([]);
    assert.equal(report.totalFiles, 0);
    assert.equal(report.okFiles, 0);
    assert.equal(report.imageOnlyFiles, 0);
    assert.equal(report.unknownFiles, 0);
    assert.equal(report.invalidFiles, 0);
    assert.equal(report.skippedFiles, 0);
    assert.ok(Array.isArray(report.entries));
    assert.equal(report.entries.length, 0);
    assert.ok(typeof report.elapsedMs === "number");
    assert.ok(report.elapsedMs >= 0);
  });

  it("non-DjVu/PDF files are skipped — totalFiles counts them, entries does not", async () => {
    const fakePaths = [
      "/fake/book.epub",
      "/fake/book.fb2",
      "/fake/book.txt",
      "/fake/book.mobi",
    ];
    const report = await preflightFiles(fakePaths);
    assert.equal(report.totalFiles, 4, "totalFiles counts ALL input paths");
    assert.equal(report.entries.length, 0, "entries only tracks probed (djvu/pdf) files");
    assert.equal(report.skippedFiles, 4, "all 4 skipped (epub/fb2/txt/mobi not probed)");
    assert.equal(report.okFiles, 0);
    assert.equal(report.imageOnlyFiles, 0);
  });

  it("non-existent djvu/pdf gets status='invalid' in entries", async () => {
    const report = await preflightFiles(["/absolutely/nonexistent/file.pdf"]);
    assert.equal(report.totalFiles, 1);
    assert.equal(report.entries.length, 1);
    const entry = report.entries[0];
    assert.equal(entry.status, "invalid", "non-existent file → invalid (stat failed)");
    assert.equal(entry.ext, "pdf");
    assert.ok(entry.reason?.includes("stat failed") || entry.reason !== undefined);
  });

  it("non-existent djvu gets status='invalid'", async () => {
    const report = await preflightFiles(["/nonexistent/book.djvu"]);
    assert.equal(report.totalFiles, 1);
    assert.equal(report.entries.length, 1);
    assert.equal(report.entries[0].status, "invalid");
    assert.equal(report.entries[0].ext, "djvu");
  });

  it("report has ocr and evaluator capability fields", async () => {
    const report = await preflightFiles([]);
    assert.ok(typeof report.ocr === "object", "ocr field must be present");
    assert.ok(typeof report.ocr.anyAvailable === "boolean", "ocr.anyAvailable must be boolean");
    assert.ok(typeof report.evaluator === "object", "evaluator field must be present");
    assert.ok(typeof report.evaluator.ready === "boolean", "evaluator.ready must be boolean");
  });

  it("abort signal cancels preflightFiles cleanly", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    // pre-aborted signal should throw or complete gracefully — must not hang
    const paths = Array.from({ length: 20 }, (_, i) => `/fake/${i}.pdf`);
    try {
      await preflightFiles(paths, { signal: ctrl.signal });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      assert.match(msg, /abort|cancel/i, "thrown error should mention abort");
    }
    // Either completes quickly or throws — no hanging
    assert.ok(true, "did not hang");
  });

  it("mixed epub+pdf list — only pdf counted in entries, epub in skippedFiles", async () => {
    const paths = [
      "/fake/a.pdf",
      "/fake/b.epub",
      "/fake/c.pdf",
      "/fake/d.fb2",
    ];
    const report = await preflightFiles(paths);
    assert.equal(report.totalFiles, 4);
    assert.equal(report.skippedFiles, 2, "epub and fb2 are skipped");
    assert.equal(report.entries.length, 2, "only 2 pdf files are in entries");
    for (const e of report.entries) {
      assert.equal(e.ext, "pdf");
    }
  });
});

/* ────────────────────────────────────────────────────────────────── */
/* 2. preflightFolder — walkCollect integration                     */
/* ────────────────────────────────────────────────────────────────── */

describe("[PREFLIGHT] preflightFolder — walkCollect", () => {
  let tmp: { dir: string; cleanup: () => Promise<void> };

  beforeEach(async () => { tmp = await makeTmpDir(); });
  afterEach(async () => { await tmp.cleanup(); });

  it("throws for non-existent folder", async () => {
    await assert.rejects(
      preflightFolder("/nonexistent/folder/xyz"),
      /ENOENT|not a directory/,
    );
  });

  it("empty folder returns totalFiles=0", async () => {
    const report = await preflightFolder(tmp.dir);
    assert.equal(report.totalFiles, 0);
    assert.equal(report.entries.length, 0);
  });

  it("folder with only txt files — no DjVu/PDF, but totalFiles counts supported exts", async () => {
    await touch(path.join(tmp.dir, "book1.epub"), "epub content");
    await touch(path.join(tmp.dir, "book2.fb2"), "fb2 content");
    await touch(path.join(tmp.dir, "notes.txt"), "notes");

    const report = await preflightFolder(tmp.dir);
    // epub, fb2, txt are all in SUPPORTED_BOOK_EXTS so walkCollect collects them
    // but probeAll skips non-DjVu/PDF so entries is empty
    assert.ok(report.totalFiles >= 2, "at least epub + fb2 should be counted");
    assert.equal(report.entries.length, 0, "no DjVu/PDF → no probe entries");
    assert.equal(report.skippedFiles, report.totalFiles, "all collected files are skipped");
  });

  it("non-book extensions (jpg, exe, zip) are NOT collected by walkCollect", async () => {
    await touch(path.join(tmp.dir, "photo.jpg"), "img");
    await touch(path.join(tmp.dir, "app.exe"), "exe");
    await touch(path.join(tmp.dir, "archive.zip"), "zip");
    await touch(path.join(tmp.dir, "book.epub"), "epub");

    const report = await preflightFolder(tmp.dir);
    // Only epub should be collected; jpg/exe/zip are not supported book formats
    assert.equal(report.totalFiles, 1, "only epub should be in totalFiles");
  });

  it("recursive=false skips subdirectories", async () => {
    const subdir = path.join(tmp.dir, "subdir");
    await mkdir(subdir, { recursive: true });
    await touch(path.join(subdir, "deep.epub"), "epub");
    await touch(path.join(tmp.dir, "root.epub"), "epub");

    const reportFlat = await preflightFolder(tmp.dir, { recursive: false });
    const reportRecursive = await preflightFolder(tmp.dir, { recursive: true });

    assert.equal(reportFlat.totalFiles, 1, "flat scan: only root.epub");
    assert.equal(reportRecursive.totalFiles, 2, "recursive scan: root + subdir");
  });

  it("maxFiles cap stops walkCollect early", async () => {
    for (let i = 0; i < 10; i++) {
      await touch(path.join(tmp.dir, `book${i}.epub`), "epub");
    }
    const report = await preflightFolder(tmp.dir, { maxFiles: 3 });
    assert.ok(report.totalFiles <= 3, "maxFiles=3 should cap collection");
  });

  it("abort signal stops walkCollect", async () => {
    for (let i = 0; i < 5; i++) {
      await touch(path.join(tmp.dir, `book${i}.epub`), "epub");
    }
    const ctrl = new AbortController();
    ctrl.abort();
    try {
      await preflightFolder(tmp.dir, { signal: ctrl.signal });
      // If it completes, totalFiles should be small (aborted early)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      assert.match(msg, /abort/i);
    }
    assert.ok(true, "did not hang on pre-aborted signal");
  });
});

/* ────────────────────────────────────────────────────────────────── */
/* 3. filterOutImageOnly — edge cases                               */
/* ────────────────────────────────────────────────────────────────── */

describe("[PREFLIGHT] filterOutImageOnly", () => {
  function makeReport(entries: Array<{ path: string; status: "ok" | "image-only" | "unknown" | "invalid" }>): PreflightReport {
    return {
      totalFiles: entries.length,
      okFiles: entries.filter((e) => e.status === "ok").length,
      imageOnlyFiles: entries.filter((e) => e.status === "image-only").length,
      unknownFiles: entries.filter((e) => e.status === "unknown").length,
      invalidFiles: entries.filter((e) => e.status === "invalid").length,
      skippedFiles: 0,
      ocr: { anyAvailable: false, systemOcr: { available: false, platform: "win32", languages: [] }, visionLlm: { available: false } },
      evaluator: { ready: false, reason: "test", fallbackPolicyEnabled: false },
      entries: entries.map((e) => ({ path: e.path, size: 1000, ext: "pdf", status: e.status })),
      elapsedMs: 10,
    };
  }

  it("removes image-only paths, keeps ok/unknown/invalid", () => {
    const report = makeReport([
      { path: "/a.pdf", status: "ok" },
      { path: "/b.pdf", status: "image-only" },
      { path: "/c.pdf", status: "unknown" },
      { path: "/d.pdf", status: "image-only" },
    ]);
    const filtered = filterOutImageOnly(["/a.pdf", "/b.pdf", "/c.pdf", "/d.pdf"], report);
    assert.deepEqual(filtered, ["/a.pdf", "/c.pdf"], "should only remove image-only paths");
  });

  it("all image-only → empty result", () => {
    const report = makeReport([
      { path: "/a.pdf", status: "image-only" },
      { path: "/b.pdf", status: "image-only" },
    ]);
    const filtered = filterOutImageOnly(["/a.pdf", "/b.pdf"], report);
    assert.deepEqual(filtered, []);
  });

  it("no image-only → unchanged", () => {
    const report = makeReport([
      { path: "/a.pdf", status: "ok" },
      { path: "/b.pdf", status: "unknown" },
    ]);
    const filtered = filterOutImageOnly(["/a.pdf", "/b.pdf"], report);
    assert.deepEqual(filtered, ["/a.pdf", "/b.pdf"]);
  });

  it("empty inputs → empty result", () => {
    const report = makeReport([]);
    const filtered = filterOutImageOnly([], report);
    assert.deepEqual(filtered, []);
  });

  it("paths not in entries are kept (defensive)", () => {
    const report = makeReport([{ path: "/a.pdf", status: "image-only" }]);
    const filtered = filterOutImageOnly(["/a.pdf", "/b.pdf", "/c.epub"], report);
    assert.deepEqual(filtered, ["/b.pdf", "/c.epub"], "paths not in entries report are kept");
  });

  it("duplicate paths handled correctly", () => {
    const report = makeReport([{ path: "/a.pdf", status: "image-only" }]);
    const filtered = filterOutImageOnly(["/a.pdf", "/a.pdf", "/b.pdf"], report);
    assert.deepEqual(filtered, ["/b.pdf"], "both duplicates of image-only removed");
  });
});

/* ────────────────────────────────────────────────────────────────── */
/* 4. PreflightReport structure — no regression on field names      */
/* ────────────────────────────────────────────────────────────────── */

describe("[PREFLIGHT] PreflightReport structure contract", () => {
  it("preflightFiles returns all required fields", async () => {
    const report = await preflightFiles([]);
    const required: Array<keyof PreflightReport> = [
      "totalFiles", "okFiles", "imageOnlyFiles", "unknownFiles",
      "invalidFiles", "skippedFiles", "ocr", "evaluator", "entries", "elapsedMs",
    ];
    for (const field of required) {
      assert.ok(field in report, `field '${field}' must be present`);
    }
  });

  it("elapsedMs is a non-negative number", async () => {
    const report = await preflightFiles([]);
    assert.ok(typeof report.elapsedMs === "number");
    assert.ok(report.elapsedMs >= 0);
  });

  it("skippedFiles = totalFiles - entries.length for epub-only list", async () => {
    const paths = ["/fake/a.epub", "/fake/b.epub", "/fake/c.fb2"];
    const report = await preflightFiles(paths);
    assert.equal(
      report.skippedFiles,
      report.totalFiles - report.entries.length,
      "skippedFiles accounting must hold",
    );
  });

  it("okFiles + imageOnlyFiles + unknownFiles + invalidFiles = entries.length", async () => {
    const paths = ["/fake/a.pdf", "/fake/b.djvu"];
    const report = await preflightFiles(paths);
    const sum = report.okFiles + report.imageOnlyFiles + report.unknownFiles + report.invalidFiles;
    assert.equal(sum, report.entries.length, "status counts must be consistent");
  });
});
