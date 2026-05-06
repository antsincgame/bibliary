/**
 * electron-builder afterPack hook.
 *
 * Problem: @electron/rebuild может скачать prebuilt better-sqlite3 под Node ABI
 * (127) вместо Electron ABI (145), и тогда .dmg/.exe падает при первом open()
 * cache-db с "NODE_MODULE_VERSION mismatch".
 *
 * Fix: ensure-sqlite-abi.cjs / build-portable.js сохраняют корректно собранный
 * binary в `.electron-rebuild-stash/`. Этот hook копирует его в packed output.
 *
 * Stash names (поддерживаем оба ради совместимости):
 *   - better_sqlite3.electron.node  (новое, ensure-sqlite-abi.cjs --save --target=electron)
 *   - better_sqlite3.node           (legacy, build-portable.js)
 *
 * Если stash отсутствует — это normal-case для CI (electron-builder сам делает
 * rebuild через @electron/rebuild). Hook просто пропускается с info-логом.
 */

import fs from "fs";
import path from "path";

const STASH_CANDIDATES = ["better_sqlite3.electron.node", "better_sqlite3.node"];

export default async function afterPack(context) {
  const appDir = context.appOutDir;
  const stashDir = path.resolve(".electron-rebuild-stash");

  let stash = null;
  for (const name of STASH_CANDIDATES) {
    const candidate = path.join(stashDir, name);
    if (fs.existsSync(candidate)) {
      stash = candidate;
      break;
    }
  }

  if (!stash) {
    console.log(
      `[afterPack] No stashed better_sqlite3 binary found in ${stashDir} ` +
        `(checked: ${STASH_CANDIDATES.join(", ")}). ` +
        "Skipping override — electron-builder's @electron/rebuild should have produced a working binary. " +
        "If runtime crashes with 'NODE_MODULE_VERSION mismatch', run: npm run sqlite:save-electron",
    );
    return;
  }

  const dest = path.join(
    appDir, "resources", "app.asar.unpacked",
    "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node",
  );

  if (!fs.existsSync(path.dirname(dest))) {
    console.warn("[afterPack] Destination directory does not exist:", path.dirname(dest));
    return;
  }

  fs.copyFileSync(stash, dest);

  const srcStat = fs.statSync(stash);
  const destStat = fs.statSync(dest);
  console.log(`[afterPack] Replaced better_sqlite3.node with stashed Electron-ABI build`);
  console.log(`[afterPack]   stash: ${stash} (${srcStat.size} bytes)`);
  console.log(`[afterPack]   dest:  ${dest} (${destStat.size} bytes)`);
}
