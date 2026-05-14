/**
 * Unit tests for electron/lib/llm/global-llm-lock.ts
 *
 * GlobalLlmLock — синхронный probe registry, защищает LM Studio от OOM
 * когда arena scheduler пытается стартовать во время массового импорта.
 */
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { globalLlmLock } from "../server/lib/scanner/_vendor/llm/global-llm-lock.ts";

beforeEach(() => {
  globalLlmLock._resetForTests();
});

describe("[global-llm-lock] probe registry", () => {
  test("isBusy returns not-busy when no probes registered", () => {
    const r = globalLlmLock.isBusy();
    assert.equal(r.busy, false);
    assert.deepEqual(r.reasons, []);
  });

  test("isBusy returns not-busy when all probes return busy=false", () => {
    globalLlmLock.registerProbe("probe-a", () => ({ busy: false }));
    globalLlmLock.registerProbe("probe-b", () => ({ busy: false }));
    const r = globalLlmLock.isBusy();
    assert.equal(r.busy, false);
    assert.deepEqual(r.reasons, []);
  });

  test("isBusy returns busy when at least one probe is busy", () => {
    globalLlmLock.registerProbe("quiet", () => ({ busy: false }));
    globalLlmLock.registerProbe("noisy", () => ({ busy: true, reason: "3 imports running" }));
    const r = globalLlmLock.isBusy();
    assert.equal(r.busy, true);
    assert.equal(r.reasons.length, 1);
    assert.match(r.reasons[0]!, /noisy/);
    assert.match(r.reasons[0]!, /3 imports running/);
  });

  test("isBusy collects reasons from all busy probes", () => {
    globalLlmLock.registerProbe("import", () => ({ busy: true, reason: "2 active" }));
    globalLlmLock.registerProbe("evaluator", () => ({ busy: true, reason: "slot busy" }));
    const r = globalLlmLock.isBusy();
    assert.equal(r.busy, true);
    assert.equal(r.reasons.length, 2);
    assert.match(r.reasons.join("|"), /import/);
    assert.match(r.reasons.join("|"), /evaluator/);
  });

  test("isBusy formats reason as 'label: reason' when reason provided", () => {
    globalLlmLock.registerProbe("library-import", () => ({ busy: true, reason: "5 import(s)" }));
    const r = globalLlmLock.isBusy();
    assert.equal(r.reasons[0], "library-import: 5 import(s)");
  });

  test("isBusy formats reason as just label when no reason", () => {
    globalLlmLock.registerProbe("my-probe", () => ({ busy: true }));
    const r = globalLlmLock.isBusy();
    assert.equal(r.reasons[0], "my-probe");
  });

  test("isBusy treats throwing probe as non-busy (lenient)", () => {
    globalLlmLock.registerProbe("bad-probe", () => { throw new Error("unexpected"); });
    globalLlmLock.registerProbe("good-probe", () => ({ busy: false }));
    const r = globalLlmLock.isBusy();
    assert.equal(r.busy, false, "throwing probe must not cause busy=true");
    assert.deepEqual(r.reasons, []);
  });

  test("registerProbe returns unregister fn that removes probe", () => {
    const unregister = globalLlmLock.registerProbe("temp", () => ({ busy: true }));
    assert.equal(globalLlmLock.isBusy().busy, true);
    unregister();
    assert.equal(globalLlmLock.isBusy().busy, false);
  });

  test("re-registering same label overwrites old probe", () => {
    globalLlmLock.registerProbe("dup", () => ({ busy: true }));
    globalLlmLock.registerProbe("dup", () => ({ busy: false })); // overwrites
    assert.equal(globalLlmLock.isBusy().busy, false);
  });
});

describe("[global-llm-lock] skip metrics", () => {
  test("recordSkip increments skipCount", () => {
    assert.equal(globalLlmLock.getStatus().skipCount, 0);
    globalLlmLock.recordSkip(["reason-a"]);
    assert.equal(globalLlmLock.getStatus().skipCount, 1);
    globalLlmLock.recordSkip(["reason-b", "reason-c"]);
    assert.equal(globalLlmLock.getStatus().skipCount, 2);
  });

  test("recordSkip stores lastSkippedAt as ISO timestamp", () => {
    const before = Date.now();
    globalLlmLock.recordSkip(["x"]);
    const status = globalLlmLock.getStatus();
    assert.notEqual(status.lastSkippedAt, null);
    const ts = new Date(status.lastSkippedAt!).getTime();
    assert.ok(ts >= before - 10, "timestamp should be >= before");
    assert.ok(ts <= Date.now() + 10, "timestamp should be <= now");
  });

  test("recordSkip stores lastSkipReasons", () => {
    globalLlmLock.recordSkip(["reason-one", "reason-two"]);
    const status = globalLlmLock.getStatus();
    assert.deepEqual(status.lastSkipReasons, ["reason-one", "reason-two"]);
  });

  test("resetMetrics clears all counters", () => {
    globalLlmLock.recordSkip(["x"]);
    globalLlmLock.recordSkip(["y"]);
    globalLlmLock.resetMetrics();
    const s = globalLlmLock.getStatus();
    assert.equal(s.skipCount, 0);
    assert.equal(s.lastSkippedAt, null);
    assert.deepEqual(s.lastSkipReasons, []);
  });
});

describe("[global-llm-lock] getStatus", () => {
  test("getStatus.registeredProbes lists all probe labels", () => {
    globalLlmLock.registerProbe("alpha", () => ({ busy: false }));
    globalLlmLock.registerProbe("beta", () => ({ busy: true }));
    const s = globalLlmLock.getStatus();
    assert.ok(s.registeredProbes.includes("alpha"), "alpha missing");
    assert.ok(s.registeredProbes.includes("beta"), "beta missing");
  });

  test("getStatus.busy reflects current probe state", () => {
    let isActive = true;
    globalLlmLock.registerProbe("dynamic", () => ({ busy: isActive }));

    assert.equal(globalLlmLock.getStatus().busy, true);
    isActive = false;
    assert.equal(globalLlmLock.getStatus().busy, false);
  });

  test("_resetForTests clears probes and metrics", () => {
    globalLlmLock.registerProbe("x", () => ({ busy: true }));
    globalLlmLock.recordSkip(["x"]);
    globalLlmLock._resetForTests();
    const s = globalLlmLock.getStatus();
    assert.equal(s.busy, false);
    assert.equal(s.skipCount, 0);
    assert.deepEqual(s.registeredProbes, []);
  });
});
