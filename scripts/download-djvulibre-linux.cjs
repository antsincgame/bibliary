#!/usr/bin/env node
/**
 * scripts/download-djvulibre-linux.cjs
 *
 * Копирует CLI-бинари DjVuLibre (djvutxt, ddjvu, djvused) в
 * vendor/djvulibre/linux-<arch>/ из системной установки. Если не найдены,
 * пытается установить через apt-get install djvulibre-bin (нужны sudo +
 * интернет).
 *
 * Usage:
 *   npm run setup:djvulibre-linux
 *
 * NOTE: основной путь чтения DjVu — pure-JS adapter (vendor/djvu/djvu.js).
 * CLI-бинари — graceful fallback на случай ошибок native-парсера.
 */

"use strict";

const { spawnSync } = require("child_process");
const { promises: fs, existsSync } = require("fs");
const path = require("path");
const os = require("os");

if (process.platform !== "linux") {
  console.log("[djvulibre-linux] This script is Linux-only.");
  process.exit(0);
}

const arch = os.arch() === "arm64" ? "arm64" : "x64";
const PLATFORM_DIR = `linux-${arch}`;
const ROOT = path.resolve(__dirname, "..");
const VENDOR_DIR = path.join(ROOT, "vendor", "djvulibre", PLATFORM_DIR);

const NEEDED_BINS = ["djvutxt", "ddjvu", "djvused"];
const SYSTEM_BIN_DIRS = ["/usr/bin", "/usr/local/bin"];

function findSystemBin(name) {
  for (const dir of SYSTEM_BIN_DIRS) {
    const full = path.join(dir, name);
    if (existsSync(full)) return full;
  }
  return null;
}

async function vendorAlreadyComplete() {
  return NEEDED_BINS.every((b) => existsSync(path.join(VENDOR_DIR, b)));
}

function aptInstall() {
  console.log("[djvulibre-linux] djvulibre-bin not found — installing via apt-get...");
  const isRoot = process.getuid && process.getuid() === 0;
  const cmd = isRoot ? "apt-get" : "sudo";
  const args = isRoot ? ["install", "-y", "djvulibre-bin"] : ["apt-get", "install", "-y", "djvulibre-bin"];
  const res = spawnSync(cmd, args, { stdio: "inherit" });
  if (res.status !== 0) {
    console.error("[djvulibre-linux] apt-get install failed. Установите вручную: sudo apt-get install -y djvulibre-bin");
    process.exit(1);
  }
  console.log("[djvulibre-linux] apt-get install completed.");
}

async function copyBinaries() {
  await fs.mkdir(VENDOR_DIR, { recursive: true });
  let copied = 0;
  for (const bin of NEEDED_BINS) {
    const src = findSystemBin(bin);
    if (!src) {
      console.warn(`  WARNING: ${bin} not found after installation`);
      continue;
    }
    const dst = path.join(VENDOR_DIR, bin);
    await fs.copyFile(src, dst);
    await fs.chmod(dst, 0o755);
    const stat = await fs.stat(dst);
    console.log(`  Copied ${bin} (${Math.round(stat.size / 1024)} KB) → ${dst}`);
    copied++;
  }
  return copied;
}

async function main() {
  if (await vendorAlreadyComplete()) {
    console.log(`[djvulibre-linux] vendor/djvulibre/${PLATFORM_DIR}/ is already complete.`);
    process.exit(0);
  }

  if (!findSystemBin("djvutxt")) aptInstall();
  const count = await copyBinaries();
  console.log(`\n[djvulibre-linux] Done. Copied ${count}/${NEEDED_BINS.length} binaries.`);

  if (count < NEEDED_BINS.length) {
    console.warn("[djvulibre-linux] Some binaries missing — DjVu CLI fallback may be incomplete.");
    console.warn("  Primary path (pure-JS via vendor/djvu/djvu.js) should still work.");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[djvulibre-linux] Fatal:", err);
  process.exit(1);
});
