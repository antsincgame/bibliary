#!/usr/bin/env node
/**
 * scripts/download-7zip-macos.cjs
 *
 * Copies the 7z CLI binary into vendor/7zip/darwin-<arch>/
 * from a Homebrew installation of p7zip. Falls back to installing
 * via brew if not present.
 *
 * Usage:
 *   npm run setup:7zip-macos
 *
 * After running, rebuild:
 *   npm run electron:build
 *
 * NOTE: On macOS the app also falls back to a system "7z" in PATH
 * (from archive-extractor.ts / chm.ts). Vendoring ensures the binary
 * is available in sandboxed / packaged builds without PATH.
 */

"use strict";

const { spawnSync } = require("child_process");
const { promises: fs, existsSync } = require("fs");
const path = require("path");
const os = require("os");

if (process.platform !== "darwin") {
  console.log("[7zip-macos] This script is macOS-only.");
  process.exit(0);
}

const arch = os.arch() === "arm64" ? "arm64" : "x64";
const PLATFORM_DIR = `darwin-${arch}`;
const ROOT = path.resolve(__dirname, "..");
const VENDOR_DIR = path.join(ROOT, "vendor", "7zip", PLATFORM_DIR);

// p7zip ships as "7z" or "7zz" depending on version.
const BREW_BIN_CANDIDATES = [
  ["/opt/homebrew/bin/7z",  "7z"],   // Apple Silicon / newer p7zip
  ["/opt/homebrew/bin/7zz", "7z"],   // Apple Silicon / p7zip-full
  ["/usr/local/bin/7z",     "7z"],   // Intel
  ["/usr/local/bin/7zz",    "7z"],   // Intel / p7zip-full
];

function findBrewBinary() {
  for (const [src, dstName] of BREW_BIN_CANDIDATES) {
    if (existsSync(src)) return { src, dstName };
  }
  return null;
}

async function vendorAlreadyComplete() {
  return existsSync(path.join(VENDOR_DIR, "7z"));
}

async function installViaBrewIfNeeded() {
  if (findBrewBinary()) return;
  console.log("[7zip-macos] p7zip not found — installing via brew...");
  // p7zip is the canonical Homebrew formula providing the 7z CLI.
  const res = spawnSync("brew", ["install", "p7zip"], { stdio: "inherit" });
  if (res.status !== 0) {
    console.error("[7zip-macos] brew install failed. Install manually: brew install p7zip");
    process.exit(1);
  }
  console.log("[7zip-macos] brew install completed.");
}

async function copyBinary() {
  const found = findBrewBinary();
  if (!found) {
    console.error("[7zip-macos] 7z binary not found after installation.");
    process.exit(1);
  }
  const { src, dstName } = found;
  await fs.mkdir(VENDOR_DIR, { recursive: true });
  const dst = path.join(VENDOR_DIR, dstName);
  await fs.copyFile(src, dst);
  await fs.chmod(dst, 0o755);
  const stat = await fs.stat(dst);
  console.log(`  Copied ${path.basename(src)} → ${dst} (${Math.round(stat.size / 1024)} KB)`);
}

async function main() {
  if (await vendorAlreadyComplete()) {
    console.log(`[7zip-macos] vendor/7zip/${PLATFORM_DIR}/ is already complete.`);
    process.exit(0);
  }

  await installViaBrewIfNeeded();
  await copyBinary();
  console.log(`\n[7zip-macos] Done. 7z binary placed in vendor/7zip/${PLATFORM_DIR}/`);
}

main().catch((err) => {
  console.error("[7zip-macos] Fatal:", err);
  process.exit(1);
});
