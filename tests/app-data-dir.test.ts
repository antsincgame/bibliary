import test from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { resolveAppDataDir } from "../electron/lib/app-data-dir.js";

const devBaseDir = path.join("D:", "projects", "bibliary", "dist-electron");
const tempChildExe = path.join("C:", "Users", "User", "AppData", "Local", "Temp", "portable-x", "Bibliary.exe");
const outerPortableExe = path.join("D:", "projects", "bibliary", "release", "dist-portable", "Bibliary 3.0.0.exe");

test("resolveAppDataDir: BIBLIARY_DATA_DIR has highest priority", () => {
  const dataDir = path.join("D:", "custom", "bibliary-data");
  assert.equal(
    resolveAppDataDir({
      env: { BIBLIARY_DATA_DIR: dataDir },
      isPackaged: true,
      execPath: tempChildExe,
      appName: "Bibliary",
      devBaseDir,
      platform: "win32",
      parentExecutablePath: outerPortableExe,
    }),
    path.resolve(dataDir),
  );
});

test("resolveAppDataDir: electron-builder portable env points at outer exe directory", () => {
  assert.equal(
    resolveAppDataDir({
      env: { PORTABLE_EXECUTABLE_FILE: outerPortableExe },
      isPackaged: true,
      execPath: tempChildExe,
      appName: "Bibliary",
      devBaseDir,
      platform: "win32",
    }),
    path.join(path.dirname(path.resolve(outerPortableExe)), "data"),
  );
});

test("resolveAppDataDir: Windows portable fallback uses same-app parent wrapper", () => {
  assert.equal(
    resolveAppDataDir({
      env: {},
      isPackaged: true,
      execPath: tempChildExe,
      appName: "Bibliary",
      devBaseDir,
      platform: "win32",
      parentExecutablePath: outerPortableExe,
    }),
    path.join(path.dirname(path.resolve(outerPortableExe)), "data"),
  );
});

test("resolveAppDataDir: unrelated parent process is ignored", () => {
  assert.equal(
    resolveAppDataDir({
      env: {},
      isPackaged: true,
      execPath: tempChildExe,
      appName: "Bibliary",
      devBaseDir,
      platform: "win32",
      parentExecutablePath: path.join("C:", "Windows", "explorer.exe"),
    }),
    path.join(path.dirname(tempChildExe), "data"),
  );
});

test("resolveAppDataDir: development fallback stays at project data directory", () => {
  assert.equal(
    resolveAppDataDir({
      env: {},
      isPackaged: false,
      execPath: path.join("D:", "projects", "bibliary", "node_modules", ".bin", "electron.exe"),
      appName: "Bibliary",
      devBaseDir,
      platform: "win32",
    }),
    path.resolve(devBaseDir, "..", "data"),
  );
});

test("resolveAppDataDir: macOS packaged uses userDataPath (not .app bundle)", () => {
  const macExec = "/Applications/Bibliary.app/Contents/MacOS/Bibliary";
  const userDataPath = "/Users/user/Library/Application Support/Bibliary";
  assert.equal(
    resolveAppDataDir({
      env: {},
      isPackaged: true,
      execPath: macExec,
      appName: "Bibliary",
      devBaseDir,
      platform: "darwin",
      userDataPath,
    }),
    path.join(userDataPath, "data"),
  );
});

test("resolveAppDataDir: macOS packaged without userDataPath falls back to execPath dir", () => {
  const macExec = "/Applications/Bibliary.app/Contents/MacOS/Bibliary";
  assert.equal(
    resolveAppDataDir({
      env: {},
      isPackaged: true,
      execPath: macExec,
      appName: "Bibliary",
      devBaseDir,
      platform: "darwin",
    }),
    path.join(path.dirname(macExec), "data"),
  );
});

