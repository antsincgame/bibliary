#!/usr/bin/env node
/**
 * scripts/diagnose-test-hang.cjs
 *
 * Запускает каждый файл из tests/*.test.ts ОТДЕЛЬНО с таймаутом 90 секунд.
 * Файл который превысит лимит = источник hang'а в CI Unit tests step.
 *
 * Контекст: после PR #4 + аудит-pack из 12+ коммитов CI Unit tests step
 * висит >25 минут (~720 тестов через node:test + tsx loader). Локально
 * на M1 Mac тесты проходят за ~5 мин (496+ pass / 2 fails), но CI
 * (3-core macos-latest, 4-core windows-latest) либо очень медленный
 * либо один из файлов вешает execution.
 *
 * Запуск:
 *   node scripts/diagnose-test-hang.cjs
 *
 * Output:
 *   tests/foo.test.ts: PASS (3.4s)
 *   tests/bar.test.ts: FAIL (12.1s, exit 1)
 *   tests/hangy.test.ts: TIMEOUT after 90s ← кандидат
 *
 * После идентификации hang-файла — открывай его, смотри какие тесты
 * await'ят promise без timeout, и добавляй { timeout: Nms } аналогично
 * tests/audit-pr5-regressions.test.ts.
 */

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const TESTS_DIR = path.join(__dirname, "..", "tests");
const TIMEOUT_MS = 90_000;

const files = fs
  .readdirSync(TESTS_DIR)
  .filter((f) => f.endsWith(".test.ts"))
  .map((f) => path.join("tests", f))
  .sort();

console.log(`Diagnosing ${files.length} test files with ${TIMEOUT_MS / 1000}s timeout each…\n`);

const results = [];

(async () => {
  for (const file of files) {
    const start = Date.now();
    const result = await runOne(file);
    const dur = ((Date.now() - start) / 1000).toFixed(1);
    const tag = result.timedOut
      ? "\x1b[31mTIMEOUT\x1b[0m"
      : result.exitCode === 0
        ? "\x1b[32mPASS   \x1b[0m"
        : "\x1b[33mFAIL   \x1b[0m";
    console.log(`${tag} ${file.padEnd(60)} ${dur}s${result.exitCode !== null ? ` exit=${result.exitCode}` : ""}`);
    results.push({ file, ...result, durationSec: parseFloat(dur) });
  }

  /* Summary */
  console.log("\n──── summary ────");
  const timeouts = results.filter((r) => r.timedOut);
  const fails = results.filter((r) => !r.timedOut && r.exitCode !== 0);
  const passes = results.filter((r) => !r.timedOut && r.exitCode === 0);
  console.log(`pass:    ${passes.length}`);
  console.log(`fail:    ${fails.length}`);
  console.log(`timeout: ${timeouts.length}`);
  if (timeouts.length > 0) {
    console.log("\nTIMEOUT files (ROOT CAUSE of CI hang):");
    for (const t of timeouts) console.log(`  ${t.file}`);
  }
  if (fails.length > 0) {
    console.log("\nFAIL files:");
    for (const f of fails) console.log(`  ${f.file} (exit ${f.exitCode})`);
  }
  process.exit(timeouts.length > 0 ? 2 : fails.length > 0 ? 1 : 0);
})();

function runOne(file) {
  return new Promise((resolve) => {
    const child = spawn(
      "node",
      ["--import", "tsx", "--test", file],
      { stdio: "ignore" },
    );
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ exitCode: null, timedOut: true });
    }, TIMEOUT_MS);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, timedOut: false });
    });
  });
}
