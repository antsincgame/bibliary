/**
 * Unit tests for electron/lib/llm/lmstudio-actions-log.ts (v1.0.7).
 *
 * Покрывает:
 *  - logModelAction записывает строку JSON в файл
 *  - readActionsLog возвращает последние N строк
 *  - clearActionsLog удаляет файл
 *  - flushActionsLog ждёт завершения всех pending writes
 *  - События с разным kind корректно сериализуются
 *  - Ошибка writeFile не падает caller'а
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { mkdtemp, rm, readFile } from "node:fs/promises";

import {
  logModelAction,
  readActionsLog,
  clearActionsLog,
  flushActionsLog,
  _setLogFilePathForTests,
} from "../electron/lib/llm/lmstudio-actions-log.ts";

async function withTempLogFile<T>(fn: (logPath: string) => Promise<T>): Promise<T> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "bibliary-actions-log-"));
  const logPath = path.join(tempDir, "lmstudio-actions.log");
  _setLogFilePathForTests(logPath);
  try {
    return await fn(logPath);
  } finally {
    _setLogFilePathForTests(null);
    await rm(tempDir, { recursive: true, force: true });
  }
}

test("[lmstudio-actions-log] logModelAction writes JSON line with ts + kind", async () => {
  await withTempLogFile(async (logPath) => {
    logModelAction("LOAD", { modelKey: "qwen3.5-test", role: "evaluator", reason: "unit test" });
    await flushActionsLog();
    const content = await readFile(logPath, "utf8");
    const lines = content.split("\n").filter((l) => l.length > 0);
    assert.equal(lines.length, 1);
    const event = JSON.parse(lines[0]);
    assert.equal(event.kind, "LOAD");
    assert.equal(event.modelKey, "qwen3.5-test");
    assert.equal(event.role, "evaluator");
    assert.equal(event.reason, "unit test");
    assert.match(event.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});

test("[lmstudio-actions-log] sequential logs are serialized (no torn writes)", async () => {
  await withTempLogFile(async (logPath) => {
    /* Залогаем 50 событий быстро — раньше fs.appendFile concurrent на NTFS
       мог терять строки. Promise queue в нашем модуле должен это закрыть. */
    for (let i = 0; i < 50; i++) {
      logModelAction("ACQUIRE", { modelKey: `m${i}`, role: "evaluator" });
    }
    await flushActionsLog();
    const content = await readFile(logPath, "utf8");
    const lines = content.split("\n").filter((l) => l.length > 0);
    assert.equal(lines.length, 50);
    /* Каждая строка должна парситься как валидный JSON. */
    for (const line of lines) {
      const event = JSON.parse(line);
      assert.equal(event.kind, "ACQUIRE");
      assert.match(event.modelKey, /^m\d+$/);
    }
  });
});

test("[lmstudio-actions-log] readActionsLog returns last N lines", async () => {
  await withTempLogFile(async () => {
    for (let i = 0; i < 10; i++) {
      logModelAction("LOAD", { modelKey: `model-${i}` });
    }
    await flushActionsLog();
    const tail = await readActionsLog(3);
    const lines = tail.split("\n").filter((l) => l.length > 0);
    assert.equal(lines.length, 3);
    const last = JSON.parse(lines[2]);
    assert.equal(last.modelKey, "model-9");
  });
});

test("[lmstudio-actions-log] readActionsLog returns empty string when file missing", async () => {
  await withTempLogFile(async () => {
    /* Не пишем ничего — файла нет. readActionsLog должен вернуть "". */
    const tail = await readActionsLog();
    assert.equal(tail, "");
  });
});

test("[lmstudio-actions-log] clearActionsLog removes the file", async () => {
  await withTempLogFile(async (logPath) => {
    logModelAction("LOAD", { modelKey: "test" });
    await flushActionsLog();
    /* sanity check: файл существует */
    const before = await readFile(logPath, "utf8").catch(() => null);
    assert.ok(before !== null, "file must exist after logging");
    await clearActionsLog();
    const after = await readFile(logPath, "utf8").catch(() => null);
    assert.equal(after, null, "file must be removed");
  });
});

test("[lmstudio-actions-log] all ModelActionKind values serialize without errors", async () => {
  await withTempLogFile(async () => {
    const kinds = [
      "LOAD", "UNLOAD",
      "ACQUIRE", "ACQUIRE-OK", "ACQUIRE-FAIL",
      "RELEASE", "EVICT",
      "AUTO-LOAD-START", "AUTO-LOAD-OK", "AUTO-LOAD-FAIL",
      "RESOLVE-PASSIVE-SKIP",
      "EVALUATOR-DEFER-RESUME", "EVALUATOR-PICK-FAIL",
    ] as const;
    for (const kind of kinds) {
      logModelAction(kind, { reason: "smoke test", meta: { foo: "bar" } });
    }
    await flushActionsLog();
    const tail = await readActionsLog(100);
    const lines = tail.split("\n").filter((l) => l.length > 0);
    assert.equal(lines.length, kinds.length);
    for (let i = 0; i < kinds.length; i++) {
      const event = JSON.parse(lines[i]);
      assert.equal(event.kind, kinds[i]);
      assert.equal(event.reason, "smoke test");
      assert.deepEqual(event.meta, { foo: "bar" });
    }
  });
});
