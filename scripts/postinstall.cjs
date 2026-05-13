#!/usr/bin/env node
/**
 * Postinstall — Node-only since Phase 13b.
 *
 * Pre-13b this wrapper invoked fix-edgeparse-native + @electron/rebuild for
 * better-sqlite3 ABI tuning. With Electron retired, npm install already
 * produces a Node-ABI better-sqlite3 binary; edgeparse layout is handled
 * by its own postinstall.
 *
 * Optional best-effort step: download Tesseract tessdata (rus/ukr/eng,
 * ~12MB) so Tier-1a OCR works out of the box. Skipped with
 *   BIBLIARY_SKIP_VENDOR_AUTOSETUP=1 npm install
 * or when running offline; users can rerun via `npm run setup:tessdata`.
 */
"use strict";

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");

if (process.env.BIBLIARY_SKIP_VENDOR_AUTOSETUP === "1") {
  process.exit(0);
}

const tessRus = path.join(ROOT, "vendor", "tessdata", "rus.traineddata");
if (!fs.existsSync(tessRus)) {
  console.log("[postinstall] Downloading Tesseract tessdata (best-effort)...");
  const status = spawnSync(
    process.execPath,
    [path.join("scripts", "download-tessdata.cjs")],
    { stdio: "inherit", cwd: ROOT, shell: false },
  ).status ?? 1;
  if (status !== 0) {
    console.log(
      "[postinstall] tessdata download failed — run 'npm run setup:tessdata' manually if OCR is needed",
    );
  }
}

process.exit(0);
