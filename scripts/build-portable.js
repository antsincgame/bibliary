#!/usr/bin/env node
/**
 * Portable build wrapper.
 * - Если задан BIBLIARY_BUILD_OUT — передаём в electron-builder как override output.
 * - Иначе — используем default из electron-builder.yml ("release").
 *
 * Зачем: проект может лежать в OneDrive, где cloud-sync блокирует app.asar.
 * Тогда выставляйте BIBLIARY_BUILD_OUT=C:\Temp\bibliary-build перед командой.
 */

import { spawnSync } from "child_process";

import fs from "fs";
import path from "path";

/* ── Step 1: Rebuild better-sqlite3 for Electron and stash the binary ──
   electron-builder's @electron/rebuild downloads wrong prebuilt (Node ABI
   instead of Electron ABI). We rebuild from source, save the binary to
   a stash directory, and the afterPack hook copies it into the output.

   Stash имена:
     - better_sqlite3.node          (legacy, ожидаемое afterPack.js)
     - better_sqlite3.electron.node (новое, для ensure-sqlite-abi.cjs)
   Маркер `.abi-marker` рядом с live помогает скрипту переключения
   быстро понять текущую ABI. */
console.log("[build-portable] Rebuilding better-sqlite3 for Electron (from source)...");
const rebuildResult = spawnSync("npx", [
  "@electron/rebuild",
  "--only", "better-sqlite3",
  "--force",
  "--build-from-source",
], {
  stdio: "inherit",
  shell: true,
});
if (rebuildResult.status !== 0) {
  console.error("[build-portable] @electron/rebuild failed for better-sqlite3");
  process.exit(1);
}

const stashDir = path.resolve(".electron-rebuild-stash");
fs.mkdirSync(stashDir, { recursive: true });
const srcBin = path.resolve("node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node");
const stashLegacy = path.join(stashDir, "better_sqlite3.node");
const stashElectron = path.join(stashDir, "better_sqlite3.electron.node");
fs.copyFileSync(srcBin, stashLegacy);
fs.copyFileSync(srcBin, stashElectron);
const sizeBytes = fs.statSync(stashElectron).size;
console.log(`[build-portable] Stashed Electron-ABI binary → ${stashLegacy} (${sizeBytes} bytes)`);
console.log(`[build-portable] Stashed Electron-ABI binary → ${stashElectron} (${sizeBytes} bytes)`);

const marker = srcBin + ".abi-marker";
try { fs.writeFileSync(marker, "electron"); }
catch (e) { console.warn("[build-portable] failed to write abi-marker:", e.message); }

/* ── Step 2: Run electron-builder ─────────────────────────────────────
   Windows-only portable build target.
   Override via env: BIBLIARY_BUILD_TARGET="--win nsis" */
const out = process.env.BIBLIARY_BUILD_OUT?.trim();
const targetOverride = process.env.BIBLIARY_BUILD_TARGET?.trim();
let targetArgs;
if (targetOverride) {
  targetArgs = targetOverride.split(/\s+/);
  console.log(`[build-portable] target override: ${targetOverride}`);
} else if (process.platform === "win32") {
  targetArgs = ["--win", "portable"];
} else {
  console.error(`[build-portable] unsupported platform: ${process.platform}. Only win32 is supported.`);
  process.exit(1);
}
const args = ["electron-builder", ...targetArgs];
if (out) {
  args.push(`--config.directories.output=${out}`);
  console.log(`[build-portable] output override: ${out}`);
} else {
  console.log(`[build-portable] output: release/ (default)`);
}

const result = spawnSync("npx", args, {
  stdio: "inherit",
  shell: true,
});
process.exit(result.status ?? 1);
