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
process.exit(0);
