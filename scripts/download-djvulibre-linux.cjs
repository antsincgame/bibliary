#!/usr/bin/env node
/**
 * scripts/download-djvulibre-linux.cjs
 *
 * Готовит `vendor/djvulibre/linux-x64/` с CLI-утилитами djvulibre и
 * необходимыми shared-libraries для портативной работы внутри AppImage / .deb.
 *
 * Стратегия:
 *  1. Если уже установлено системно (`which djvused`) → копируем из /usr/bin
 *     + находим линкуемые .so через ldd и кладём рядом.
 *  2. Если не установлено → подсказываем `apt-get install djvulibre-bin`,
 *     не пытаемся ставить сами (нужны права root, а скрипт может запускаться
 *     обычным пользователем в CI или при ручной сборке).
 *
 * Usage (Linux only):
 *   node scripts/download-djvulibre-linux.cjs
 *
 * After running, build the portable:
 *   npm run electron:build-portable
 */

"use strict";

const { execFileSync } = require("child_process");
const { promises: fs, existsSync } = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const VENDOR_DIR = path.join(ROOT, "vendor", "djvulibre", "linux-x64");

/* Базовый набор CLI: тот же что и на Win, но без .exe. Дополнительные .so
   подбираются через ldd на лету — версии libjpeg/libtiff отличаются между
   Ubuntu LTS, поэтому статический список захардкодить нельзя. */
const NEEDED_BINARIES = ["djvused", "djvutxt", "ddjvu"];

/* Shared libraries, которые могут не быть в типичном Linux desktop:
   проверяем после копирования бинарей и линкуем рядом если ldd их находит. */
const OPTIONAL_LIB_HINTS = [
  /libdjvulibre/i,
  /libjpeg/i,
  /libtiff/i,
  /libz/i,
];

function which(bin) {
  try {
    return execFileSync("which", [bin], { encoding: "utf-8" }).trim() || null;
  } catch { return null; }
}

function ldd(bin) {
  try {
    const out = execFileSync("ldd", [bin], { encoding: "utf-8" });
    /** @type {Array<{name: string, path: string}>} */
    const libs = [];
    for (const line of out.split("\n")) {
      /* Format examples:
         libdjvulibre.so.21 => /usr/lib/x86_64-linux-gnu/libdjvulibre.so.21 (0x...)
         linux-vdso.so.1 (0x...) */
      const m = line.match(/^\s*(\S+)\s*=>\s*(\S+)\s*\(/);
      if (m && m[2] !== "not" && existsSync(m[2])) {
        libs.push({ name: m[1], path: m[2] });
      }
    }
    return libs;
  } catch { return []; }
}

async function copyBinary(src, dstDir) {
  const dst = path.join(dstDir, path.basename(src));
  await fs.copyFile(src, dst);
  await fs.chmod(dst, 0o755);
  const stat = await fs.stat(dst);
  console.log(`  Copied ${path.basename(src)} (${Math.round(stat.size / 1024)} KB)`);
  return dst;
}

async function vendorAlreadyComplete() {
  for (const bin of NEEDED_BINARIES) {
    if (!existsSync(path.join(VENDOR_DIR, bin))) return false;
  }
  return true;
}

async function main() {
  if (process.platform !== "linux") {
    console.log("[djvulibre-linux] This script targets linux. Skipping.");
    process.exit(0);
  }

  if (await vendorAlreadyComplete()) {
    console.log("[djvulibre-linux] vendor/djvulibre/linux-x64/ is already complete. Nothing to do.");
    process.exit(0);
  }

  /* Поиск системных бинарей */
  const found = {};
  for (const bin of NEEDED_BINARIES) {
    const p = which(bin);
    if (!p) {
      console.error(`[djvulibre-linux] '${bin}' not found in PATH.`);
      console.error("  Install with: sudo apt-get install -y djvulibre-bin");
      console.error("  Or on rpm-distros: sudo dnf install -y djvulibre");
      process.exit(1);
    }
    found[bin] = p;
  }

  await fs.mkdir(VENDOR_DIR, { recursive: true });

  /* Копируем бинари + собираем shared-deps */
  const allLibsToBundle = new Map();
  for (const [_bin, srcPath] of Object.entries(found)) {
    await copyBinary(srcPath, VENDOR_DIR);
    for (const lib of ldd(srcPath)) {
      if (OPTIONAL_LIB_HINTS.some((re) => re.test(lib.name))) {
        allLibsToBundle.set(lib.name, lib.path);
      }
    }
  }

  /* Bundling shared libs — делает приложение независимым от системного
     djvulibre на target-машине. Для AppImage это критично: пользователь
     может запустить .AppImage на дистрибутиве без apt-устаревших пакетов. */
  if (allLibsToBundle.size > 0) {
    console.log(`[djvulibre-linux] Bundling ${allLibsToBundle.size} shared libraries:`);
    for (const [name, srcPath] of allLibsToBundle.entries()) {
      const dst = path.join(VENDOR_DIR, name);
      try {
        await fs.copyFile(srcPath, dst);
        const stat = await fs.stat(dst);
        console.log(`  Bundled ${name} (${Math.round(stat.size / 1024)} KB) ← ${srcPath}`);
      } catch (err) {
        console.warn(`  WARNING: failed to bundle ${name}: ${err.message}`);
      }
    }
  }

  console.log(
    `\n[djvulibre-linux] Done. Bundled ${NEEDED_BINARIES.length} binaries + ` +
    `${allLibsToBundle.size} shared libs to vendor/djvulibre/linux-x64/`
  );
}

main().catch((err) => {
  console.error("[djvulibre-linux] Fatal error:", err);
  process.exit(1);
});
