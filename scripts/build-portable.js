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
   a stash directory, and the afterPack hook copies it into the output. */
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
const stashBin = path.join(stashDir, "better_sqlite3.node");
fs.copyFileSync(srcBin, stashBin);
console.log(`[build-portable] Stashed Electron-compatible binary → ${stashBin} (${fs.statSync(stashBin).size} bytes)`);

/* ── Step 2: Run electron-builder ───────────────────────────────────── */
const out = process.env.BIBLIARY_BUILD_OUT?.trim();
const args = ["electron-builder", "--win", "portable"];
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
