/**
 * PoC: загрузить vendor/djvu/djvu.js (RussCoder/djvujs IIFE bundle) в Node.js
 * через vm sandbox, открыть реальный .djvu файл и извлечь текст. Сравнить
 * с outputом существующего djvutxt CLI на той же книге.
 *
 * Iter 14.4 (2026-05-04, /imperor): подготовка к замене вендора DjVuLibre
 * на pure JS. Этот скрипт — proof of concept чтобы убедиться что:
 *   1) bundle корректно загружается под Node.js (без браузерных API)
 *   2) DjVu.Document открывает реальные книги
 *   3) getText на каждой странице даёт человеко-читаемый текст
 *   4) количество страниц извлекается корректно
 *
 * Usage:
 *   node scripts/poc-djvu-native.cjs <path/to/file.djvu>
 *
 * При успехе — далее интегрируем как djvu-native.ts adapter (strangler fig).
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { spawnSync } = require("node:child_process");
const { performance } = require("node:perf_hooks");

const inputArg = process.argv[2];
if (!inputArg) {
  console.error("Usage: node scripts/poc-djvu-native.cjs <path/to/file.djvu>");
  process.exit(1);
}
const djvuFile = path.resolve(inputArg);
if (!fs.existsSync(djvuFile)) {
  console.error(`File not found: ${djvuFile}`);
  process.exit(1);
}

const bundlePath = path.resolve(__dirname, "..", "vendor", "djvu", "djvu.js");
if (!fs.existsSync(bundlePath)) {
  console.error(`djvu.js bundle not found at ${bundlePath}`);
  process.exit(1);
}

console.log("=== DjVu.js Native PoC ===");
console.log(`Bundle: ${bundlePath}`);
console.log(`Book:   ${djvuFile}`);
console.log(`Size:   ${(fs.statSync(djvuFile).size / 1024 / 1024).toFixed(2)} MB`);
console.log("");

/* === Step 1: load djvu.js into a sandbox context ===
   Bundle is an IIFE that adds `DjVu` to a global scope. We provide minimal
   browser-shim so the bundle can find what it expects (it uses `self` for
   global, may reference Worker / fetch, but for sync API we don't need them). */
const bundleSource = fs.readFileSync(bundlePath, "utf-8");

const sandbox = {
  /* Some browser libraries probe `window`/`self` for global. */
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  /* Fake URL for any internal blob/url handling. */
  URL: globalThis.URL,
  /* DjVu.js may probe TextDecoder/TextEncoder — Node has them globally. */
  TextDecoder: globalThis.TextDecoder,
  TextEncoder: globalThis.TextEncoder,
  /* Buffer is Node-specific; some code in djvu.js may convert ArrayBuffer
     via DataView/Uint8Array — those are Node globals. */
  ArrayBuffer: globalThis.ArrayBuffer,
  Uint8Array: globalThis.Uint8Array,
  Uint16Array: globalThis.Uint16Array,
  Uint32Array: globalThis.Uint32Array,
  Int8Array: globalThis.Int8Array,
  Int16Array: globalThis.Int16Array,
  Int32Array: globalThis.Int32Array,
  Float32Array: globalThis.Float32Array,
  Float64Array: globalThis.Float64Array,
  DataView: globalThis.DataView,
  /* For Promise-returning methods. */
  Promise: globalThis.Promise,
  /* Some chunked operations use queueMicrotask. */
  queueMicrotask: globalThis.queueMicrotask,

  /* DjVu.js uses performance.now() for timing — Node has it via perf_hooks. */
  performance,

  /* Worker-style events: bundle registers self.addEventListener('message', ...)
     during init (for browser Web Worker API). For sync-only Node usage we
     don't need actual event handling — provide no-op shims so init doesn't
     crash. importScripts/postMessage are also Worker globals. */
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  dispatchEvent: () => true,
  postMessage: () => undefined,
  importScripts: () => undefined,
  /* Some libs probe `location` — provide minimal shape. */
  location: { href: "file:///djvu", origin: "file://", pathname: "/djvu", protocol: "file:" },
  navigator: { userAgent: "node-djvu-native-poc" },
};
sandbox.self = sandbox;
sandbox.window = sandbox;
sandbox.globalThis = sandbox;

vm.createContext(sandbox);

console.log("Loading djvu.js into VM sandbox...");
const t0 = Date.now();
try {
  vm.runInContext(bundleSource, sandbox, { filename: "djvu.js" });
} catch (err) {
  console.error(`✗ Failed to load bundle: ${err.message}`);
  process.exit(1);
}
console.log(`✓ Loaded in ${Date.now() - t0}ms`);

const DjVu = sandbox.DjVu;
if (!DjVu) {
  console.error("✗ DjVu global not found after bundle execution");
  console.error(`Available sandbox keys: ${Object.keys(sandbox).slice(0, 20).join(", ")}`);
  process.exit(1);
}
console.log(`✓ DjVu global found. Methods: Document=${!!DjVu.Document}, Worker=${!!DjVu.Worker}`);
console.log("");

/* === Step 2: open the file and parse === */
const fileBuffer = fs.readFileSync(djvuFile);
/* Convert Node Buffer to ArrayBuffer for DjVu.Document. */
const arrayBuffer = fileBuffer.buffer.slice(
  fileBuffer.byteOffset,
  fileBuffer.byteOffset + fileBuffer.byteLength,
);

console.log("Parsing DjVu document (sync API)...");
const t1 = Date.now();
let doc;
try {
  doc = new DjVu.Document(arrayBuffer);
} catch (err) {
  console.error(`✗ DjVu.Document failed: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
}
console.log(`✓ Document opened in ${Date.now() - t1}ms`);

const pageCount = doc.pages?.length ?? doc.getPagesQuantity?.() ?? 0;
console.log(`✓ Pages: ${pageCount}`);
console.log("");

if (pageCount === 0) {
  console.error("✗ Empty document (no pages)");
  process.exit(1);
}

/* === Step 3: extract text from first 5 pages (async API) === */
async function extractText() {
  console.log("=== TEXT FROM djvu.js (native JS, RussCoder) ===");
  const nativeChunks = [];
  let nativeTotal = 0;
  const t2 = Date.now();
  const probeCount = Math.min(5, pageCount);
  for (let i = 0; i < probeCount; i++) {
    try {
      /* getPage() in DjVu.js v0.5.4 returns a Promise even in sync API
         (lazy decoding). Page is decoded on first access. */
      const page = await doc.getPage(i + 1); /* 1-based numbering */
      if (!page) {
        nativeChunks.push({ page: i + 1, error: "page is null" });
        continue;
      }
      const text = page.getText ? page.getText() : "";
      nativeTotal += text.length;
      nativeChunks.push({ page: i + 1, length: text.length, sample: text.slice(0, 300) });
    } catch (err) {
      nativeChunks.push({ page: i + 1, error: err && err.message ? err.message : JSON.stringify(err).slice(0, 200) });
    }
  }
  console.log(`✓ Probed ${probeCount} pages in ${Date.now() - t2}ms (${nativeTotal} chars total)`);
  for (const c of nativeChunks) {
    console.log(`\n--- Page ${c.page} ---`);
    if (c.error) {
      console.log(`ERROR: ${c.error}`);
    } else if (c.length === 0) {
      console.log("(empty — no text layer on this page)");
    } else {
      console.log(`(${c.length} chars)`);
      console.log(c.sample.replace(/\s+/g, " ").trim());
    }
  }
  console.log("");

  /* === Step 3.5: try Worker-based async API as fallback === */
  if (nativeTotal === 0) {
    console.log("=== Sync API gave 0 chars. Trying DjVu.Worker (async) ===");
    try {
      const worker = new DjVu.Worker();
      console.log(`✓ Worker created`);
      await worker.createDocument(arrayBuffer);
      console.log(`✓ Document loaded in worker`);
      const t4 = Date.now();
      const probe2 = Math.min(5, pageCount);
      for (let i = 0; i < probe2; i++) {
        const text = await worker.doc.getPage(i + 1).getText().run();
        console.log(`  page ${i + 1}: ${typeof text === "string" ? text.length : "?"} chars`);
        if (typeof text === "string" && text.length > 0) {
          console.log(`    sample: ${text.slice(0, 200).replace(/\s+/g, " ").trim()}`);
        }
      }
      console.log(`✓ Worker probe done in ${Date.now() - t4}ms`);
    } catch (werr) {
      console.log(`✗ Worker API failed: ${werr && werr.message ? werr.message : werr}`);
    }
  }
}

function compareCli() {
  /* === Step 4: compare with djvutxt CLI (vendor) === */
  const djvutxtPath = path.resolve(__dirname, "..", "vendor", "djvulibre", "win32-x64", "djvutxt.exe");
  if (fs.existsSync(djvutxtPath)) {
    console.log("=== TEXT FROM djvutxt CLI (current vendor, DjVuLibre) ===");
    const t3 = Date.now();
    const result = spawnSync(djvutxtPath, [djvuFile], {
      encoding: "utf-8",
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    });
    if (result.status !== 0) {
      console.log(`✗ djvutxt exited with code ${result.status}`);
      if (result.stderr) console.log(`stderr: ${result.stderr.slice(0, 500)}`);
    } else {
      const cliText = result.stdout ?? "";
      console.log(`✓ djvutxt extracted ${cliText.length} chars in ${Date.now() - t3}ms`);
      console.log("\n--- First 600 chars from CLI ---");
      console.log(cliText.slice(0, 600).replace(/\s+/g, " ").trim());
    }
  } else {
    console.log(`(djvutxt CLI not found at ${djvutxtPath} — skipping comparison)`);
  }
  console.log("\n=== PoC DONE ===");
}

extractText().then(compareCli).catch((err) => {
  console.error(`✗ extractText error: ${err && err.message ? err.message : err}`);
  compareCli();
});
