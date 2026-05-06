#!/usr/bin/env node
/**
 * scripts/download-djvulibre-macos.cjs
 *
 * Copies DjVuLibre CLI binaries into vendor/djvulibre/darwin-<arch>/
 * from a Homebrew installation. Falls back to building from source
 * via brew if not already installed.
 *
 * Usage:
 *   npm run setup:djvulibre-macos
 *
 * After running, rebuild:
 *   npm run electron:build
 *
 * NOTE: The primary DjVu path is now the pure-JS djvu-native.ts adapter
 * (vendor/djvu/djvu.js). CLI binaries are a graceful fallback only.
 */

"use strict";

const { execSync, spawnSync } = require("child_process");
const { promises: fs, existsSync } = require("fs");
const path = require("path");
const os = require("os");

if (process.platform !== "darwin") {
  console.log("[djvulibre-macos] This script is macOS-only.");
  process.exit(0);
}

const arch = os.arch() === "arm64" ? "arm64" : "x64";
const PLATFORM_DIR = `darwin-${arch}`;
const ROOT = path.resolve(__dirname, "..");
const VENDOR_DIR = path.join(ROOT, "vendor", "djvulibre", PLATFORM_DIR);

const NEEDED_BINS = ["djvutxt", "ddjvu", "djvused"];

const BREW_CANDIDATES = [
  "/opt/homebrew/bin",   // Apple Silicon
  "/usr/local/bin",      // Intel
];

function findBrewBin(name) {
  for (const dir of BREW_CANDIDATES) {
    const full = path.join(dir, name);
    if (existsSync(full)) return full;
  }
  return null;
}

async function vendorAlreadyComplete() {
  return NEEDED_BINS.every((b) => existsSync(path.join(VENDOR_DIR, b)));
}

async function installViaBrewIfNeeded() {
  const probe = findBrewBin("djvutxt");
  if (probe) {
    console.log(`[djvulibre-macos] Found djvulibre at ${path.dirname(probe)}`);
    return;
  }
  console.log("[djvulibre-macos] djvulibre not found — installing via brew...");
  const res = spawnSync("brew", ["install", "djvulibre"], { stdio: "inherit" });
  if (res.status !== 0) {
    console.error("[djvulibre-macos] brew install failed. Install manually: brew install djvulibre");
    process.exit(1);
  }
  console.log("[djvulibre-macos] brew install completed.");
}

async function copyBinaries() {
  await fs.mkdir(VENDOR_DIR, { recursive: true });
  let copied = 0;
  for (const bin of NEEDED_BINS) {
    const src = findBrewBin(bin);
    if (!src) {
      console.warn(`  WARNING: ${bin} not found after installation`);
      continue;
    }
    const dst = path.join(VENDOR_DIR, bin);
    await fs.copyFile(src, dst);
    // Ensure executable bit is preserved
    await fs.chmod(dst, 0o755);
    const stat = await fs.stat(dst);
    console.log(`  Copied ${bin} (${Math.round(stat.size / 1024)} KB) → ${dst}`);
    copied++;
  }
  return copied;
}

async function main() {
  if (await vendorAlreadyComplete()) {
    console.log(`[djvulibre-macos] vendor/djvulibre/${PLATFORM_DIR}/ is already complete.`);
    process.exit(0);
  }

  await installViaBrewIfNeeded();
  const count = await copyBinaries();
  console.log(`\n[djvulibre-macos] Done. Copied ${count}/${NEEDED_BINS.length} binaries to vendor/djvulibre/${PLATFORM_DIR}/`);

  if (count < NEEDED_BINS.length) {
    console.warn("[djvulibre-macos] Some binaries missing — DjVu CLI fallback may be incomplete.");
    console.warn("  Primary path (pure-JS via vendor/djvu/djvu.js) should still work.");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[djvulibre-macos] Fatal:", err);
  process.exit(1);
});
