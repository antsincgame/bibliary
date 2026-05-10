#!/usr/bin/env node
/**
 * scripts/diagnose-test-hang.cjs
 *
 * Запускает каждый файл из tests/*.test.ts ОТДЕЛЬНО с таймаутом 60 секунд.
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
 *   tests/hangy.test.ts: TIMEOUT after 60s ← кандидат
 *
 * Exit code:
 *   0 — все файлы PASS
 *   1 — есть FAIL (но нет TIMEOUT)
 *   2 — есть TIMEOUT (root cause hang'а)
 *
 * Output flush'ится после каждой строки чтобы GitHub Actions UI показывал
 * прогресс в реальном времени (без этого stdout буферизуется до конца).
 */

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const TESTS_DIR = path.join(__dirname, "..", "tests");
const TIMEOUT_MS = 60_000;

const files = fs
  .readdirSync(TESTS_DIR)
  .filter((f) => f.endsWith(".test.ts"))
  .map((f) => path.join("tests", f))
  .sort();

/* Принудительный flush для каждого console.log */
function log(msg) {
  process.stdout.write(msg + "\n");
}

log(`Diagnosing ${files.length} test files with ${TIMEOUT_MS / 1000}s timeout each…`);
log("");

const results = [];

(async () => {
  let idx = 0;
  for (const file of files) {
    idx++;
    const start = Date.now();
    const result = await runOne(file);
    const dur = ((Date.now() - start) / 1000).toFixed(1);
    const tag = result.timedOut
      ? "TIMEOUT"
      : result.exitCode === 0
        ? "PASS   "
        : "FAIL   ";
    log(`[${idx.toString().padStart(2)}/${files.length}] ${tag} ${file.padEnd(60)} ${dur}s${result.exitCode !== null ? ` exit=${result.exitCode}` : ""}`);
    results.push({ file, ...result, durationSec: parseFloat(dur) });
  }

  /* Summary */
  log("");
  log("──── summary ────");
  const timeouts = results.filter((r) => r.timedOut);
  const fails = results.filter((r) => !r.timedOut && r.exitCode !== 0);
  const passes = results.filter((r) => !r.timedOut && r.exitCode === 0);
  log(`pass:    ${passes.length}`);
  log(`fail:    ${fails.length}`);
  log(`timeout: ${timeouts.length}`);
  if (timeouts.length > 0) {
    log("");
    log("TIMEOUT files (ROOT CAUSE of CI hang):");
    for (const t of timeouts) log(`  ${t.file} (${t.durationSec}s)`);
  }
  if (fails.length > 0) {
    log("");
    log("FAIL files:");
    for (const f of fails) log(`  ${f.file} (exit ${f.exitCode}, ${f.durationSec}s)`);
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
      try { child.kill("SIGKILL"); } catch { /* tolerate */ }
      resolve({ exitCode: null, timedOut: true });
    }, TIMEOUT_MS);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, timedOut: false });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ exitCode: null, timedOut: false, spawnError: err.message });
    });
  });
}
