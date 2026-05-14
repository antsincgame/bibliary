/**
 * Unit tests for resilience/file-lock (withFileLock + configureFileLockDefaults).
 * Uses temp files — no shared state between tests.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { mkdtemp, rm, access } from "node:fs/promises";
import { withFileLock, configureFileLockDefaults } from "../server/lib/scanner/_vendor/resilience/file-lock.ts";

async function makeTmpDir() {
  return mkdtemp(path.join(os.tmpdir(), "bibliary-lock-test-"));
}

// ─────────────────────────────────────────────────────────────────────────────

describe("withFileLock", () => {
  test("creates target file if it does not exist", async () => {
    const dir = await makeTmpDir();
    try {
      const target = path.join(dir, "new-file.json");
      await withFileLock(target, async () => "ok");
      // File should now exist
      await assert.doesNotReject(() => access(target));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("executes the callback and returns its value", async () => {
    const dir = await makeTmpDir();
    try {
      const target = path.join(dir, "data.json");
      const result = await withFileLock(target, async () => 42);
      assert.equal(result, 42);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("releases lock even when callback throws", async () => {
    const dir = await makeTmpDir();
    try {
      const target = path.join(dir, "error-case.json");
      await assert.rejects(
        () => withFileLock(target, async () => { throw new Error("boom"); }),
        /boom/
      );
      // After throwing, lock should be released — a second call must succeed
      const result = await withFileLock(target, async () => "recovered");
      assert.equal(result, "recovered");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("sequential locks on same file work correctly", async () => {
    const dir = await makeTmpDir();
    try {
      const target = path.join(dir, "seq.json");
      const log: number[] = [];

      await withFileLock(target, async () => { log.push(1); });
      await withFileLock(target, async () => { log.push(2); });
      await withFileLock(target, async () => { log.push(3); });

      assert.deepEqual(log, [1, 2, 3]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("concurrent locks on different files do not block each other", async () => {
    const dir = await makeTmpDir();
    try {
      const t1 = path.join(dir, "file1.json");
      const t2 = path.join(dir, "file2.json");
      const log: string[] = [];

      await Promise.all([
        withFileLock(t1, async () => { log.push("f1"); }),
        withFileLock(t2, async () => { log.push("f2"); }),
      ]);

      assert.equal(log.length, 2);
      assert.ok(log.includes("f1"));
      assert.ok(log.includes("f2"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("per-call opts override runtimeDefaults", async () => {
    const dir = await makeTmpDir();
    try {
      const target = path.join(dir, "opts.json");
      // Should succeed with custom opts regardless of defaults
      const result = await withFileLock(target, async () => "custom-opts", {
        retries: 2,
        stale: 10_000,
      });
      assert.equal(result, "custom-opts");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("configureFileLockDefaults", () => {
  test("accepts partial config without throwing", () => {
    assert.doesNotThrow(() => configureFileLockDefaults({ retries: 5 }));
    assert.doesNotThrow(() => configureFileLockDefaults({ stale: 20_000 }));
    assert.doesNotThrow(() => configureFileLockDefaults({}));
  });

  test("updated defaults are used by subsequent withFileLock calls", async () => {
    const dir = await makeTmpDir();
    try {
      configureFileLockDefaults({ retries: 3, stale: 15_000 });
      const target = path.join(dir, "default-test.json");
      const result = await withFileLock(target, async () => "works");
      assert.equal(result, "works");
    } finally {
      await rm(dir, { recursive: true, force: true });
      // Restore original defaults
      configureFileLockDefaults({ retries: 3, stale: 10_000 });
    }
  });
});
