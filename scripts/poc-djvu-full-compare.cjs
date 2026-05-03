/**
 * PoC v2: полный обход всех страниц через djvu.js + сравнение с djvutxt CLI.
 * Доказательство что pure-JS парсер покрывает столько же контента что и CLI.
 */
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { spawnSync } = require("node:child_process");
const { performance } = require("node:perf_hooks");

const inputArg = process.argv[2];
if (!inputArg) {
  console.error("Usage: node poc-djvu-full-compare.cjs <path/to/file.djvu>");
  process.exit(1);
}
const djvuFile = path.resolve(inputArg);

const bundlePath = path.resolve(__dirname, "..", "vendor", "djvu", "djvu.js");
const bundleSource = fs.readFileSync(bundlePath, "utf-8");

const sandbox = {
  console, setTimeout, clearTimeout, setInterval, clearInterval,
  URL: globalThis.URL,
  TextDecoder: globalThis.TextDecoder, TextEncoder: globalThis.TextEncoder,
  ArrayBuffer: globalThis.ArrayBuffer,
  Uint8Array: globalThis.Uint8Array, Uint16Array: globalThis.Uint16Array,
  Uint32Array: globalThis.Uint32Array, Int8Array: globalThis.Int8Array,
  Int16Array: globalThis.Int16Array, Int32Array: globalThis.Int32Array,
  Float32Array: globalThis.Float32Array, Float64Array: globalThis.Float64Array,
  DataView: globalThis.DataView,
  Promise: globalThis.Promise,
  queueMicrotask: globalThis.queueMicrotask,
  performance,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  dispatchEvent: () => true,
  postMessage: () => undefined,
  importScripts: () => undefined,
  location: { href: "file:///djvu", origin: "file://", pathname: "/djvu", protocol: "file:" },
  navigator: { userAgent: "node" },
};
sandbox.self = sandbox;
sandbox.window = sandbox;
sandbox.globalThis = sandbox;

vm.createContext(sandbox);
vm.runInContext(bundleSource, sandbox, { filename: "djvu.js" });
const DjVu = sandbox.DjVu;

const fileBuffer = fs.readFileSync(djvuFile);
const arrayBuffer = fileBuffer.buffer.slice(
  fileBuffer.byteOffset,
  fileBuffer.byteOffset + fileBuffer.byteLength,
);

(async () => {
  console.log(`File: ${path.basename(djvuFile)} (${(fileBuffer.length / 1024 / 1024).toFixed(2)} MB)`);

  /* === djvu.js full scan === */
  const tNative = Date.now();
  const doc = new DjVu.Document(arrayBuffer);
  const pageCount = doc.pages.length;
  let nativeText = "";
  let pagesWithText = 0;
  let pagesWithError = 0;
  for (let i = 0; i < pageCount; i++) {
    try {
      const page = await doc.getPage(i + 1);
      const text = page && page.getText ? page.getText() : "";
      if (text && text.length > 0) {
        nativeText += text + "\n\n";
        pagesWithText++;
      }
    } catch (err) {
      pagesWithError++;
    }
  }
  const nativeMs = Date.now() - tNative;
  console.log(`\n=== djvu.js (native pure-JS) ===`);
  console.log(`Pages:           ${pageCount}`);
  console.log(`Pages with text: ${pagesWithText}`);
  console.log(`Pages errored:   ${pagesWithError}`);
  console.log(`Total chars:     ${nativeText.length}`);
  console.log(`Time:            ${nativeMs}ms (${(nativeMs / pageCount).toFixed(1)}ms/page avg)`);

  /* === djvutxt CLI full scan === */
  const djvutxtPath = path.resolve(__dirname, "..", "vendor", "djvulibre", "win32-x64", "djvutxt.exe");
  if (fs.existsSync(djvutxtPath)) {
    const tCli = Date.now();
    const result = spawnSync(djvutxtPath, [djvuFile], {
      encoding: "utf-8",
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    });
    const cliMs = Date.now() - tCli;
    const cliText = result.stdout ?? "";
    console.log(`\n=== djvutxt CLI (current vendor) ===`);
    console.log(`Total chars:     ${cliText.length}`);
    console.log(`Time:            ${cliMs}ms`);
    console.log(`Exit code:       ${result.status}`);

    /* === Comparison === */
    console.log(`\n=== COMPARISON ===`);
    const ratio = cliText.length > 0 ? (nativeText.length / cliText.length * 100).toFixed(1) : "n/a";
    console.log(`Coverage (native/cli): ${ratio}%`);

    /* Check if first 200 chars match (after normalisation). */
    const normalize = (s) => s.replace(/\s+/g, " ").trim().slice(0, 200);
    const nativeStart = normalize(nativeText);
    const cliStart = normalize(cliText);
    const sameStart = nativeStart === cliStart;
    console.log(`First 200 chars match: ${sameStart ? "YES" : "NO"}`);
    if (!sameStart) {
      console.log(`  native: "${nativeStart.slice(0, 100)}..."`);
      console.log(`  cli:    "${cliStart.slice(0, 100)}..."`);
    }
  }
})().catch((e) => {
  console.error("FATAL:", e && e.stack ? e.stack : e);
  process.exit(1);
});
