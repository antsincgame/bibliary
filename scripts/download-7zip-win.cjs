#!/usr/bin/env node
/**
 * Copies a real 7-Zip CLI runtime into:
 *   vendor/7zip/win32-x64/
 *
 * RAR/CBR support requires the full 7z.exe + 7z.dll runtime. The standalone
 * 7za binaries from some npm packages are not enough for RAR archives.
 */

"use strict";

const { spawnSync } = require("child_process");
const { promises: fs, existsSync } = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const VENDOR_DIR = path.join(ROOT, "vendor", "7zip", "win32-x64");

const NEEDED_FILES = ["7z.exe", "7z.dll", "License.txt"];

function candidateDirs() {
  const dirs = [
    path.join(process.env.ProgramFiles || "C:\\Program Files", "7-Zip"),
    path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "7-Zip"),
  ];
  const local = process.env.LOCALAPPDATA;
  if (local) dirs.push(path.join(local, "Programs", "7-Zip"));
  return dirs;
}

async function findSystemInstall() {
  for (const dir of candidateDirs()) {
    if (existsSync(path.join(dir, "7z.exe")) && existsSync(path.join(dir, "7z.dll"))) {
      console.log(`[7zip] Found system install at: ${dir}`);
      return dir;
    }
  }
  return null;
}

async function vendorAlreadyComplete() {
  return NEEDED_FILES.every((file) => existsSync(path.join(VENDOR_DIR, file)));
}

async function copyFromDir(srcDir) {
  await fs.mkdir(VENDOR_DIR, { recursive: true });
  let copied = 0;
  for (const file of NEEDED_FILES) {
    const src = path.join(srcDir, file);
    const dst = path.join(VENDOR_DIR, file);
    if (!existsSync(src)) {
      if (file === "License.txt") continue;
      console.warn(`  WARNING: ${file} not found in ${srcDir}`);
      continue;
    }
    await fs.copyFile(src, dst);
    const stat = await fs.stat(dst);
    console.log(`  Copied ${file} (${Math.round(stat.size / 1024)} KB)`);
    copied++;
  }
  return copied;
}

function installViaWinget() {
  console.log("[7zip] Installing 7-Zip via winget...");
  const res = spawnSync(
    "winget",
    [
      "install",
      "7zip.7zip",
      "--silent",
      "--accept-package-agreements",
      "--accept-source-agreements",
    ],
    { stdio: "inherit", shell: true }
  );
  if (res.status !== 0) {
    throw new Error(`winget install failed with code ${res.status}`);
  }
  console.log("[7zip] winget install completed.");
}

async function main() {
  if (process.platform !== "win32") {
    console.log("[7zip] This script is Windows-only. On Linux/macOS, install 7z via package manager.");
    process.exit(0);
  }

  if (await vendorAlreadyComplete()) {
    console.log("[7zip] vendor/7zip/win32-x64/ is already complete. Nothing to do.");
    process.exit(0);
  }

  let srcDir = await findSystemInstall();
  if (!srcDir) {
    try {
      installViaWinget();
      srcDir = await findSystemInstall();
    } catch (err) {
      console.error("[7zip] winget not available or install failed:", err.message);
      console.error("Manual fallback: install 7-Zip from https://www.7-zip.org/download.html");
      console.error("Then re-run: npm run setup:7zip");
      process.exit(1);
    }
  }

  if (!srcDir) {
    console.error("[7zip] Could not locate 7-Zip after install. Check installation manually.");
    process.exit(1);
  }

  const copied = await copyFromDir(srcDir);
  console.log(`\n[7zip] Done. Copied ${copied}/${NEEDED_FILES.length} files to vendor/7zip/win32-x64/`);

  if (!existsSync(path.join(VENDOR_DIR, "7z.exe")) || !existsSync(path.join(VENDOR_DIR, "7z.dll"))) {
    console.warn("[7zip] Required files are missing. RAR/7z archive import will be incomplete.");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[7zip] Fatal error:", err);
  process.exit(1);
});
