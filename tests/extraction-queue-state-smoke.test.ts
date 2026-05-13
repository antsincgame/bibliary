/**
 * Phase 7 — pure state machine smoke. Без Appwrite/HTTP — тестируем
 * только types.ts (canTransition + isTerminalState + ALL_JOB_STATES).
 *
 * Реальный worker loop требует Appwrite Database — отдельный
 * integration smoke когда добавим Docker compose в CI (out of scope).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  ALL_JOB_STATES,
  canTransition,
  isTerminalState,
  type JobState,
} from "../server/lib/queue/types.ts";

describe("extraction-queue state machine", () => {
  it("ALL_JOB_STATES enumerates 5 states", () => {
    assert.deepEqual(
      [...ALL_JOB_STATES].sort(),
      ["cancelled", "done", "failed", "queued", "running"],
    );
  });

  it("isTerminalState: done/failed/cancelled", () => {
    assert.equal(isTerminalState("done"), true);
    assert.equal(isTerminalState("failed"), true);
    assert.equal(isTerminalState("cancelled"), true);
    assert.equal(isTerminalState("queued"), false);
    assert.equal(isTerminalState("running"), false);
  });

  it("canTransition queued → running, cancelled", () => {
    assert.equal(canTransition("queued", "running"), true);
    assert.equal(canTransition("queued", "cancelled"), true);
    assert.equal(canTransition("queued", "done"), false);
    assert.equal(canTransition("queued", "failed"), false);
    assert.equal(canTransition("queued", "queued"), false);
  });

  it("canTransition running → done, failed, cancelled", () => {
    assert.equal(canTransition("running", "done"), true);
    assert.equal(canTransition("running", "failed"), true);
    assert.equal(canTransition("running", "cancelled"), true);
    assert.equal(canTransition("running", "queued"), false);
    assert.equal(canTransition("running", "running"), false);
  });

  it("terminal states reject any transition", () => {
    const terminal: JobState[] = ["done", "failed", "cancelled"];
    const targets: JobState[] = [
      "queued",
      "running",
      "done",
      "failed",
      "cancelled",
    ];
    for (const from of terminal) {
      for (const to of targets) {
        assert.equal(
          canTransition(from, to),
          false,
          `terminal ${from} should NOT transition → ${to}`,
        );
      }
    }
  });

  it("no self-transitions allowed", () => {
    for (const s of ALL_JOB_STATES) {
      assert.equal(
        canTransition(s, s),
        false,
        `${s} → ${s} should be forbidden`,
      );
    }
  });
});
