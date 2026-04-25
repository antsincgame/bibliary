/**
 * electron-builder afterPack hook.
 *
 * Problem: @electron/rebuild downloads a prebuilt better-sqlite3 that targets
 * the wrong Node ABI (127) instead of the Electron ABI (145). It overwrites
 * the binary that our build-portable.js pre-step compiled from source.
 *
 * Fix: build-portable.js stashes the correctly compiled binary in
 * `.electron-rebuild-stash/`. This hook copies it into the packed output,
 * overwriting the wrong prebuilt that @electron/rebuild installed.
 */

import fs from "fs";
import path from "path";

export default async function afterPack(context) {
  const appDir = context.appOutDir;

  const stash = path.resolve(".electron-rebuild-stash", "better_sqlite3.node");
  const dest = path.join(
    appDir, "resources", "app.asar.unpacked",
    "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node",
  );

  if (!fs.existsSync(stash)) {
    console.warn("[afterPack] Stashed better_sqlite3.node not found at", stash);
    console.warn("[afterPack] Run build-portable.js to create it");
    return;
  }

  if (!fs.existsSync(path.dirname(dest))) {
    console.warn("[afterPack] Destination directory does not exist:", path.dirname(dest));
    return;
  }

  fs.copyFileSync(stash, dest);

  const srcStat = fs.statSync(stash);
  const destStat = fs.statSync(dest);
  console.log(`[afterPack] Replaced better_sqlite3.node with Electron-compatible build`);
  console.log(`[afterPack]   stash: ${stash} (${srcStat.size} bytes)`);
  console.log(`[afterPack]   dest:  ${dest} (${destStat.size} bytes)`);
}
