#!/usr/bin/env node
/**
 * Управление ABI-стэшем для better-sqlite3.
 *
 * Проблема: `node_modules/better-sqlite3/build/Release/better_sqlite3.node`
 * скомпилирован под одну ABI:
 *   - Node 22 ─→ NODE_MODULE_VERSION 127  (для `npm test`)
 *   - Electron 41 ─→ NODE_MODULE_VERSION 145  (для `electron:dev` / portable)
 * Пересобирать при каждом переключении — медленно и хрупко (5–60 секунд +
 * иногда падает на toolchain). Этот скрипт держит обе версии в
 * `.electron-rebuild-stash/` и переключает через быстрое копирование
 * (~1 MB → ~50 мс).
 *
 * Использование:
 *   node scripts/ensure-sqlite-abi.cjs --target=node       перед `npm test`
 *   node scripts/ensure-sqlite-abi.cjs --target=electron   перед `electron:dev` / portable
 *   node scripts/ensure-sqlite-abi.cjs --save --target=node       положить текущий live в stash
 *   node scripts/ensure-sqlite-abi.cjs --save --target=electron   то же для electron
 *
 * Поведение `--target=X` (без `--save`):
 *   1. Если marker уже соответствует X → exit 0 (idempotent fast path).
 *   2. Если `stash/better_sqlite3.X.node` существует → copy → live, exit 0.
 *   3. Иначе → попытка `npm rebuild better-sqlite3` (для node) или
 *      `@electron/rebuild` (для electron), потом авто-stash, exit 0.
 *   4. Если rebuild упал → log warning, exit 1 (вызывающий может fallback).
 *
 * Поведение `--save --target=X`:
 *   Копирует текущий live-бинарь в stash как X. Используется CI и
 *   `build-portable.js` после успешной нативной сборки.
 *
 * Маркер `.abi-marker` (рядом с live) содержит текущую ABI ("node"|"electron").
 *
 * Совместимость: legacy-stash `better_sqlite3.node` (без суффикса) считаем
 * electron-ABI (так build-portable.js именовал его до 0.4.x).
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const args = process.argv.slice(2);
const targetArg = args.find((a) => a.startsWith("--target="));
const target = targetArg ? targetArg.split("=")[1] : null;
const saveMode = args.includes("--save");

if (target !== "node" && target !== "electron") {
  console.error("[ensure-sqlite-abi] --target=node|electron is required");
  process.exit(2);
}

const PROJECT_ROOT = path.resolve(__dirname, "..");
const LIVE = path.join(
  PROJECT_ROOT, "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node",
);
const STASH_DIR = path.join(PROJECT_ROOT, ".electron-rebuild-stash");
const STASH_FILE = path.join(STASH_DIR, `better_sqlite3.${target}.node`);
const LEGACY_STASH = path.join(STASH_DIR, "better_sqlite3.node");
const MARKER = LIVE + ".abi-marker";

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readMarker() {
  try { return fs.readFileSync(MARKER, "utf8").trim(); } catch { return null; }
}

function writeMarker(value) {
  try { fs.writeFileSync(MARKER, value); } catch (e) {
    console.warn("[ensure-sqlite-abi] failed to write marker:", e.message);
  }
}

function copyBinary(src, dst, label) {
  ensureDir(path.dirname(dst));
  fs.copyFileSync(src, dst);
  const size = fs.statSync(dst).size;
  console.log(`[ensure-sqlite-abi] ${label}: ${path.relative(PROJECT_ROOT, dst)} (${size} bytes)`);
}

function tryRebuildNode() {
  console.log("[ensure-sqlite-abi] no node-ABI stash; running `npm rebuild better-sqlite3`");
  const res = spawnSync("npm", ["rebuild", "better-sqlite3"], {
    cwd: PROJECT_ROOT, stdio: "inherit", shell: true,
  });
  return res.status === 0;
}

function tryRebuildElectron() {
  console.log("[ensure-sqlite-abi] no electron-ABI stash; running `@electron/rebuild`");
  const res = spawnSync(
    "npx",
    ["@electron/rebuild", "--only", "better-sqlite3", "--force", "--build-from-source"],
    { cwd: PROJECT_ROOT, stdio: "inherit", shell: true },
  );
  return res.status === 0;
}

if (saveMode) {
  if (!fs.existsSync(LIVE)) {
    console.warn(`[ensure-sqlite-abi] live binary missing at ${LIVE}; nothing to save`);
    process.exit(1);
  }
  ensureDir(STASH_DIR);
  copyBinary(LIVE, STASH_FILE, `saved ${target}-ABI → stash`);
  writeMarker(target);
  process.exit(0);
}

if (fs.existsSync(LIVE) && readMarker() === target) {
  process.exit(0);
}

ensureDir(STASH_DIR);

let stashSrc = null;
if (fs.existsSync(STASH_FILE)) {
  stashSrc = STASH_FILE;
} else if (target === "electron" && fs.existsSync(LEGACY_STASH)) {
  stashSrc = LEGACY_STASH;
}

if (stashSrc) {
  copyBinary(stashSrc, LIVE, `${target}-ABI from stash → live`);
  writeMarker(target);
  /* Migration: если использовали legacy `better_sqlite3.node` для electron-ABI,
     заодно сохраним новое имя `better_sqlite3.electron.node`, чтобы со
     временем legacy-файл ушёл из проекта. */
  if (stashSrc === LEGACY_STASH && !fs.existsSync(STASH_FILE)) {
    copyBinary(LEGACY_STASH, STASH_FILE, "migrated legacy stash → new name");
  }
  process.exit(0);
}

const rebuildOk = target === "node" ? tryRebuildNode() : tryRebuildElectron();
if (!rebuildOk) {
  console.warn(`[ensure-sqlite-abi] rebuild for ${target}-ABI failed; live binary may be wrong ABI`);
  process.exit(1);
}

if (!fs.existsSync(LIVE)) {
  console.warn("[ensure-sqlite-abi] rebuild reported success but live binary missing");
  process.exit(1);
}

copyBinary(LIVE, STASH_FILE, `auto-saved ${target}-ABI → stash`);
writeMarker(target);
process.exit(0);
