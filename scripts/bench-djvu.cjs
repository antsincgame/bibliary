#!/usr/bin/env node
/* eslint-disable no-console */

/**
 * Боевой бенчмарк: DjVuLibre (djvutxt CLI) vs djvu.js (djvujs-dist).
 *
 * Цель: измерить speed (ms) и accuracy (char similarity) на реальных DjVu
 *       книгах из D:/Bibliarifull. Без production-зависимости от GPL djvu.js —
 *       пакет ставится --no-save для бенчмарка и удаляется после.
 *
 * Запуск: node scripts/bench-djvu.cjs <file1.djvu> [file2.djvu...]
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const esbuild = require("esbuild");

/* === DjVuLibre side — спавним наш vendor djvutxt.exe ============= */

function findDjvutxt() {
  const candidates = [
    path.join(process.cwd(), "vendor", "djvulibre", "win32-x64", "djvutxt.exe"),
    path.join(process.cwd(), "vendor", "djvulibre", "djvutxt.exe"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error("djvutxt.exe not found in vendor/djvulibre");
}

function runDjvuLibre(filePath) {
  const bin = findDjvutxt();
  const start = process.hrtime.bigint();
  const res = spawnSync(bin, [filePath], { encoding: "buffer", maxBuffer: 256 * 1024 * 1024 });
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
  if (res.status !== 0) {
    return { elapsedMs, text: "", error: res.stderr ? res.stderr.toString("utf8") : `exit ${res.status}` };
  }
  return { elapsedMs, text: res.stdout.toString("utf8"), error: null };
}

/* === djvu.js side — bundle ESM источник в CJS, выполняем in-process == */

let DjVuLib = null;
async function loadDjvuJs() {
  if (DjVuLib) return DjVuLib;

  const srcEntry = path.resolve("node_modules/djvujs-dist/library/src/index.js");
  if (!fs.existsSync(srcEntry)) {
    throw new Error(`djvujs-dist not installed at ${srcEntry}. Run: npm install --no-save djvujs-dist@0.5.4`);
  }

  /* Шим: библиотека написана для браузера (использует self/document). 
     В Node глобальный self отсутствует — добавляем заглушку до бандла. 
     pngjs/browser нужен только для растеризации страниц, для getText() не используется
     — стабим в no-op чтобы bundle прошёл. */
  const stubPlugin = {
    name: "stub-png",
    setup(build) {
      build.onResolve({ filter: /^pngjs\/browser$/ }, () => ({
        path: "stub-pngjs",
        namespace: "stub",
      }));
      build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
        contents: "module.exports = { PNG: class { constructor(){} pack(){return this;} on(){return this;} } };",
        loader: "js",
      }));
    },
  };
  const result = await esbuild.build({
    entryPoints: [srcEntry],
    bundle: true,
    format: "cjs",
    platform: "neutral",
    target: ["node20"],
    write: false,
    logLevel: "silent",
    /* Подменяем `self` на globalThis, document/Worker/XMLHttpRequest нам не нужны
       для синхронного getText() пути. */
    define: { self: "globalThis" },
    /* Inline polyfill: делаем globalThis.location undefined (есть проверки в коде). */
    /* document=stub отключает worker-init ветку (`if (!self.document)`).
       location нужен в DjVuDocument для baseUrl. */
    banner: { js: "if (typeof globalThis.location === 'undefined') globalThis.location = { origin: '' }; if (typeof globalThis.document === 'undefined') globalThis.document = {};" },
    plugins: [stubPlugin],
  });

  const bundleJs = result.outputFiles[0].text;
  /* Загружаем bundle через Module._compile в изолированной CJS-обёртке. */
  const Module = require("module");
  const m = new Module("djvujs-bench-bundle");
  m.filename = srcEntry;
  m.paths = Module._nodeModulePaths(path.dirname(srcEntry));
  m._compile(bundleJs, m.filename);
  DjVuLib = m.exports.default || m.exports;
  return DjVuLib;
}

async function runDjvuJs(filePath) {
  const DjVu = await loadDjvuJs();
  const buf = fs.readFileSync(filePath);
  /* ArrayBuffer slice — DjVuDocument требует именно ArrayBuffer, не Buffer. */
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

  const start = process.hrtime.bigint();
  let text = "";
  let error = null;
  try {
    const doc = new DjVu.Document(ab);
    /* Sparse pages в multi-page документе — _parseComponents() для bundled DjVu
       уже создал DjVuPage для каждой страницы. Но не-bundled (indirect) нам
       не интересен — все наши тестовые файлы bundled. */
    const pageCount = doc.pages.length;
    const parts = [];
    for (let i = 0; i < pageCount; i++) {
      const page = doc.pages[i];
      if (!page) continue;
      try {
        const t = page.getText();
        if (t) parts.push(t);
      } catch (e) {
        error = (error ? error + "; " : "") + `page ${i + 1}: ${e.message}`;
      }
    }
    text = parts.join("\n\n");
  } catch (e) {
    error = e.message;
  }
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
  return { elapsedMs, text, error };
}

/* === Сравнение текстов ============================================ */

function normalize(text) {
  /* Сжимаем все whitespace + убираем разрыв слов в конце строки.
     Это убирает разницу в форматировании и фокусирует на character content. */
  return text
    .replace(/-\n([a-zа-яё])/giu, "$1")
    .replace(/\s+/gu, " ")
    .trim();
}

function similarity(a, b) {
  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb) return 1.0;
  if (!na.length || !nb.length) return 0;
  /* Дешёвый bigram Jaccard — для текстов объёмом 100-500 KB Levenshtein 
     слишком дорог. Bigram Jaccard коррелирует с edit distance ~0.95. */
  const bigrams = (s) => {
    const set = new Set();
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
    return set;
  };
  const A = bigrams(na);
  const B = bigrams(nb);
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

/* === Main ========================================================= */

async function benchOne(filePath, iterations) {
  const stat = fs.statSync(filePath);
  const sizeMb = (stat.size / 1024 / 1024).toFixed(2);

  console.log(`\n=== ${path.basename(filePath)} (${sizeMb} MB) ===`);

  const cli = [];
  const lib = [];
  let cliText = "";
  let libText = "";
  let cliErr = null;
  let libErr = null;

  for (let i = 0; i < iterations; i++) {
    const c = runDjvuLibre(filePath);
    cli.push(c.elapsedMs);
    if (i === 0) { cliText = c.text; cliErr = c.error; }
  }

  for (let i = 0; i < iterations; i++) {
    const l = await runDjvuJs(filePath);
    lib.push(l.elapsedMs);
    if (i === 0) { libText = l.text; libErr = l.error; }
  }

  const med = (arr) => {
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };

  const cliMs = med(cli);
  const libMs = med(lib);
  const sim = similarity(cliText, libText);

  console.log(`  DjVuLibre djvutxt:  ${cliMs.toFixed(1).padStart(8)} ms median (${iterations}x), text=${cliText.length.toString().padStart(7)} chars` + (cliErr ? `  ERR: ${cliErr.slice(0, 80)}` : ""));
  console.log(`  djvu.js (in-proc):  ${libMs.toFixed(1).padStart(8)} ms median (${iterations}x), text=${libText.length.toString().padStart(7)} chars` + (libErr ? `  ERR: ${libErr.slice(0, 80)}` : ""));
  console.log(`  Speed ratio:        djvu.js is ${(libMs / cliMs).toFixed(2)}× ${libMs > cliMs ? "SLOWER" : "FASTER"} than DjVuLibre`);
  console.log(`  Text similarity:    ${(sim * 100).toFixed(2)}%  (bigram Jaccard, normalized)`);

  if (process.env.BENCH_VERBOSE === "1" && cliText && libText) {
    /* Покажем первые расхождения. */
    const nA = normalize(cliText);
    const nB = normalize(libText);
    let firstDiff = -1;
    for (let i = 0; i < Math.min(nA.length, nB.length); i++) {
      if (nA[i] !== nB[i]) { firstDiff = i; break; }
    }
    if (firstDiff >= 0) {
      const ctx = 60;
      console.log(`  First normalized diff at char ${firstDiff}:`);
      console.log(`    DjVuLibre: …${JSON.stringify(nA.slice(Math.max(0, firstDiff - ctx), firstDiff + ctx))}`);
      console.log(`    djvu.js:   …${JSON.stringify(nB.slice(Math.max(0, firstDiff - ctx), firstDiff + ctx))}`);
    }
    /* Сравним первые/последние 200 chars сырого вывода — заметим различия в форматировании. */
    console.log(`  CLI raw head (200):  ${JSON.stringify(cliText.slice(0, 200))}`);
    console.log(`  LIB raw head (200):  ${JSON.stringify(libText.slice(0, 200))}`);
  }

  return { name: path.basename(filePath), sizeMb, cliMs, libMs, cliChars: cliText.length, libChars: libText.length, sim, cliErr, libErr };
}

(async () => {
  const args = process.argv.slice(2);
  if (!args.length) {
    console.error("usage: node scripts/bench-djvu.cjs <file.djvu> [more.djvu...]");
    process.exit(2);
  }
  const iterations = Number(process.env.BENCH_ITER || 3);
  console.log(`DjVu Benchmark — DjVuLibre vs djvu.js`);
  console.log(`Iterations per file: ${iterations} (median reported)`);

  const results = [];
  for (const f of args) {
    if (!fs.existsSync(f)) {
      console.warn(`SKIP missing: ${f}`);
      continue;
    }
    try {
      results.push(await benchOne(f, iterations));
    } catch (e) {
      console.error(`FAIL ${f}: ${e.message}\n${e.stack}`);
    }
  }

  console.log("\n\n=== SUMMARY ===");
  console.log("File                                        | Size MB | DjVuLibre ms | djvu.js ms | Ratio  | Sim    | DjVu chars | djvu.js chars");
  console.log("-".repeat(160));
  for (const r of results) {
    console.log(
      r.name.padEnd(43).slice(0, 43) +
      " | " + String(r.sizeMb).padStart(7) +
      " | " + r.cliMs.toFixed(1).padStart(12) +
      " | " + r.libMs.toFixed(1).padStart(10) +
      " | " + (r.libMs / r.cliMs).toFixed(2).padStart(5) + "x" +
      " | " + (r.sim * 100).toFixed(1).padStart(5) + "%" +
      " | " + String(r.cliChars).padStart(10) +
      " | " + String(r.libChars).padStart(13)
    );
  }
})().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
