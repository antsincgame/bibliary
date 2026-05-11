/**
 * Postinstall fix: edgeparse bundles all platform .node binaries inside its
 * own npm/ folder but tries to `require('edgeparse-<platform>-<arch>')` as a
 * separate package. npm doesn't always install the optional platform dep.
 *
 * Этот скрипт создаёт недостающую директорию с копией бинаря, чтобы стандартный
 * require() работал и в dev, и в packaged-сборках, на всех поддерживаемых ОС.
 */
"use strict";

const fs = require("fs");
const path = require("path");

/**
 * Карта `${platform}-${arch}` → пакет + файл + подпапка внутри edgeparse/npm.
 * Для каждой поддерживаемой платформы нужны все три значения.
 */
const PLATFORMS = {
  "win32-x64": {
    pkg: "edgeparse-win32-x64-msvc",
    file: "edgeparse-node.win32-x64-msvc.node",
    subfolder: "win32-x64-msvc",
  },
};

const key = `${process.platform}-${process.arch}`;
const info = PLATFORMS[key];
if (!info) {
  console.log(`[fix-edgeparse] platform ${key} not supported by edgeparse, skipping`);
  process.exit(0);
}

const nmDir = path.join(__dirname, "..", "node_modules");
const edgeparsePkg = path.join(nmDir, "edgeparse");
if (!fs.existsSync(edgeparsePkg)) {
  console.log("[fix-edgeparse] edgeparse not installed, skipping");
  process.exit(0);
}

const targetDir = path.join(nmDir, info.pkg);
const targetFile = path.join(targetDir, info.file);
if (fs.existsSync(targetFile)) {
  console.log(`[fix-edgeparse] ${info.pkg}/${info.file} already in place`);
  process.exit(0);
}

const sourceFile = path.join(edgeparsePkg, "npm", info.file);
if (!fs.existsSync(sourceFile)) {
  console.log(`[fix-edgeparse] native binary not found at ${sourceFile}, skipping`);
  process.exit(0);
}

fs.mkdirSync(targetDir, { recursive: true });
fs.copyFileSync(sourceFile, targetFile);

const subPkg = path.join(edgeparsePkg, "npm", info.subfolder, "package.json");
if (fs.existsSync(subPkg)) {
  fs.copyFileSync(subPkg, path.join(targetDir, "package.json"));
}

console.log(`[fix-edgeparse] copied ${info.file} → node_modules/${info.pkg}/`);
