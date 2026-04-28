/**
 * Unit tests for electron/lib/llm/arena/scheduler.ts
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

function makePrefs(arenaEnabled: boolean, intervalMs = 3_600_000) {
  return async () => ({ arenaEnabled, arenaCycleIntervalMs: intervalMs });
}

function noopCycle() {
  return async () => ({ ok: true, message: "noop" } as never);
}

let fakeTimers: FakeTimerRegistry;

beforeEach(() => {
  stopScheduler();
  _resetSchedulerForTests();
  globalLlmLock._resetForTests();
  fakeTimers = new FakeTimerRegistry();
});

afterEach(() => {
  stopScheduler();
  _resetSchedulerForTests();
  globalLlmLock._resetForTests();
});

describe("[arena-scheduler] start / stop", () => {
  test("scheduler does not start when arenaEnabled=false", async () => {
    _setSchedulerDepsForTests({
      getPrefs: makePrefs(false),
      runCycle: noopCycle(),
      setIntervalFn: fakeTimers.setInterval as never,
      clearIntervalFn: fakeTimers.clearInterval as never,
    });
    await startScheduler();
    assert.equal(isSchedulerRunning(), false);
    assert.equal(fakeTimers.count(), 0);
  });

  test("scheduler starts when arenaEnabled=true", async () => {
    _setSchedulerDepsForTests({
      getPrefs: makePrefs(true, 60_000),
      runCycle: noopCycle(),
      setIntervalFn: fakeTimers.setInterval as never,
      clearIntervalFn: fakeTimers.clearInterval as never,
    });
    await startScheduler();
    assert.equal(isSchedulerRunning(), true);
    assert.equal(fakeTimers.count(), 1);
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
    assert.equal(fakeTimers.count(), 0);
  });

  test("stopScheduler is safe to call when not running", () => {
    assert.doesNotThrow(() => stopScheduler());
  });
});

describe("[arena-scheduler] idempotency", () => {
  test("startScheduler with same interval is no-op", async () => {
    _setSchedulerDepsForTests({
      getPrefs: makePrefs(true, 60_000),
      runCycle: noopCycle(),
      setIntervalFn: fakeTimers.setInterval as never,
      clearIntervalFn: fakeTimers.clearInterval as never,
    });
    await startScheduler();
    await startScheduler();
    assert.equal(fakeTimers.count(), 1);
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

    _setSchedulerDepsForTests({
      getPrefs: makePrefs(true, 120_000),
      runCycle: noopCycle(),
      setIntervalFn: fakeTimers.setInterval as never,
      clearIntervalFn: fakeTimers.clearInterval as never,
    });
    await restartScheduler();
    const secondTimer = fakeTimers.getFirst();

    assert.ok(secondTimer);
    assert.notEqual(firstTimer?.id, secondTimer?.id);
    assert.equal(secondTimer?.intervalMs, 120_000);
  });
});

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
    assert.equal(isSchedulerRunning(), true);
    assert.equal(fakeTimers.count(), 1);
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
    assert.equal(isSchedulerRunning(), false);
  });
});

describe("[arena-scheduler] GlobalLlmLock guard on tick", () => {
  test("tick is skipped when lock is busy", async () => {
    let cyclesCalled = 0;
    globalLlmLock.registerProbe("fake-import", () => ({ busy: true, reason: "3 imports" }));

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

    assert.equal(cyclesCalled, 0);
    const status = globalLlmLock.getStatus();
    assert.equal(status.skipCount, 1);
  });

  test("tick runs cycle when lock is not busy", async () => {
    let cyclesCalled = 0;

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

    assert.equal(cyclesCalled, 1);
  });
});

describe("[arena-scheduler] re-entrancy guard", () => {
  test("second tick is skipped while previous cycle is still in progress", async () => {
    let cyclesStarted = 0;
    let resolveFirst: (() => void) | null = null;
    const firstFinished = new Promise<void>((resolve) => { resolveFirst = resolve; });

    _setSchedulerDepsForTests({
      getPrefs: makePrefs(true, 60_000),
      runCycle: async () => {
        cyclesStarted++;
        if (cyclesStarted === 1) await firstFinished;
        return { ok: true, message: "ran" } as never;
      },
      setIntervalFn: fakeTimers.setInterval as never,
      clearIntervalFn: fakeTimers.clearInterval as never,
    });
    await startScheduler();

    fakeTimers.tickAll();
    await Promise.resolve();
    fakeTimers.tickAll();
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(cyclesStarted, 1);
    const status = globalLlmLock.getStatus();
    assert.ok(status.skipCount >= 1);

    resolveFirst!();
    await firstFinished;
    await Promise.resolve();
    await Promise.resolve();

    fakeTimers.tickAll();
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(cyclesStarted, 2);
  });

  test("scheduler registers arena-cycle probe in globalLlmLock", async () => {
    _setSchedulerDepsForTests({
      getPrefs: makePrefs(true, 60_000),
      runCycle: noopCycle(),
      setIntervalFn: fakeTimers.setInterval as never,
      clearIntervalFn: fakeTimers.clearInterval as never,
    });
    await startScheduler();
    const status = globalLlmLock.getStatus();
    assert.ok(status.registeredProbes.includes("arena-cycle"));

    stopScheduler();
    const after = globalLlmLock.getStatus();
    assert.ok(!after.registeredProbes.includes("arena-cycle"));
  });

  test("stopScheduler aborts in-flight cycle via signal", async () => {
    let receivedSignal: AbortSignal | null = null;
    let resolveCycle: (() => void) | null = null;
    const cycleHang = new Promise<void>((r) => { resolveCycle = r; });

    _setSchedulerDepsForTests({
      getPrefs: makePrefs(true, 60_000),
      runCycle: async (opts) => {
        receivedSignal = opts?.signal ?? null;
        await cycleHang;
        return { ok: true, message: "ran" } as never;
      },
      setIntervalFn: fakeTimers.setInterval as never,
      clearIntervalFn: fakeTimers.clearInterval as never,
    });
    await startScheduler();

    fakeTimers.tickAll();
    await Promise.resolve();
    await Promise.resolve();

    assert.ok(receivedSignal);
    assert.equal(receivedSignal!.aborted, false);

    stopScheduler();
    assert.equal(receivedSignal!.aborted, true);

    resolveCycle!();
    await cycleHang;
  });
});
