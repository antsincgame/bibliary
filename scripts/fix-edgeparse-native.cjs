/**
 * Postinstall fix: edgeparse bundles all platform .node binaries inside its
 * own npm/ folder but tries to `require('edgeparse-win32-x64-msvc')` as a
 * separate package. npm doesn't always install the optional platform dep.
 *
 * This script creates the missing directory with a copy of the binary so
 * that the standard require() resolution works in both dev and packaged builds.
 */
const fs = require("fs");
const path = require("path");

const platforms = {
  "win32-x64": { pkg: "edgeparse-win32-x64-msvc", file: "edgeparse-node.win32-x64-msvc.node" },
  "linux-x64": { pkg: "edgeparse-linux-x64-gnu", file: "edgeparse-node.linux-x64-gnu.node" },
  "linux-arm64": { pkg: "edgeparse-linux-arm64-gnu", file: "edgeparse-node.linux-arm64-gnu.node" },
  "darwin-x64": { pkg: "edgeparse-darwin-x64", file: "edgeparse-node.darwin-x64.node" },
  "darwin-arm64": { pkg: "edgeparse-darwin-arm64", file: "edgeparse-node.darwin-arm64.node" },
};

const key = `${process.platform}-${process.arch}`;
const info = platforms[key];
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
const sourcePkgJson = path.join(edgeparsePkg, "npm", key.replace("-", path.sep === "\\" ? "-" : "-").replace("win32-x64", "win32-x64-msvc").replace("linux-x64", "linux-x64-gnu").replace("linux-arm64", "linux-arm64-gnu"), "package.json");

if (!fs.existsSync(sourceFile)) {
  console.log(`[fix-edgeparse] native binary not found at ${sourceFile}, skipping`);
  process.exit(0);
}

fs.mkdirSync(targetDir, { recursive: true });
fs.copyFileSync(sourceFile, targetFile);

const subfolderMap = {
  "win32-x64": "win32-x64-msvc",
  "linux-x64": "linux-x64-gnu",
  "linux-arm64": "linux-arm64-gnu",
  "darwin-x64": "darwin-x64",
  "darwin-arm64": "darwin-arm64",
};
const subPkg = path.join(edgeparsePkg, "npm", subfolderMap[key], "package.json");
if (fs.existsSync(subPkg)) {
  fs.copyFileSync(subPkg, path.join(targetDir, "package.json"));
}

console.log(`[fix-edgeparse] copied ${info.file} → node_modules/${info.pkg}/`);
