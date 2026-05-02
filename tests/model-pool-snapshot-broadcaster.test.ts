/**
 * Model Pool Snapshot Broadcaster — тесты periodic poll и change detection
 * (Иt 8В MAIN.4).
 *
 * Шаблон зеркальный с tests/scheduler-snapshot-broadcaster.test.ts чтобы
 * единый паттерн broadcaster был покрыт идентичными ожиданиями.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "./helpers/expect-shim.ts";
import {
  startModelPoolSnapshotBroadcaster,
  stopModelPoolSnapshotBroadcaster,
  forceBroadcastModelPoolSnapshot,
  _resetModelPoolSnapshotBroadcasterForTests,
  _getLastModelPoolSnapshotJsonForTests,
} from "../electron/lib/resilience/model-pool-snapshot-broadcaster.js";

interface FakeWindow {
  isDestroyed(): boolean;
  webContents: {
    sentEvents: Array<{ channel: string; payload: unknown }>;
    send: (channel: string, payload: unknown) => void;
  };
}

function makeFakeWindow(): FakeWindow {
  const sentEvents: Array<{ channel: string; payload: unknown }> = [];
  return {
    isDestroyed: () => false,
    webContents: {
      sentEvents,
      send: (channel: string, payload: unknown) => {
        sentEvents.push({ channel, payload });
      },
    },
  };
}

beforeEach(() => {
  _resetModelPoolSnapshotBroadcasterForTests();
});

afterEach(() => {
  _resetModelPoolSnapshotBroadcasterForTests();
});

describe("model-pool-snapshot-broadcaster — start/stop", () => {
  it("start + stop — базовый lifecycle, никаких сразу emit'ов", () => {
    const win = makeFakeWindow();
    startModelPoolSnapshotBroadcaster(() => win as never, { intervalMs: 50 });
    expect(win.webContents.sentEvents.length).toBe(0);
    stopModelPoolSnapshotBroadcaster();
    expect(win.webContents.sentEvents.length).toBe(0);
  });

  it("повторный start — idempotent (не плодит таймеры)", () => {
    const win = makeFakeWindow();
    startModelPoolSnapshotBroadcaster(() => win as never, { intervalMs: 50 });
    startModelPoolSnapshotBroadcaster(() => win as never, { intervalMs: 50 });
    stopModelPoolSnapshotBroadcaster();
    expect(win.webContents.sentEvents.length).toBe(0);
  });
});

describe("model-pool-snapshot-broadcaster — emit поведение", () => {
  it("forceBroadcastModelPoolSnapshot эмитит сразу с правильным channel + payload shape", () => {
    const win = makeFakeWindow();
    startModelPoolSnapshotBroadcaster(() => win as never, { intervalMs: 60_000 });
    forceBroadcastModelPoolSnapshot();
    expect(win.webContents.sentEvents.length).toBe(1);
    expect(win.webContents.sentEvents[0]?.channel).toBe("resilience:model-pool-snapshot");
    const payload = win.webContents.sentEvents[0]?.payload as Record<string, unknown>;
    expect(payload).toBeDefined();
    /* Базовая shape — четыре обязательных поля. */
    expect(typeof payload.capacityMB).toBe("number");
    expect(typeof payload.totalLoadedMB).toBe("number");
    expect(typeof payload.loadedCount).toBe("number");
    expect(Array.isArray(payload.models)).toBe(true);
    stopModelPoolSnapshotBroadcaster();
  });

  it("первый tick всегда эмитит (initial state ≠ last cached '')", async () => {
    const win = makeFakeWindow();
    startModelPoolSnapshotBroadcaster(() => win as never, { intervalMs: 30 });
    await new Promise((r) => setTimeout(r, 60));
    expect(win.webContents.sentEvents.length).toBeGreaterThanOrEqual(1);
    stopModelPoolSnapshotBroadcaster();
  });

  it("change detection: пустой пул не повторяется на каждом тике", async () => {
    const win = makeFakeWindow();
    startModelPoolSnapshotBroadcaster(() => win as never, { intervalMs: 20 });
    await new Promise((r) => setTimeout(r, 100));
    const emits = win.webContents.sentEvents.length;
    expect(emits).toBeGreaterThanOrEqual(1);
    expect(emits).toBeLessThanOrEqual(3);
    stopModelPoolSnapshotBroadcaster();
  });
});

describe("model-pool-snapshot-broadcaster — graceful behavior", () => {
  it("если windowGetter вернул null — emit пропускается без throw", () => {
    startModelPoolSnapshotBroadcaster(() => null, { intervalMs: 60_000 });
    forceBroadcastModelPoolSnapshot();
    stopModelPoolSnapshotBroadcaster();
  });

  it("destroyed window — emit пропускается", () => {
    const sentEvents: Array<{ channel: string; payload: unknown }> = [];
    const win = {
      isDestroyed: () => true,
      webContents: {
        sentEvents,
        send: (channel: string, payload: unknown) => {
          sentEvents.push({ channel, payload });
        },
      },
    };
    startModelPoolSnapshotBroadcaster(() => win as never, { intervalMs: 60_000 });
    forceBroadcastModelPoolSnapshot();
    expect(win.webContents.sentEvents.length).toBe(0);
    stopModelPoolSnapshotBroadcaster();
  });

  it("stop сбрасывает lastSnapshotJson cache", () => {
    const win = makeFakeWindow();
    startModelPoolSnapshotBroadcaster(() => win as never, { intervalMs: 60_000 });
    forceBroadcastModelPoolSnapshot();
    expect(_getLastModelPoolSnapshotJsonForTests()).not.toBe("");

    stopModelPoolSnapshotBroadcaster();
    expect(_getLastModelPoolSnapshotJsonForTests()).toBe("");
  });
});
