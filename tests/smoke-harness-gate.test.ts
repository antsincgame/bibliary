/**
 * tests/smoke-harness-gate.test.ts
 *
 * Unit-тесты для applySmokeHarnessGate (security gate из коммитов
 * 987256d/7cdef3d). Контракт: в packaged build env-переменная стирается
 * через delete; в dev mode остаётся нетронутой. Любой регресс этой
 * функции = реальная катастрофа для пользователей packaged build.
 *
 * Покрытие:
 *   - packaged + harness=1 → blocked, env вычищена через delete
 *   - dev + harness=1 → НЕ blocked, env сохраняется
 *   - packaged + harness=0/неустановлена → not-set, env не меняется
 *   - delete (а не "" присвоение) — ключ должен полностью отсутствовать
 *   - logger вызывается с описательным сообщением
 *   - повторный вызов идемпотентен (после блокировки уже nothing to do)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { applySmokeHarnessGate } from "../electron/lib/smoke-harness-gate.ts";

function makeEnv(harness?: string): NodeJS.ProcessEnv {
  /* Создаём чистый mutable env для каждого теста, не заражая process.env. */
  const env: NodeJS.ProcessEnv = {};
  if (harness !== undefined) env.BIBLIARY_SMOKE_UI_HARNESS = harness;
  return env;
}

test("[smoke-gate] packaged + harness=1 → blocked, env cleared via delete", () => {
  const env = makeEnv("1");
  const logs: string[] = [];
  const r = applySmokeHarnessGate({ isPackaged: true, env, log: (m) => logs.push(m) });

  assert.equal(r.blocked, true);
  assert.equal(r.reason, "packaged-blocked");
  assert.equal("BIBLIARY_SMOKE_UI_HARNESS" in env, false,
    "env key must be DELETED (not set to empty string) — `'KEY' in env` must return false");
  assert.equal(env.BIBLIARY_SMOKE_UI_HARNESS, undefined,
    "env.BIBLIARY_SMOKE_UI_HARNESS must be undefined after delete");
  assert.equal(logs.length, 1, "exactly one log line on block");
  assert.match(logs[0], /SECURITY/);
  assert.match(logs[0], /BIBLIARY_SMOKE_UI_HARNESS/);
  assert.match(logs[0], /packaged/);
});

test("[smoke-gate] dev + harness=1 → NOT blocked, env preserved", () => {
  const env = makeEnv("1");
  const logs: string[] = [];
  const r = applySmokeHarnessGate({ isPackaged: false, env, log: (m) => logs.push(m) });

  assert.equal(r.blocked, false);
  assert.equal(r.reason, "dev-allowed");
  assert.equal(env.BIBLIARY_SMOKE_UI_HARNESS, "1",
    "dev mode: env must remain — smoke tests need it");
  assert.match(logs[0], /dev mode/);
});

test("[smoke-gate] packaged + harness=0 → not-set (no action)", () => {
  /* Только литеральная "1" активирует харнес (так в preload.ts).
     Любое иное значение трактуется как not-set. */
  const env = makeEnv("0");
  const logs: string[] = [];
  const r = applySmokeHarnessGate({ isPackaged: true, env, log: (m) => logs.push(m) });

  assert.equal(r.blocked, false);
  assert.equal(r.reason, "not-set");
  assert.equal(env.BIBLIARY_SMOKE_UI_HARNESS, "0", "non-`1` value is ignored, not stripped");
  assert.equal(logs.length, 0, "no log when nothing to block");
});

test("[smoke-gate] packaged без env переменной → not-set", () => {
  const env = makeEnv(undefined);
  const logs: string[] = [];
  const r = applySmokeHarnessGate({ isPackaged: true, env, log: (m) => logs.push(m) });

  assert.equal(r.blocked, false);
  assert.equal(r.reason, "not-set");
  assert.equal("BIBLIARY_SMOKE_UI_HARNESS" in env, false);
  assert.equal(logs.length, 0);
});

test("[smoke-gate] dev без env переменной → not-set", () => {
  const env = makeEnv(undefined);
  const r = applySmokeHarnessGate({ isPackaged: false, env });

  assert.equal(r.blocked, false);
  assert.equal(r.reason, "not-set");
});

test("[smoke-gate] идемпотентность: повторный вызов после блокировки безопасен", () => {
  const env = makeEnv("1");
  const r1 = applySmokeHarnessGate({ isPackaged: true, env });
  assert.equal(r1.blocked, true);
  /* Второй вызов: env уже стёрт → not-set, никаких побочных эффектов. */
  const r2 = applySmokeHarnessGate({ isPackaged: true, env });
  assert.equal(r2.blocked, false);
  assert.equal(r2.reason, "not-set");
});

test("[smoke-gate] не трогает другие env-переменные", () => {
  const env: NodeJS.ProcessEnv = {
    BIBLIARY_SMOKE_UI_HARNESS: "1",
    BIBLIARY_DATA_DIR: "/path/to/data",
    BIBLIARY_LIBRARY_DB: "/path/cache.db",
    PATH: "/usr/bin",
    NODE_ENV: "production",
  };
  applySmokeHarnessGate({ isPackaged: true, env });

  assert.equal(env.BIBLIARY_DATA_DIR, "/path/to/data");
  assert.equal(env.BIBLIARY_LIBRARY_DB, "/path/cache.db");
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.NODE_ENV, "production");
  assert.equal("BIBLIARY_SMOKE_UI_HARNESS" in env, false, "только harness key стёрт");
});

test("[smoke-gate] log опционален: работает без logger callback'а", () => {
  /* Проверяем что отсутствие log в deps не валит функцию (важно для
     production где log = console.error может быть подменён). */
  const env = makeEnv("1");
  assert.doesNotThrow(() =>
    applySmokeHarnessGate({ isPackaged: true, env }),
  );
  assert.equal("BIBLIARY_SMOKE_UI_HARNESS" in env, false);
});

test("[smoke-gate] non-string harness value (если кто-то выставил bool) → trated as not-`1`", () => {
  /* TypeScript предотвращает это, но runtime может быть обмануть через
     env injection. Проверяем что только литеральная строка "1" триггерит. */
  const env: NodeJS.ProcessEnv = {};
  /* Имитируем баг: bool вместо string. */
  (env as Record<string, unknown>).BIBLIARY_SMOKE_UI_HARNESS = true;
  const r = applySmokeHarnessGate({ isPackaged: true, env });
  assert.equal(r.blocked, false, "bool true (не строка '1') не активирует харнес");
  assert.equal(r.reason, "not-set");
});

test("[smoke-gate] whitespace в harness value → not-set ('1 ' ≠ '1')", () => {
  /* Strict equality к "1" — пробелы вокруг не считаются. Документируем. */
  for (const dirty of [" 1", "1 ", " 1 ", "1\n", "1\t", "01", "true", "yes"]) {
    const env = makeEnv(dirty);
    const r = applySmokeHarnessGate({ isPackaged: true, env });
    assert.equal(r.blocked, false, `non-strict-"1" value ${JSON.stringify(dirty)} must NOT block`);
    assert.equal(env.BIBLIARY_SMOKE_UI_HARNESS, dirty,
      "non-blocked values must NOT be stripped");
  }
});
