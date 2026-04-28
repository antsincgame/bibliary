/* Folder-bundle: classifier + markdown-builder. */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { discoverBundle } from "../electron/lib/scanner/folder-bundle/classifier.ts";
import { buildBundleMarkdown } from "../electron/lib/scanner/folder-bundle/markdown-builder.ts";

async function setupBundle(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "bibliary-bundle-test-"));
  /* main book — самый большой PDF */
  await writeFile(path.join(root, "MainBook.pdf"), Buffer.alloc(50_000, 1));
  /* sidecar: маленький PDF (другая редакция) */
  await writeFile(path.join(root, "older-edition.pdf"), Buffer.alloc(5_000, 1));
  /* images */
  const imgDir = path.join(root, "images");
  await mkdir(imgDir, { recursive: true });
  await writeFile(path.join(imgDir, "fig1.png"), Buffer.alloc(1024, 1));
  await writeFile(path.join(imgDir, "fig2.jpg"), Buffer.alloc(1024, 1));
  /* code examples */
  const codeDir = path.join(root, "examples");
  await mkdir(codeDir, { recursive: true });
  await writeFile(path.join(codeDir, "hello.py"), "print('hi')");
  await writeFile(path.join(codeDir, "main.cpp"), "int main(){}");
  /* downloaded site */
  const siteDir = path.join(root, "tutorial_files");
  await mkdir(siteDir, { recursive: true });
  await writeFile(path.join(siteDir, "index.html"), "<html></html>");
  /* metadata */
  await writeFile(path.join(root, "README.md"), "# Notes");
  /* archive — должен попасть в skipped */
  await writeFile(path.join(root, "examples.zip"), Buffer.alloc(2048, 1));
  /* hidden — пропускаем */
  await writeFile(path.join(root, ".DS_Store"), "x");
  return root;
}

test("discoverBundle: picks largest PDF as main book", async (t) => {
  const root = await setupBundle();
  t.after(() => rm(root, { recursive: true, force: true }));

  const bundle = await discoverBundle(root);
  assert.ok(bundle.book, "main book detected");
  assert.equal(path.basename(bundle.book!.absPath), "MainBook.pdf");
  /* остальные книги — sidecars (extra editions) */
  const extras = bundle.sidecars.filter((s) => s.kind === "book");
  assert.equal(extras.length, 1);
  assert.equal(path.basename(extras[0]!.absPath), "older-edition.pdf");
  /* warning о множественных книгах */
  assert.ok(bundle.warnings.some((w) => w.includes("multiple books")));
});

test("discoverBundle: classifies images, code, sites, archives, metadata", async (t) => {
  const root = await setupBundle();
  t.after(() => rm(root, { recursive: true, force: true }));

  const bundle = await discoverBundle(root);
  const kinds = bundle.sidecars.map((s) => s.kind);
  assert.equal(kinds.filter((k) => k === "image").length, 2);
  assert.equal(kinds.filter((k) => k === "code").length, 2);
  assert.equal(kinds.filter((k) => k === "html-site").length, 1);
  assert.equal(kinds.filter((k) => k === "metadata").length, 1, "README.md → metadata");
  /* zip → skipped, не в sidecars */
  assert.equal(bundle.skipped.length, 1);
  assert.equal(bundle.skipped[0]!.kind, "archive");
  /* hidden — не учитывается вообще */
  const hasHidden = [...bundle.sidecars, ...bundle.skipped].some((f) => f.relPath.includes(".DS_Store"));
  assert.equal(hasHidden, false);
});

test("discoverBundle: returns book=null for examples-only folder", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bibliary-bundle-empty-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "snippet.py"), "x = 1");

  const bundle = await discoverBundle(root);
  assert.equal(bundle.book, null);
  assert.equal(bundle.sidecars.length, 1);
  assert.ok(bundle.warnings.some((w) => w.includes("no main book")));
});

test("buildBundleMarkdown: includes book + illustrations + code + site sections", async (t) => {
  const root = await setupBundle();
  t.after(() => rm(root, { recursive: true, force: true }));

  const bundle = await discoverBundle(root);
  const md = buildBundleMarkdown({
    bundle,
    bookMarkdown: "Chapter 1\n\nIntroduction text.",
    bookTitle: "C++ Best Practices",
    bookAuthor: "Some Author",
  });

  assert.ok(md.startsWith("# C++ Best Practices"));
  assert.ok(md.includes("*Some Author*"));
  assert.ok(md.includes("## Book contents"));
  assert.ok(md.includes("Introduction text."));
  assert.ok(md.includes("## Illustrations & figures"));
  assert.ok(md.includes("## Code examples"));
  assert.ok(md.includes("## Companion site material"));
  assert.ok(md.includes("## Additional editions"));
  /* fallback-описание появляется когда descriptions не передан */
  assert.ok(md.includes("No description available"));
});

test("buildBundleMarkdown: uses LLM descriptions when provided", async (t) => {
  const root = await setupBundle();
  t.after(() => rm(root, { recursive: true, force: true }));

  const bundle = await discoverBundle(root);
  const descMap = new Map<string, { absPath: string; title: string; description: string; fullText?: string }>();
  for (const s of bundle.sidecars) {
    if (s.kind === "image") {
      descMap.set(s.absPath, {
        absPath: s.absPath,
        title: `Diagram of ${s.baseName}`,
        description: "A schematic showing the data flow.",
      });
    }
    if (s.kind === "code") {
      descMap.set(s.absPath, {
        absPath: s.absPath,
        title: `Example ${s.baseName}`,
        description: "Minimal hello-world example.",
        fullText: "print('hi')",
      });
    }
    if (s.kind === "html-site") {
      descMap.set(s.absPath, {
        absPath: s.absPath,
        title: "Companion HTML",
        description: "Tutorial HTML page.",
      });
    }
  }
  const md = buildBundleMarkdown({
    bundle,
    bookMarkdown: "",
    bookTitle: "T",
    descriptions: descMap,
  });
  assert.ok(md.includes("Diagram of fig1"), "image LLM title used");
  assert.ok(md.includes("A schematic showing the data flow."));
  assert.ok(md.includes("Minimal hello-world example."));
  assert.ok(md.includes("```python\nprint('hi')\n```"));
  assert.ok(!md.includes("No description available"));
});

test("buildBundleMarkdown: deterministic output for same input (stable order)", async (t) => {
  const root = await setupBundle();
  t.after(() => rm(root, { recursive: true, force: true }));
  const b1 = await discoverBundle(root);
  const b2 = await discoverBundle(root);
  const m1 = buildBundleMarkdown({ bundle: b1, bookMarkdown: "X", bookTitle: "Same" });
  const m2 = buildBundleMarkdown({ bundle: b2, bookMarkdown: "X", bookTitle: "Same" });
  assert.equal(m1, m2);
});
