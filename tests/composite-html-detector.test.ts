import { test } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { detectCompositeHtmlDir, assembleCompositeHtmlBook } from "../electron/lib/library/composite-html-detector.ts";

async function makeTempDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "bibliary-comp-html-"));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

const MINIMAL_HTML = (title: string, body: string) =>
  `<html><head><title>${title}</title></head><body>${body}</body></html>`;

test("composite-html-detector: less than 10 HTML files — returns null", async () => {
  const { dir, cleanup } = await makeTempDir();
  try {
    for (let i = 0; i < 9; i++) {
      await writeFile(path.join(dir, `page${i}.html`), MINIMAL_HTML(`Page ${i}`, `<p>Content ${i}</p>`));
    }
    const result = await detectCompositeHtmlDir(dir);
    assert.equal(result, null, "9 files should not trigger composite detection");
  } finally {
    await cleanup();
  }
});

test("composite-html-detector: exactly 10 HTML files — detected", async () => {
  const { dir, cleanup } = await makeTempDir();
  try {
    for (let i = 0; i < 10; i++) {
      await writeFile(path.join(dir, `c0${i}.html`), MINIMAL_HTML(`Chapter ${i}`, `<p>Text ${i}</p>`));
    }
    const result = await detectCompositeHtmlDir(dir);
    assert.notEqual(result, null, "10 files should be detected as composite");
    assert.equal(result!.files.length, 10);
  } finally {
    await cleanup();
  }
});

test("composite-html-detector: index.html detected as entry point", async () => {
  const { dir, cleanup } = await makeTempDir();
  try {
    const links = Array.from({ length: 15 }, (_, i) => `<a href="c${String(i).padStart(2,"0")}.html">Ch ${i}</a>`).join("\n");
    await writeFile(path.join(dir, "index.html"), MINIMAL_HTML("My Book", links));
    for (let i = 0; i < 15; i++) {
      await writeFile(path.join(dir, `c${String(i).padStart(2,"0")}.html`), MINIMAL_HTML(`Chapter ${i}`, `<p>Content ${i}</p>`));
    }
    const result = await detectCompositeHtmlDir(dir);
    assert.notEqual(result, null);
    assert.ok(result!.entryPoint?.endsWith("index.html"), "entry point should be index.html");
    assert.equal(result!.inferredTitle, "My Book", "title from index.html");
  } finally {
    await cleanup();
  }
});

test("composite-html-detector: entry point orders files from index links", async () => {
  const { dir, cleanup } = await makeTempDir();
  try {
    // Reversed order in index: c09 first, c00 last
    const links = Array.from({ length: 10 }, (_, i) => 9 - i)
      .map((i) => `<a href="c${String(i).padStart(2,"0")}.html">Ch ${i}</a>`)
      .join("\n");
    await writeFile(path.join(dir, "index.html"), MINIMAL_HTML("Reversed Book", links));
    for (let i = 0; i < 10; i++) {
      await writeFile(path.join(dir, `c${String(i).padStart(2,"0")}.html`), MINIMAL_HTML(`Chapter ${i}`, `<p>Para ${i}</p>`));
    }
    const result = await detectCompositeHtmlDir(dir);
    assert.notEqual(result, null);
    // Files should be ordered c09, c08, ... c00 as per index links
    const firstBasename = path.basename(result!.files[0]);
    assert.equal(firstBasename, "c09.html", `expected c09 first, got ${firstBasename}`);
  } finally {
    await cleanup();
  }
});

test("composite-html-detector: alphabetical order without index", async () => {
  const { dir, cleanup } = await makeTempDir();
  try {
    for (let i = 0; i < 12; i++) {
      const name = `c${String(i).padStart(2, "0")}.html`;
      await writeFile(path.join(dir, name), MINIMAL_HTML(`Chapter ${i}`, `<p>Para ${i}</p>`));
    }
    const result = await detectCompositeHtmlDir(dir);
    assert.notEqual(result, null);
    // No entry point — sorted alphabetically/naturally
    assert.equal(path.basename(result!.files[0]), "c00.html");
    assert.equal(path.basename(result!.files[11]), "c11.html");
  } finally {
    await cleanup();
  }
});

test("assembleCompositeHtmlBook: extracts sections and paragraphs", async () => {
  const { dir, cleanup } = await makeTempDir();
  try {
    const html1 = `<html><body><h2>Introduction</h2><p>First paragraph.</p><p>Second paragraph.</p></body></html>`;
    const html2 = `<html><body><h2>Main Chapter</h2><p>Main content here.</p></body></html>`;
    for (let i = 0; i < 10; i++) {
      const content = i === 0 ? html1 : i === 1 ? html2 : `<html><body><h2>Extra ${i}</h2><p>Text ${i}.</p></body></html>`;
      await writeFile(path.join(dir, `c${String(i).padStart(2,"0")}.html`), content);
    }
    const composite = await detectCompositeHtmlDir(dir);
    assert.notEqual(composite, null);
    const result = await assembleCompositeHtmlBook(composite!);
    assert.ok(result.sections.length >= 2, `expected ≥2 sections, got ${result.sections.length}`);
    assert.ok(result.rawCharCount > 0, "should have character count");
    const introSection = result.sections.find((s) => s.title === "Introduction");
    assert.ok(introSection, "should have Introduction section");
    assert.ok(introSection!.paragraphs.length >= 2, "Introduction should have ≥2 paragraphs");
  } finally {
    await cleanup();
  }
});

test("assembleCompositeHtmlBook: gracefully handles unreadable files", async () => {
  const { dir, cleanup } = await makeTempDir();
  try {
    for (let i = 0; i < 10; i++) {
      await writeFile(path.join(dir, `c${String(i).padStart(2,"0")}.html`), `<html><body><h2>Ch ${i}</h2><p>Para ${i}</p></body></html>`);
    }
    const composite = await detectCompositeHtmlDir(dir);
    assert.notEqual(composite, null);
    // Splice in a non-existent file
    composite!.files.push(path.join(dir, "nonexistent.html"));
    const result = await assembleCompositeHtmlBook(composite!);
    // Should still produce sections from the valid files
    assert.ok(result.sections.length >= 10);
    assert.ok(result.metadata.warnings.some((w) => w.includes("nonexistent.html")));
  } finally {
    await cleanup();
  }
});
