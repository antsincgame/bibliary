import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildMemoryEntries,
  compareByRoleOrder,
  formatElo,
  modelHasRequiredCaps,
} from "../renderer/models/role-utils.js";

test("[models helpers] buildMemoryEntries keeps loaded first and deduplicates downloaded", () => {
  const loaded = [
    { modelKey: "qwen/loaded" },
    { modelKey: "vision/loaded" },
  ];
  const downloaded = [
    { modelKey: "qwen/loaded", sizeBytes: 1024 },
    { modelKey: "mistral/downloaded", sizeBytes: 1024 ** 3 * 2 },
  ];
  const entries = buildMemoryEntries(loaded, downloaded);
  assert.deepEqual(entries.map((entry) => entry.modelKey), ["qwen/loaded", "vision/loaded", "mistral/downloaded"]);
  assert.equal(entries[0].loaded, true);
  assert.equal(entries[2].loaded, false);
  assert.equal(entries[2].sizeGB, 2);
});

test("[models helpers] capability filtering matches resolver caps", () => {
  assert.equal(modelHasRequiredCaps({ modelKey: "plain" }, []), true);
  assert.equal(modelHasRequiredCaps({ modelKey: "vision", vision: true }, ["vision"]), true);
  assert.equal(modelHasRequiredCaps({ modelKey: "plain" }, ["vision"]), false);
  assert.equal(modelHasRequiredCaps({ modelKey: "tools", trainedForToolUse: true }, ["tool"]), true);
  assert.equal(modelHasRequiredCaps({ modelKey: "plain" }, ["tool"]), false);
});

test("[models helpers] formatElo and role order are stable for UI badges", () => {
  assert.equal(formatElo(1512.7), "1513");
  assert.equal(formatElo(Number.NaN), "1500");
  const sorted = [{ role: "arena_judge" }, { role: "chat" }, { role: "vision_meta" }].sort(compareByRoleOrder);
  assert.deepEqual(sorted.map((entry) => entry.role), ["chat", "vision_meta", "arena_judge"]);
});
