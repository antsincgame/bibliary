/**
 * Unit tests for electron/lib/llm/arena/scheduler.ts
 *
 * Тестирует: start/stop/restart, идемпотентность, lock guard skip,
 * disabled when arenaEnabled=false.
 *
 * Использует injectable deps (_setSchedulerDepsForTests) и fake timers —
 * setIntervalFn/clearIntervalFn заменяются на синхронные коллекторы.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  startScheduler,
  stopScheduler,
  restartScheduler,
  isSchedulerRunning,
  _setSchedulerDepsForTests,
  _resetSchedulerForTests,
} from "../electron/lib/llm/arena/scheduler.ts";
import { globalLlmLock } from "../electron/lib/llm/global-llm-lock.ts";

/* ── fake timer ─────────────────────────────────────────────────────── */

interface FakeTimer {
  id: number;
  callback: () => void;
  intervalMs: number;
}

class FakeTimerRegistry {
  private timers = new Map<number, FakeTimer>();
  private nextId = 1;

  setInterval = (cb: () => void, ms: number): ReturnType<typeof setInterval> => {
    const id = this.nextId++;
    this.timers.set(id, { id, callback: cb, intervalMs: ms });
    return id as unknown as ReturnType<typeof setInterval>;
  };

  clearInterval = (id: ReturnType<typeof setInterval>): void => {
    this.timers.delete(id as unknown as number);
  };

  tick(timerId: number): void {
    const t = this.timers.get(timerId);
    if (t) t.callback();
  }

  tickAll(): void {
    for (const t of this.timers.values()) t.callback();
  }

  count(): number {
    return this.timers.size;
  }

  getFirst(): FakeTimer | undefined {
    return this.timers.values().next().value as FakeTimer | undefined;
  }
}

/* ── helpers ────────────────────────────────────────────────────────── */

function makePrefs(arenaEnabled: boolean, intervalMs = 3_600_000) {
  return async () => ({ arenaEnabled, arenaCycleIntervalMs: intervalMs });
}

function noopCycle() {
  return async () => ({ ok: true, message: "noop" } as never);
}

/* ── setup / teardown ───────────────────────────────────────────────── */

let fakeTimers: FakeTimerRegistry;

beforeEach(() => {
  stopScheduler(); // ensure clean state
  _resetSchedulerForTests();
  globalLlmLock._resetForTests();
  fakeTimers = new FakeTimerRegistry();
});

afterEach(() => {
  stopScheduler();
  _resetSchedulerForTests();
  globalLlmLock._resetForTests();
});

/* ── start / stop ───────────────────────────────────────────────────── */

describe("[arena-scheduler] start / stop", () => {
  test("scheduler does not start when arenaEnabled=false", async () => {
    _setSchedulerDepsForTests({
      getPrefs: makePrefs(false),
      runCycle: noopCycle(),
      setIntervalFn: fakeTimers.setInterval as never,
      clearIntervalFn: fakeTimers.clearInterval as never,
    });
    await startScheduler();
    assert.equal(isSchedulerRunning(), false, "should NOT start when disabled");
    assert.equal(fakeTimers.count(), 0, "no timer should be registered");
  });

  test("scheduler starts when arenaEnabled=true", async () => {
    _setSchedulerDepsForTests({
      getPrefs: makePrefs(true, 60_000),
      runCycle: noopCycle(),
      setIntervalFn: fakeTimers.setInterval as never,
      clearIntervalFn: fakeTimers.clearInterval as never,
    });
    await startScheduler();
    assert.equal(isSchedulerRunning(), true, "should be running after start");
    assert.equal(fakeTimers.count(), 1, "exactly 1 timer registered");
  });

  test("stopScheduler stops running scheduler", async () => {
    _setSchedulerDepsForTests({
      getPrefs: makePrefs(true, 60_000),
      runCycle: noopCycle(),
      setIntervalFn: fakeTimers.setInterval as never,
      clearIntervalFn: fakeTimers.clearInterval as never,
    });
    await startScheduler();
    assert.equal(isSchedulerRunning(), true);
    stopScheduler();
    assert.equal(isSchedulerRunning(), false);
    assert.equal(fakeTimers.count(), 0, "timer should be cleared on stop");
  });

  test("stopScheduler is safe to call when not running", () => {
    assert.doesNotThrow(() => stopScheduler(), "stopScheduler on idle should not throw");
  });
});

/* ── idempotency ────────────────────────────────────────────────────── */

describe("[arena-scheduler] idempotency", () => {
  test("startScheduler with same interval is no-op (does not double-register)", async () => {
    _setSchedulerDepsForTests({
      getPrefs: makePrefs(true, 60_000),
      runCycle: noopCycle(),
      setIntervalFn: fakeTimers.setInterval as never,
      clearIntervalFn: fakeTimers.clearInterval as never,
    });
    await startScheduler();
    await startScheduler(); // second call — same interval
    assert.equal(fakeTimers.count(), 1, "should not register duplicate timers");
  });

  test("startScheduler with different interval replaces old timer", async () => {
    _setSchedulerDepsForTests({
      getPrefs: makePrefs(true, 60_000),
      runCycle: noopCycle(),
      setIntervalFn: fakeTimers.setInterval as never,
      clearIntervalFn: fakeTimers.clearInterval as never,
    });
    await startScheduler();
    const firstTimer = fakeTimers.getFirst();

    // change interval
    _setSchedulerDepsForTests({
      getPrefs: makePrefs(true, 120_000),
      runCycle: noopCycle(),
      setIntervalFn: fakeTimers.setInterval as never,
      clearIntervalFn: fakeTimers.clearInterval as never,
    });
    await restartScheduler();
    const secondTimer = fakeTimers.getFirst();

    assert.ok(secondTimer, "new timer should exist");
    assert.notEqual(firstTimer?.id, secondTimer?.id, "timer should be replaced");
    assert.equal(secondTimer?.intervalMs, 120_000, "new interval applied");
  });
});

/* ── restartScheduler ───────────────────────────────────────────────── */

describe("[arena-scheduler] restartScheduler", () => {
  test("restartScheduler stops then starts", async () => {
    _setSchedulerDepsForTests({
      getPrefs: makePrefs(true, 60_000),
      runCycle: noopCycle(),
      setIntervalFn: fakeTimers.setInterval as never,
      clearIntervalFn: fakeTimers.clearInterval as never,
    });
    await startScheduler();
    assert.equal(isSchedulerRunning(), true);
    await restartScheduler();
    assert.equal(isSchedulerRunning(), true, "should still be running after restart");
    assert.equal(fakeTimers.count(), 1, "exactly one timer after restart");
  });

  test("restartScheduler with arenaEnabled=false stops scheduler", async () => {
    _setSchedulerDepsForTests({
      getPrefs: makePrefs(true, 60_000),
      runCycle: noopCycle(),
      setIntervalFn: fakeTimers.setInterval as never,
      clearIntervalFn: fakeTimers.clearInterval as never,
    });
    await startScheduler();
    assert.equal(isSchedulerRunning(), true);

    _setSchedulerDepsForTests({
      getPrefs: makePrefs(false),
      runCycle: noopCycle(),
      setIntervalFn: fakeTimers.setInterval as never,
      clearIntervalFn: fakeTimers.clearInterval as never,
    });
    await restartScheduler();
    assert.equal(isSchedulerRunning(), false, "should stop when arena disabled after restart");
  });
});

/* ── lock guard ─────────────────────────────────────────────────────── */

describe("[arena-scheduler] GlobalLlmLock guard on tick", () => {
  test("tick is skipped and skipCount increases when lock is busy", async () => {
    let cyclesCalled = 0;
    globalLlmLock.registerProbe("fake-import", () => ({ busy: true, reason: "3 imports" }));

    _setSchedulerDepsForTests({
      getPrefs: makePrefs(true, 60_000),
      runCycle: async () => { cyclesCalled++; return { ok: true, message: "ran" } as never; },
      setIntervalFn: fakeTimers.setInterval as never,
      clearIntervalFn: fakeTimers.clearInterval as never,
    });
    await startScheduler();

    // Fire the timer callback
    fakeTimers.tickAll();
    // Give async tick() a chance to complete
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(cyclesCalled, 0, "cycle should NOT run when lock busy");
    const status = globalLlmLock.getStatus();
    assert.equal(status.skipCount, 1, "skipCount should be incremented");
  });

  test("tick runs cycle when lock is not busy", async () => {
    let cyclesCalled = 0;
    // No probes registered → lock is not busy

    _setSchedulerDepsForTests({
      getPrefs: makePrefs(true, 60_000),
      runCycle: async () => { cyclesCalled++; return { ok: true, message: "ran" } as never; },
      setIntervalFn: fakeTimers.setInterval as never,
      clearIntervalFn: fakeTimers.clearInterval as never,
    });
    await startScheduler();

    fakeTimers.tickAll();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(cyclesCalled, 1, "cycle should run when lock is idle");
  });
});
