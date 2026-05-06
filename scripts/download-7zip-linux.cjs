#!/usr/bin/env node
/**
 * scripts/download-7zip-linux.cjs
 *
 * Копирует 7z CLI binary в vendor/7zip/linux-<arch>/ из системной установки
 * p7zip (apt-get install p7zip-full). Если бинарь не найден — пытается
 * установить через apt-get (нужны sudo + интернет).
 *
 * Usage:
 *   npm run setup:7zip-linux
 *
 * После запуска можно собирать:
 *   npm run electron:build-linux
 *
 * NOTE: на Linux app также падает обратно на системный "7z" в PATH
 * (см. archive-extractor.ts). Vendor-копия гарантирует независимость
 * от user-PATH в packaged-сборке.
 */

"use strict";

const { spawnSync } = require("child_process");
const { promises: fs, existsSync } = require("fs");
const path = require("path");
const os = require("os");

if (process.platform !== "linux") {
  console.log("[7zip-linux] This script is Linux-only.");
  process.exit(0);
}

const arch = os.arch() === "arm64" ? "arm64" : "x64";
const PLATFORM_DIR = `linux-${arch}`;
const ROOT = path.resolve(__dirname, "..");
const VENDOR_DIR = path.join(ROOT, "vendor", "7zip", PLATFORM_DIR);

/* p7zip-full ставит и `7z`, и `7za`. На Debian/Ubuntu бинарь — `/usr/bin/7z`. */
const SYSTEM_BIN_CANDIDATES = [
  ["/usr/bin/7z",       "7z"],
  ["/usr/local/bin/7z", "7z"],
  ["/usr/bin/7zz",      "7z"],
  ["/usr/local/bin/7zz", "7z"],
];

function findSystemBinary() {
  for (const [src, dstName] of SYSTEM_BIN_CANDIDATES) {
    if (existsSync(src)) return { src, dstName };
  }
  return null;
}

async function vendorAlreadyComplete() {
  return existsSync(path.join(VENDOR_DIR, "7z"));
}

function aptInstall() {
  console.log("[7zip-linux] p7zip-full not found — installing via apt-get...");
  const cmd = process.getuid && process.getuid() === 0 ? "apt-get" : "sudo";
  const args = process.getuid && process.getuid() === 0
    ? ["install", "-y", "p7zip-full"]
    : ["apt-get", "install", "-y", "p7zip-full"];
  const res = spawnSync(cmd, args, { stdio: "inherit" });
  if (res.status !== 0) {
    console.error("[7zip-linux] apt-get install failed. Установите вручную: sudo apt-get install -y p7zip-full");
    process.exit(1);
  }
  console.log("[7zip-linux] apt-get install completed.");
}

async function copyBinary() {
  const found = findSystemBinary();
  if (!found) {
    console.error("[7zip-linux] 7z binary not found after installation.");
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
    console.log(`[7zip-linux] vendor/7zip/${PLATFORM_DIR}/ is already complete.`);
    process.exit(0);
  }

  if (!findSystemBinary()) aptInstall();
  await copyBinary();
  console.log(`\n[7zip-linux] Done. 7z binary placed in vendor/7zip/${PLATFORM_DIR}/`);
}

main().catch((err) => {
  console.error("[7zip-linux] Fatal:", err);
  process.exit(1);
});
