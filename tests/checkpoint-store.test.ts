/**
 * Unit tests for resilience/checkpoint-store.
 * Uses temp directories — no shared state between tests.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { z } from "zod";
import { createCheckpointStore } from "../server/lib/scanner/_vendor/resilience/checkpoint-store.ts";

const SnapshotSchema = z.object({
  step: z.number(),
  label: z.string(),
});
type Snapshot = z.infer<typeof SnapshotSchema>;

async function makeTmpStore() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "bibliary-cp-test-"));
  const store = createCheckpointStore<Snapshot>({ dir, schema: SnapshotSchema });
  return { store, dir };
}

// ─────────────────────────────────────────────────────────────────────────────

describe("checkpoint-store", () => {
  test("save + load returns the same snapshot", async () => {
    const { store, dir } = await makeTmpStore();
    try {
      await store.save("run-1", { step: 5, label: "training" });
      const loaded = await store.load("run-1");
      assert.deepEqual(loaded, { step: 5, label: "training" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("load on missing id returns null", async () => {
    const { store, dir } = await makeTmpStore();
    try {
      const result = await store.load("no-such-id");
      assert.equal(result, null);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("save is idempotent — last write wins", async () => {
    const { store, dir } = await makeTmpStore();
    try {
      await store.save("run-2", { step: 1, label: "first" });
      await store.save("run-2", { step: 10, label: "updated" });
      const loaded = await store.load("run-2");
      assert.deepEqual(loaded, { step: 10, label: "updated" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("list returns all saved checkpoint ids", async () => {
    const { store, dir } = await makeTmpStore();
    try {
      await store.save("a", { step: 1, label: "a" });
      await store.save("b", { step: 2, label: "b" });
      await store.save("c", { step: 3, label: "c" });
      const items = await store.list();
      const ids = items.map((i) => i.id).sort();
      assert.deepEqual(ids, ["a", "b", "c"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("list on empty dir returns []", async () => {
    const { store, dir } = await makeTmpStore();
    try {
      const items = await store.list();
      assert.deepEqual(items, []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("remove makes load return null", async () => {
    const { store, dir } = await makeTmpStore();
    try {
      await store.save("to-remove", { step: 99, label: "bye" });
      await store.remove("to-remove");
      const result = await store.load("to-remove");
      assert.equal(result, null);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("scan returns all valid snapshots", async () => {
    const { store, dir } = await makeTmpStore();
    try {
      await store.save("s1", { step: 1, label: "one" });
      await store.save("s2", { step: 2, label: "two" });
      const all = await store.scan();
      assert.equal(all.length, 2);
      const sorted = all.sort((a, b) => a.id.localeCompare(b.id));
      assert.deepEqual(sorted[0]?.snapshot, { step: 1, label: "one" });
      assert.deepEqual(sorted[1]?.snapshot, { step: 2, label: "two" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("scan skips corrupted JSON without throwing", async () => {
    const { store, dir } = await makeTmpStore();
    try {
      await store.save("good", { step: 1, label: "ok" });
      // Write a corrupted checkpoint manually
      await writeFile(path.join(dir, "bad.json"), "{ INVALID JSON <<<", "utf8");
      const all = await store.scan();
      assert.equal(all.length, 1, "corrupted checkpoint should be skipped");
      assert.equal(all[0]?.id, "good");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("save throws on unsafe id characters", async () => {
    const { store, dir } = await makeTmpStore();
    try {
      await assert.rejects(
        () => store.save("../../etc/passwd", { step: 1, label: "evil" }),
        /unsafe chars/
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("getPath returns expected file path", async () => {
    const { store, dir } = await makeTmpStore();
    try {
      const p = store.getPath("my-run");
      assert.equal(p, path.join(path.resolve(dir), "my-run.json"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("load throws on schema mismatch (bad type in JSON)", async () => {
    const { store, dir } = await makeTmpStore();
    try {
      // Write a JSON that passes JSON.parse but fails the Zod schema
      await writeFile(path.join(dir, "bad-schema.json"), JSON.stringify({ step: "not-a-number", label: 42 }), "utf8");
      await assert.rejects(
        () => store.load("bad-schema"),
        /schema mismatch/
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
