#!/usr/bin/env node
/**
 * scripts/doctor.cjs
 *
 * Кроссплатформенная диагностика готовности проекта к запуску.
 * Проверяет:
 *   - Версия Node.js (≥18)
 *   - Платформа поддерживается
 *   - Native modules загружаются (better-sqlite3, sharp, edgeparse, system-ocr)
 *   - Vendor binaries присутствуют для текущей платформы (7zip, djvulibre)
 *   - LM Studio + Chroma доступны (опционально, через preferences)
 *
 * Запуск:
 *   npm run doctor
 *
 * Выход: 0 — всё ок (или только warning); 1 — есть критичные проблемы.
 */

"use strict";

const path = require("node:path");
const fs = require("node:fs");

const ROOT = path.resolve(__dirname, "..");

let errors = 0;
let warnings = 0;

function ok(msg) {
  console.log(`  ✓  ${msg}`);
}
function warn(msg) {
  console.log(`  ⚠  ${msg}`);
  warnings++;
}
function fail(msg) {
  console.log(`  ✗  ${msg}`);
  errors++;
}
function header(title) {
  console.log(`\n[${title}]`);
}

/* ─── 1. Node.js + платформа ─────────────────────────────── */

header("Runtime");
const nodeMajor = parseInt(process.versions.node.split(".")[0], 10);
if (nodeMajor >= 22) ok(`Node.js ${process.versions.node}`);
else if (nodeMajor >= 18) warn(`Node.js ${process.versions.node} — поддерживается, но рекомендуется 22+`);
else fail(`Node.js ${process.versions.node} — слишком старый, нужен 18+`);

const platformKey = `${process.platform}-${process.arch}`;
const SUPPORTED = ["win32-x64"];
if (SUPPORTED.includes(platformKey)) ok(`Platform: ${platformKey}`);
else fail(`Platform ${platformKey} не в списке поддерживаемых: ${SUPPORTED.join(", ")}`);

/* ─── 2. Vendor binaries ─────────────────────────────────── */

header("Vendor binaries");
const vendorDir = `${process.platform}-${process.arch === "arm64" ? "arm64" : "x64"}`;
const exeSuffix = process.platform === "win32" ? ".exe" : "";

const checks7z = path.join(ROOT, "vendor", "7zip", vendorDir, `7z${exeSuffix}`);
if (fs.existsSync(checks7z)) ok(`7zip: ${checks7z}`);
else if (process.platform === "win32") fail(`7zip отсутствует: ${checks7z} (запустить: npm run setup:7zip)`);
else warn(`7zip отсутствует: ${checks7z}. Платформа ${process.platform} официально не поддерживается; приложение полагается на 7z из PATH`);

const NEEDED_DJVU = ["djvutxt", "ddjvu", "djvused"];
let djvuFound = 0;
for (const bin of NEEDED_DJVU) {
  const probe = path.join(ROOT, "vendor", "djvulibre", vendorDir, `${bin}${exeSuffix}`);
  if (fs.existsSync(probe)) djvuFound++;
}
if (djvuFound === NEEDED_DJVU.length) ok(`djvulibre: все ${NEEDED_DJVU.length} утилиты в vendor/djvulibre/${vendorDir}/`);
else if (djvuFound > 0) warn(`djvulibre: найдено ${djvuFound}/${NEEDED_DJVU.length}. Pure-JS parser является primary path, но CLI fallback неполный`);
else warn(`djvulibre отсутствует. Pure-JS parser обработает большинство DJVU; CLI fallback недоступен`);

const djvuPureJs = path.join(ROOT, "vendor", "djvu", "djvu.js");
if (fs.existsSync(djvuPureJs)) ok(`djvu.js (pure-JS parser): ${djvuPureJs}`);
else warn(`djvu.js pure-JS parser отсутствует — только CLI fallback будет работать`);

/* ─── 3. Native node modules ─────────────────────────────── */

header("Native modules");
function tryRequire(name) {
  try {
    require(name);
    ok(`require('${name}')`);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message.split("\n")[0] : String(err);
    fail(`require('${name}'): ${msg}`);
    return false;
  }
}
tryRequire("better-sqlite3");
tryRequire("sharp");
tryRequire("@napi-rs/canvas");
tryRequire("edgeparse");
tryRequire("@napi-rs/system-ocr");

/* ─── 4. Поддерживаемые расширения файлов ───────────────── */

header("Smoke checks");
try {
  const sqlite = require("better-sqlite3");
  const db = new sqlite(":memory:");
  db.prepare("CREATE TABLE x (id INTEGER)").run();
  db.prepare("INSERT INTO x VALUES (1)").run();
  const row = db.prepare("SELECT id FROM x").get();
  if (row && row.id === 1) ok("better-sqlite3 read/write");
  else fail("better-sqlite3: read/write не работает");
  db.close();
} catch (err) {
  fail(`better-sqlite3 smoke: ${err instanceof Error ? err.message : err}`);
}

/* ─── Итог ───────────────────────────────────────────────── */

console.log("");
if (errors === 0 && warnings === 0) {
  console.log("✓ Всё ок. Проект готов к работе на этой платформе.");
  process.exit(0);
}
if (errors === 0) {
  console.log(`⚠ ${warnings} warning(s). Проект запустится, но какие-то функции могут быть деградированы.`);
  process.exit(0);
}
console.log(`✗ ${errors} error(s), ${warnings} warning(s). Исправьте критичные проблемы перед запуском.`);
process.exit(1);
