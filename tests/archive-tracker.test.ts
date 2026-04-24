/* ArchiveTracker contract: refcount cleanup, idempotency, abort safety. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ArchiveTracker } from "../electron/lib/library/archive-tracker.ts";

test("register + finishOne: cleanup fires when last book reports done", async () => {
  const tracker = new ArchiveTracker();
  let cleaned = false;
  tracker.register("/tmp/a", 3, async () => {
    cleaned = true;
  });
  await tracker.finishOne("/tmp/a");
  assert.equal(cleaned, false, "1/3 — not yet");
  await tracker.finishOne("/tmp/a");
  assert.equal(cleaned, false, "2/3 — not yet");
  await tracker.finishOne("/tmp/a");
  assert.equal(cleaned, true, "3/3 — cleanup fired");
  assert.equal(tracker.size, 0);
});

test("register: zero-file archive triggers immediate cleanup", async () => {
  const tracker = new ArchiveTracker();
  let cleaned = false;
  tracker.register("/tmp/empty", 0, async () => {
    cleaned = true;
  });
  /* Дать microtask'у time on event loop. */
  await new Promise((r) => setImmediate(r));
  assert.equal(cleaned, true);
  assert.equal(tracker.size, 0);
});

test("finishOne: undefined tempDir is no-op (non-archive book)", async () => {
  const tracker = new ArchiveTracker();
  await tracker.finishOne(undefined);
  assert.equal(tracker.size, 0);
});

test("finishOne: extra calls past zero do not throw", async () => {
  const tracker = new ArchiveTracker();
  tracker.register("/tmp/x", 1, async () => undefined);
  await tracker.finishOne("/tmp/x");
  await tracker.finishOne("/tmp/x"); // already cleaned, no-op
  await tracker.finishOne("/tmp/x");
  assert.equal(tracker.size, 0);
});

test("register: re-registering same tempDir is ignored", () => {
  const tracker = new ArchiveTracker();
  tracker.register("/tmp/y", 5, async () => undefined);
  tracker.register("/tmp/y", 999, async () => undefined);
  assert.equal(tracker.size, 1);
});

test("cleanupAll: clears all live slots, even if some cleanups throw", async () => {
  const tracker = new ArchiveTracker();
  let cleanedA = false;
  let cleanedC = false;
  tracker.register("/tmp/a", 5, async () => {
    cleanedA = true;
  });
  tracker.register("/tmp/b", 5, async () => {
    throw new Error("intentional cleanup failure");
  });
  tracker.register("/tmp/c", 5, async () => {
    cleanedC = true;
  });

  await tracker.cleanupAll();
  assert.equal(cleanedA, true);
  assert.equal(cleanedC, true);
  assert.equal(tracker.size, 0);
});

test("cleanupAll: idempotent — second call is no-op", async () => {
  const tracker = new ArchiveTracker();
  tracker.register("/tmp/a", 5, async () => undefined);
  await tracker.cleanupAll();
  await tracker.cleanupAll();
  assert.equal(tracker.size, 0);
});
