#!/usr/bin/env node
/**
 * Проверки перед electron-builder / portable:
 *   1) Корень package-lock.json ↔ package.json (dependencies / dev / optional)
 *   2) npm ls --depth=0 — целостность дерева node_modules
 *   3) knip --production — импорты из production-кода без записи в package.json
 *
 * Запуск: node scripts/verify-deps-for-packaging.cjs
 *         npm run verify:deps-for-packaging
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const PKG_PATH = path.join(ROOT, "package.json");
const LOCK_PATH = path.join(ROOT, "package-lock.json");

const PREFIX = "[verify-deps-for-packaging]";

/** @param {Record<string, unknown> | undefined} obj */
function depKeys(obj) {
  return new Set(Object.keys(obj || {}));
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function verifyLockRootMatchesPackageJson() {
  const pkg = readJson(PKG_PATH);
  const lock = readJson(LOCK_PATH);
  const rootLock = lock.packages && lock.packages[""];
  if (!rootLock) {
    console.error(`${PREFIX} package-lock.json: отсутствует packages[""]`);
    process.exit(1);
  }

  const pkgProd = depKeys(pkg.dependencies);
  const pkgDev = depKeys(pkg.devDependencies);
  const pkgOpt = depKeys(pkg.optionalDependencies);

  const lockProd = depKeys(rootLock.dependencies);
  const lockDev = depKeys(rootLock.devDependencies);
  const lockOpt = depKeys(rootLock.optionalDependencies);

  const errors = [];

  /**
   * @param {string} name
   * @param {Set<string>} fromPkg
   * @param {Set<string>} fromLock
   */
  function compareSection(name, fromPkg, fromLock) {
    const onlyPkg = [...fromPkg].filter((k) => !fromLock.has(k));
    const onlyLock = [...fromLock].filter((k) => !fromPkg.has(k));
    if (onlyPkg.length) {
      errors.push(
        `${name}: есть в package.json, но нет в корне package-lock → ${onlyPkg.join(", ")}`,
      );
    }
    if (onlyLock.length) {
      errors.push(
        `${name}: есть в корне package-lock, но нет в package.json → ${onlyLock.join(", ")}`,
      );
    }
  }

  compareSection("dependencies", pkgProd, lockProd);
  compareSection("devDependencies", pkgDev, lockDev);
  compareSection("optionalDependencies", pkgOpt, lockOpt);

  if (errors.length) {
    console.error(`${PREFIX} рассинхрон package.json и package-lock.json:\n`);
    for (const e of errors) {
      console.error(`  - ${e}`);
    }
    console.error(`\n${PREFIX} выполните: npm install и закоммитьте обновлённый lock.`);
    process.exit(1);
  }

  console.log(`${PREFIX} package.json ↔ package-lock.json (корень) — OK`);
}

function runNpmLs() {
  const r = spawnSync("npm", ["ls", "--depth=0"], {
    cwd: ROOT,
    stdio: "inherit",
    shell: true,
  });
  if (r.status !== 0) {
    console.error(
      `${PREFIX} "npm ls --depth=0" завершился с ошибкой — проверьте node_modules и зависимости.`,
    );
    process.exit(r.status === null ? 1 : r.status);
  }
  console.log(`${PREFIX} npm ls --depth=0 — OK`);
}

function runKnipProductionUnlisted() {
  const r = spawnSync(
    "npm",
    ["exec", "--", "knip", "--no-progress", "--production", "--include", "unlisted,unresolved"],
    {
      cwd: ROOT,
      stdio: "inherit",
      shell: true,
    },
  );
  if (r.status !== 0) {
    console.error(
      `${PREFIX} knip (production, unlisted/unresolved) — есть проблемы. ` +
        "Добавьте недостающие пакеты в dependencies или исправьте импорты.",
    );
    process.exit(r.status === null ? 1 : r.status);
  }
  console.log(`${PREFIX} knip --production (unlisted, unresolved) — OK`);
}

/**
 * Native-binding sanity-check.
 *
 * Проверяет что prebuilt binaries для critical native deps лежат на диске
 * И что Node может их require'нуть без ABI-сюрпризов. Не покрывает Electron
 * ABI mismatch — это умеют только smoke-тесты с реальным electron-runtime.
 *
 * Если @lancedb/lancedb не имеет prebuilt под текущую platform×arch — упадёт
 * именно тут, до начала electron-builder pipeline'а, что экономит ~3 минуты
 * сборки.
 */
function verifyNativeBindings() {
  /* @lancedb/lancedb: napi prebuilds. Загрузка через require — тест что
   * платформенный binary разрешается. Если нет — knip / npm ls этого
   * не поймали бы. */
  const checks = [
    { name: "@lancedb/lancedb", optional: false },
    /* better-sqlite3 проверяется отдельно через ensure-sqlite-abi.cjs */
  ];
  for (const c of checks) {
    try {
      require.resolve(c.name);
      console.log(`${PREFIX} require.resolve("${c.name}") — OK`);
    } catch (e) {
      const msg = `${PREFIX} require.resolve("${c.name}") FAILED: ${e.message}`;
      if (c.optional) {
        console.warn(msg);
      } else {
        console.error(msg);
        console.error(`${PREFIX} prebuilt napi binding для ${c.name} не найден на этой платформе/архитектуре.`);
        console.error(`${PREFIX} попробуйте: npm install ${c.name} --force`);
        process.exit(1);
      }
    }
  }
}

function main() {
  verifyLockRootMatchesPackageJson();
  runNpmLs();
  runKnipProductionUnlisted();
  verifyNativeBindings();
  console.log(`${PREFIX} все проверки пройдены.`);
}

main();
