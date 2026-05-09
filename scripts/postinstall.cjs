#!/usr/bin/env node
/**
 * Cross-platform postinstall wrapper.
 *
 * Заменяет Windows-only npm script `... 2>nul || echo "..."` который ломался
 * на macOS/Linux (там 2>nul создаёт файл `nul` вместо подавления stderr).
 *
 * Шаги:
 *   1. fix-edgeparse-native — раскладывает edgeparse .node binary в
 *      ожидаемое место node_modules (cross-platform).
 *   2. @electron/rebuild --only better-sqlite3 — пересборка native под
 *      Electron ABI. Если @electron/rebuild не установлен (legacy non-Electron
 *      use) или падает — это не блокирует install: для node:test better-sqlite3
 *      потом будет пересобран через scripts/ensure-sqlite-abi.cjs.
 */
"use strict";

const { spawnSync } = require("node:child_process");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { stdio: "inherit", cwd: ROOT, shell: false, ...opts });
  return res.status ?? 1;
}

/* Step 1 — обязательный, должен пройти. */
const edgeparseStatus = run(process.execPath, [path.join("scripts", "fix-edgeparse-native.cjs")]);
if (edgeparseStatus !== 0) {
  console.error("[postinstall] fix-edgeparse-native failed (status=" + edgeparseStatus + ")");
  process.exit(edgeparseStatus);
}

/* Step 2 — best-effort. На non-Electron окружениях @electron/rebuild
 *           может не быть установлен, или native компилятор недоступен —
 *           это OK для CLI-юзеров. Electron build требует rebuild явно
 *           через `npm run electron:build*`. */
const npxCmd = process.platform === "win32" ? "npx.cmd" : "npx";
const rebuildStatus = run(npxCmd, ["@electron/rebuild", "--only", "better-sqlite3", "--force"], {
  shell: process.platform === "win32",
});
if (rebuildStatus !== 0) {
  console.log("[postinstall] @electron/rebuild skipped или упал — для Electron-сборки запустите вручную: npx @electron/rebuild --only better-sqlite3 --force");
}

/* Step 3 — vendor binaries autosetup (best-effort).
 *           На macOS пытаемся подложить 7zip + DjVuLibre в vendor/darwin-<arch>/
 *           через Homebrew, если их там ещё нет. Падение этого шага НЕ ломает
 *           install: пользователь сможет дозапустить `npm run setup:*-macos`
 *           вручную, либо приложение работает на системных утилитах из PATH.
 *           Windows: vendor binaries закоммичены в репо, autosetup не нужен.
 *
 *           Skip via env: `BIBLIARY_SKIP_VENDOR_AUTOSETUP=1 npm install`. */
if (process.env.BIBLIARY_SKIP_VENDOR_AUTOSETUP !== "1") {
  const platform = process.platform;
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const vendorDir = `${platform}-${arch}`;
  const have7z = require("node:fs").existsSync(
    require("node:path").join(ROOT, "vendor", "7zip", vendorDir, platform === "win32" ? "7z.exe" : "7z")
  );
  if (platform === "darwin" && !have7z) {
    console.log("[postinstall] Auto-running macOS vendor setup (best-effort)...");
    run(process.execPath, [require("node:path").join("scripts", "download-7zip-macos.cjs")]);
    run(process.execPath, [require("node:path").join("scripts", "download-djvulibre-macos.cjs")]);
  }
  /* Linux/other platforms: dev-режим работает но vendor binaries не
     устанавливаются автоматически. Production билды только Win+macOS. */
}

/* Step 4 — Tesseract.js tessdata (rus/ukr/eng) autodownload.
 *           Cross-platform: bundled при первом install через postinstall, чтобы
 *           Tier-1a OCR работал из коробки на любой платформе. ~12 MB total.
 *           Idempotent — если файлы уже есть, скрипт делает noop.
 *           Best-effort: на закрытых сетях / corporate proxy скачивание может
 *           провалиться; пользователь дозапустит `npm run setup:tessdata`
 *           вручную (или OCR cascade fallback на system OCR / vision-LLM).
 *
 *           Skip via env: `BIBLIARY_SKIP_VENDOR_AUTOSETUP=1 npm install`. */
if (process.env.BIBLIARY_SKIP_VENDOR_AUTOSETUP !== "1") {
  const tessRus = require("node:path").join(ROOT, "vendor", "tessdata", "rus.traineddata");
  if (!require("node:fs").existsSync(tessRus)) {
    console.log("[postinstall] Downloading Tesseract tessdata (best-effort)...");
    const tessStatus = run(process.execPath, [require("node:path").join("scripts", "download-tessdata.cjs")]);
    if (tessStatus !== 0) {
      console.log("[postinstall] tessdata download failed — run 'npm run setup:tessdata' manually before electron:build");
    }
  }
}

process.exit(0);
