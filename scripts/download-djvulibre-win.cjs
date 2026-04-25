#!/usr/bin/env node
/**
 * scripts/download-djvulibre-win.cjs
 *
 * Downloads DjVuLibre Windows binaries and places them in:
 *   vendor/djvulibre/win32-x64/
 *
 * Strategy:
 *  1. If winget is available → install DjVuLibre.DjView silently,
 *     then copy CLI tools + required DLLs to vendor dir.
 *  2. If the system install already exists → just copy from there.
 *
 * Usage:
 *   node scripts/download-djvulibre-win.cjs
 *
 * After running, rebuild the portable:
 *   npm run build:portable
 */

"use strict";

const { execSync, spawnSync } = require("child_process");
const { promises: fs, existsSync } = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const VENDOR_DIR = path.join(ROOT, "vendor", "djvulibre", "win32-x64");

const NEEDED_FILES = [
  "djvutxt.exe",
  "ddjvu.exe",
  "djvused.exe",
  "libdjvulibre.dll",
  "libjpeg.dll",
  "libtiff.dll",
  "libz.dll",
];

const SYSTEM_CANDIDATES = [
  "C:\\Program Files (x86)\\DjVuLibre",
  "C:\\Program Files\\DjVuLibre",
  "C:\\Program Files (x86)\\DjView",
  "C:\\Program Files\\DjView",
];

async function findSystemInstall() {
  for (const dir of SYSTEM_CANDIDATES) {
    const probe = path.join(dir, "djvutxt.exe");
    if (existsSync(probe)) {
      console.log(`[djvulibre] Found system install at: ${dir}`);
      return dir;
    }
  }
  return null;
}

async function copyFromDir(srcDir) {
  await fs.mkdir(VENDOR_DIR, { recursive: true });
  let copied = 0;
  for (const file of NEEDED_FILES) {
    const src = path.join(srcDir, file);
    const dst = path.join(VENDOR_DIR, file);
    if (existsSync(src)) {
      await fs.copyFile(src, dst);
      const stat = await fs.stat(dst);
      console.log(`  Copied ${file} (${Math.round(stat.size / 1024)} KB)`);
      copied++;
    } else {
      console.warn(`  WARNING: ${file} not found in ${srcDir}`);
    }
  }
  return copied;
}

async function installViaWinget() {
  console.log("[djvulibre] Installing DjVuLibre via winget...");
  const res = spawnSync(
    "winget",
    [
      "install",
      "DjVuLibre.DjView",
      "--silent",
      "--accept-package-agreements",
      "--accept-source-agreements",
    ],
    { stdio: "inherit", shell: true }
  );
  if (res.status !== 0) {
    throw new Error(`winget install failed with code ${res.status}`);
  }
  console.log("[djvulibre] winget install completed.");
}

async function vendorAlreadyComplete() {
  for (const file of NEEDED_FILES) {
    if (!existsSync(path.join(VENDOR_DIR, file))) return false;
  }
  return true;
}

async function main() {
  if (process.platform !== "win32") {
    console.log("[djvulibre] This script is Windows-only. On Linux/macOS, install djvulibre via package manager.");
    process.exit(0);
  }

  if (await vendorAlreadyComplete()) {
    console.log("[djvulibre] vendor/djvulibre/win32-x64/ is already complete. Nothing to do.");
    process.exit(0);
  }

  let srcDir = await findSystemInstall();

  if (!srcDir) {
    try {
      await installViaWinget();
      srcDir = await findSystemInstall();
    } catch (err) {
      console.error("[djvulibre] winget not available or install failed:", err.message);
      console.error("Manual fallback: install DjVuLibre from https://sourceforge.net/projects/djvu/files/DjVuLibre_Windows/");
      console.error("Then re-run this script.");
      process.exit(1);
    }
  }

  if (!srcDir) {
    console.error("[djvulibre] Could not locate DjVuLibre after install. Check installation manually.");
    process.exit(1);
  }

  const count = await copyFromDir(srcDir);
  console.log(`\n[djvulibre] Done. Copied ${count}/${NEEDED_FILES.length} files to vendor/djvulibre/win32-x64/`);

  if (count < NEEDED_FILES.length) {
    console.warn("[djvulibre] Some files are missing. DJVU support may be incomplete.");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[djvulibre] Fatal error:", err);
  process.exit(1);
});
