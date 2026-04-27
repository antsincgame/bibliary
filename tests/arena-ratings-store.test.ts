/**
 * Unit tests for electron/lib/llm/arena/ratings-store.ts
 *
 * Тестирует: Elo обновление, graceful empty без init, resetRatings,
 * readRatingsFile при повреждённом файле.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";

import {
  initArenaRatingsStore,
  readRatingsFile,
  recordMatch,
  resetRatings,
  getDefaultElo,
  _resetArenaRatingsStoreForTests,
} from "../electron/lib/llm/arena/ratings-store.ts";

async function makeTmpDir() {
  return mkdtemp(path.join(os.tmpdir(), "bibliary-ratings-"));
}

describe("[arena-ratings-store] graceful without init", () => {
  test("readRatingsFile returns empty structure when store not initialised", async () => {
    _resetArenaRatingsStoreForTests();
    const result = await readRatingsFile();
    assert.equal(result.version, 1);
    assert.deepEqual(result.roles, {});
  });

  test("recordMatch throws when store not initialised", async () => {
    _resetArenaRatingsStoreForTests();
    await assert.rejects(
      () => recordMatch("chat", "model-a", "model-b"),
      /not initialised/i,
    );
  });
});

describe("[arena-ratings-store] with initialised store", () => {
  test("readRatingsFile returns empty on first read (file doesn't exist)", async () => {
    const dir = await makeTmpDir();
    try {
      _resetArenaRatingsStoreForTests();
      initArenaRatingsStore(dir);
      const f = await readRatingsFile();
      assert.deepEqual(f.roles, {});
    } finally {
      _resetArenaRatingsStoreForTests();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("readRatingsFile returns empty on corrupted JSON", async () => {
    const dir = await makeTmpDir();
    try {
      _resetArenaRatingsStoreForTests();
      initArenaRatingsStore(dir);
      await writeFile(path.join(dir, "arena-ratings.json"), "not-json!!!", "utf8");
      const f = await readRatingsFile();
      assert.deepEqual(f.roles, {});
    } finally {
      _resetArenaRatingsStoreForTests();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("recordMatch creates role bucket if missing", async () => {
    const dir = await makeTmpDir();
    try {
      _resetArenaRatingsStoreForTests();
      initArenaRatingsStore(dir);
      await recordMatch("chat", "winner-model", "loser-model");
      const f = await readRatingsFile();
      assert.ok("chat" in f.roles, "chat bucket missing");
    } finally {
      _resetArenaRatingsStoreForTests();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("recordMatch increases winner Elo and decreases loser Elo", async () => {
    const dir = await makeTmpDir();
    try {
      _resetArenaRatingsStoreForTests();
      initArenaRatingsStore(dir);
      await recordMatch("chat", "winner", "loser");
      const f = await readRatingsFile();
      const r = f.roles["chat"]!;
      const winnerElo = r["winner"] ?? getDefaultElo();
      const loserElo = r["loser"] ?? getDefaultElo();
      assert.ok(winnerElo > getDefaultElo(), `winner ${winnerElo} should exceed default ${getDefaultElo()}`);
      assert.ok(loserElo < getDefaultElo(), `loser ${loserElo} should be below default ${getDefaultElo()}`);
    } finally {
      _resetArenaRatingsStoreForTests();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("recordMatch with equal keys is a no-op", async () => {
    const dir = await makeTmpDir();
    try {
      _resetArenaRatingsStoreForTests();
      initArenaRatingsStore(dir);
      await recordMatch("chat", "same-model", "same-model");
      const f = await readRatingsFile();
      assert.deepEqual(f.roles, {}, "equal-key match should not update ratings");
    } finally {
      _resetArenaRatingsStoreForTests();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("multiple matches accumulate Elo correctly (winner keeps winning)", async () => {
    const dir = await makeTmpDir();
    try {
      _resetArenaRatingsStoreForTests();
      initArenaRatingsStore(dir);
      for (let i = 0; i < 5; i++) {
        await recordMatch("chat", "strong", "weak");
      }
      const f = await readRatingsFile();
      const r = f.roles["chat"]!;
      const strongElo = r["strong"] ?? getDefaultElo();
      const weakElo = r["weak"] ?? getDefaultElo();
      assert.ok(strongElo > weakElo + 50, `strong (${strongElo}) should dominate weak (${weakElo})`);
    } finally {
      _resetArenaRatingsStoreForTests();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("resetRatings clears all roles", async () => {
    const dir = await makeTmpDir();
    try {
      _resetArenaRatingsStoreForTests();
      initArenaRatingsStore(dir);
      await recordMatch("chat", "a", "b");
      await recordMatch("agent", "x", "y");
      await resetRatings();
      const f = await readRatingsFile();
      assert.deepEqual(f.roles, {});
    } finally {
      _resetArenaRatingsStoreForTests();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("recordMatch sets lastCycleAt to ISO timestamp", async () => {
    const dir = await makeTmpDir();
    try {
      _resetArenaRatingsStoreForTests();
      initArenaRatingsStore(dir);
      const before = Date.now();
      await recordMatch("chat", "a", "b");
      const f = await readRatingsFile();
      assert.ok(f.lastCycleAt, "lastCycleAt should be set");
      const ts = new Date(f.lastCycleAt!).getTime();
      assert.ok(ts >= before - 100, "timestamp not before call");
      assert.ok(ts <= Date.now() + 100, "timestamp not in future");
    } finally {
      _resetArenaRatingsStoreForTests();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("roles are independent buckets — chat match does not affect agent Elo", async () => {
    const dir = await makeTmpDir();
    try {
      _resetArenaRatingsStoreForTests();
      initArenaRatingsStore(dir);
      await recordMatch("chat", "m1", "m2");
      const f = await readRatingsFile();
      assert.equal(f.roles["agent"], undefined, "agent bucket should not appear");
    } finally {
      _resetArenaRatingsStoreForTests();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
