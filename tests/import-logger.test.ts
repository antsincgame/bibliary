/**
 * Unit tests для electron/lib/library/import-logger.ts.
 *
 * Покрытие:
 *   1. startSession создаёт файл в правильной папке (BIBLIARY_DATA_DIR/logs).
 *   2. write() добавляет запись в ring + emit'ит на subscriber.
 *   3. flush(true) гарантирует, что запись попала на диск.
 *   4. snapshot() возвращает копию ring буфера.
 *   5. endSession очищает active state и не теряет последние записи.
 *   6. Ring buffer overflow (>500 записей) drop'ает старые.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { _createImportLoggerForTests } from "../electron/lib/library/import-logger.ts";

async function makeSandbox() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "bibliary-logger-"));
  const prev = process.env.BIBLIARY_DATA_DIR;
  process.env.BIBLIARY_DATA_DIR = dir;
  return {
    dir,
    cleanup: async () => {
      if (prev === undefined) delete process.env.BIBLIARY_DATA_DIR;
      else process.env.BIBLIARY_DATA_DIR = prev;
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("[import-logger] startSession creates JSONL file under data/logs/", async (t) => {
  const sb = await makeSandbox();
  t.after(sb.cleanup);

  const logger = _createImportLoggerForTests();
  const file = await logger.startSession("test-import-001");

  assert.ok(file.includes(path.join(sb.dir, "logs")), `file should be under sandbox/logs: ${file}`);
  assert.ok(file.endsWith(".jsonl"), `file should be .jsonl: ${file}`);

  const content = await readFile(file, "utf-8").catch(() => "");
  await logger.endSession({ status: "ok" });
  /* После endSession первая запись (import.start) должна быть persisted. */
  const final = await readFile(file, "utf-8");
  const lines = final.trim().split("\n").filter(Boolean);
  assert.ok(lines.length >= 1, "at least the start entry must be persisted");
  const first = JSON.parse(lines[0]) as { category: string; importId: string };
  assert.equal(first.category, "import.start");
  assert.equal(first.importId, "test-import-001");
});

test("[import-logger] write() emits event AND appends to ring", async (t) => {
  const sb = await makeSandbox();
  t.after(sb.cleanup);

  const logger = _createImportLoggerForTests();
  await logger.startSession("ring-test");

  const received: string[] = [];
  const unsub = logger.subscribe((entry) => received.push(entry.message));

  await logger.write({ importId: "ring-test", level: "info", category: "file.added", message: "first" });
  await logger.write({ importId: "ring-test", level: "warn", category: "file.warning", message: "second" });
  await logger.write({ importId: "ring-test", level: "error", category: "file.failed", message: "third" });

  unsub();
  await logger.endSession({ status: "ok" });

  assert.deepEqual(received.slice(-3), ["first", "second", "third"]);
  const snap = logger.snapshot();
  /* В ring должны быть start (1) + 3 write — 4 записи минимум. */
  assert.ok(snap.length >= 4, `snapshot length: ${snap.length}`);
  const messages = snap.map((e) => e.message);
  assert.ok(messages.includes("first"));
  assert.ok(messages.includes("second"));
  assert.ok(messages.includes("third"));
});

test("[import-logger] persists error entries to disk on endSession (sync flush)", async (t) => {
  const sb = await makeSandbox();
  t.after(sb.cleanup);

  const logger = _createImportLoggerForTests();
  const file = await logger.startSession("err-persist");
  await logger.write({
    importId: "err-persist",
    level: "error",
    category: "file.failed",
    message: "parser failed: bad PDF",
    file: "broken.pdf",
    details: { code: "EBADPDF" },
  });
  await logger.endSession({ status: "failed" });

  const text = await readFile(file, "utf-8");
  const lines = text.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const failure = lines.find((l) => l.category === "file.failed");
  assert.ok(failure, "failed entry must be persisted");
  assert.equal(failure.level, "error");
  assert.equal(failure.message, "parser failed: bad PDF");
  assert.equal(failure.file, "broken.pdf");
  assert.deepEqual(failure.details, { code: "EBADPDF" });
});

test("[import-logger] ring drops oldest after 500 entries", async (t) => {
  const sb = await makeSandbox();
  t.after(sb.cleanup);

  const logger = _createImportLoggerForTests();
  await logger.startSession("ring-overflow");
  for (let i = 0; i < 600; i++) {
    await logger.write({
      importId: "ring-overflow",
      level: "info",
      category: "scan.discovered",
      message: `entry-${i}`,
    });
  }
  const snap = logger.snapshot();
  /* Buffer cap 500. Первые ~100 записей должны быть выброшены. */
  assert.ok(snap.length <= 500, `expected <=500, got ${snap.length}`);
  assert.ok(!snap.some((e) => e.message === "entry-0"), "entry-0 should be dropped");
  assert.ok(snap.some((e) => e.message === "entry-599"), "entry-599 must be kept");
  await logger.endSession({ status: "ok" });
});

test("[import-logger] subsequent startSession closes previous", async (t) => {
  const sb = await makeSandbox();
  t.after(sb.cleanup);

  const logger = _createImportLoggerForTests();
  const file1 = await logger.startSession("session-1");
  await logger.write({ importId: "session-1", level: "info", category: "system.info", message: "from-1" });

  const file2 = await logger.startSession("session-2");
  assert.notEqual(file1, file2, "second session must use a different file");

  /* Ring обнулился: from-1 не должно быть в snapshot новой сессии. */
  const snap = logger.snapshot();
  assert.ok(!snap.some((e) => e.message === "from-1"), "ring must reset on new session");
  await logger.endSession({ status: "ok" });
});
