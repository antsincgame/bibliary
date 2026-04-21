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
