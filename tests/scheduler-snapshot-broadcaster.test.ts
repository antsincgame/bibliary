/**
 * Scheduler Snapshot Broadcaster — тесты periodic poll и change detection.
 *
 * Используем мок BrowserWindow + spy на webContents.send для проверки emit'ов.
 * Используем real ImportTaskScheduler singleton (с reset перед каждым тестом).
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "./helpers/expect-shim.ts";
import {
  startSchedulerSnapshotBroadcaster,
  stopSchedulerSnapshotBroadcaster,
  forceBroadcastSchedulerSnapshot,
  _resetSchedulerSnapshotBroadcasterForTests,
  _getLastSnapshotJsonForTests,
} from "../electron/lib/resilience/scheduler-snapshot-broadcaster.js";
import {
  getImportScheduler,
  _resetImportSchedulerForTests,
} from "../electron/lib/library/import-task-scheduler.js";

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
  _resetSchedulerSnapshotBroadcasterForTests();
  _resetImportSchedulerForTests();
});

afterEach(() => {
  _resetSchedulerSnapshotBroadcasterForTests();
  _resetImportSchedulerForTests();
});

describe("scheduler-snapshot-broadcaster — start/stop", () => {
  it("startSchedulerSnapshotBroadcaster + stopSchedulerSnapshotBroadcaster — базовый lifecycle", () => {
    const win = makeFakeWindow();
    /* Минимальный intervalMs = 50 ms чтобы тест не ждал 2 секунды. */
    startSchedulerSnapshotBroadcaster(() => win as never, { intervalMs: 50 });
    /* Сразу не должно быть emit'ов — broadcaster ждёт первого тика. */
    expect(win.webContents.sentEvents.length).toBe(0);

    stopSchedulerSnapshotBroadcaster();
    /* После stop никаких новых emit'ов. */
    expect(win.webContents.sentEvents.length).toBe(0);
  });

  it("повторный startSchedulerSnapshotBroadcaster — idempotent (не плодит таймеры)", () => {
    const win = makeFakeWindow();
    startSchedulerSnapshotBroadcaster(() => win as never, { intervalMs: 50 });
    startSchedulerSnapshotBroadcaster(() => win as never, { intervalMs: 50 });
    /* Не должно быть ошибок или дублей. Stop затем должен корректно отключить. */
    stopSchedulerSnapshotBroadcaster();
    expect(win.webContents.sentEvents.length).toBe(0);
  });
});

describe("scheduler-snapshot-broadcaster — emit поведение", () => {
  it("forceBroadcastSchedulerSnapshot эмитит сразу, без ожидания тика", () => {
    const win = makeFakeWindow();
    startSchedulerSnapshotBroadcaster(() => win as never, { intervalMs: 60_000 });
    forceBroadcastSchedulerSnapshot();
    expect(win.webContents.sentEvents.length).toBe(1);
    expect(win.webContents.sentEvents[0]?.channel).toBe("resilience:scheduler-snapshot");
    /* Snapshot shape — 3 lanes присутствуют (Иt 8В.MAIN.1.5: io удалена). */
    const payload = win.webContents.sentEvents[0]?.payload as Record<string, unknown>;
    expect(payload).toBeDefined();
    expect(payload.light).toBeDefined();
    expect(payload.medium).toBeDefined();
    expect(payload.heavy).toBeDefined();
    stopSchedulerSnapshotBroadcaster();
  });

  it("первый tick всегда эмитит (initial state ≠ last cached)", async () => {
    const win = makeFakeWindow();
    startSchedulerSnapshotBroadcaster(() => win as never, { intervalMs: 30 });
    /* Подождём один tick + buffer. */
    await new Promise((r) => setTimeout(r, 60));
    expect(win.webContents.sentEvents.length).toBeGreaterThanOrEqual(1);
    stopSchedulerSnapshotBroadcaster();
  });

  it("change detection: пустой snapshot не повторяется на каждом тике", async () => {
    const win = makeFakeWindow();
    startSchedulerSnapshotBroadcaster(() => win as never, { intervalMs: 20 });
    /* 3 тика по 20 ms = 60 ms + buffer */
    await new Promise((r) => setTimeout(r, 100));
    /* Первый tick — emit (initial). Последующие — no emit (snapshot не менялся). */
    const emits = win.webContents.sentEvents.length;
    expect(emits).toBeGreaterThanOrEqual(1);
    expect(emits).toBeLessThanOrEqual(3); /* строго ≤ 3 несмотря на 5+ tick'ов */
    stopSchedulerSnapshotBroadcaster();
  });

  it("emit при изменении snapshot — добавление task в lane", async () => {
    const win = makeFakeWindow();
    startSchedulerSnapshotBroadcaster(() => win as never, { intervalMs: 30 });
    await new Promise((r) => setTimeout(r, 50)); /* первый tick */
    const initialCount = win.webContents.sentEvents.length;
    expect(initialCount).toBeGreaterThanOrEqual(1);

    /* Меняем scheduler state — добавляем долго работающую задачу в heavy lane. */
    const sched = getImportScheduler();
    let resolveTask: (() => void) | null = null;
    const taskPromise = sched.enqueue("heavy", async () => {
      await new Promise<void>((r) => { resolveTask = r; });
    });

    /* Подождём следующий tick */
    await new Promise((r) => setTimeout(r, 50));
    /* Должен быть второй emit (snapshot изменился: heavy.running=1). */
    expect(win.webContents.sentEvents.length).toBeGreaterThan(initialCount);
    /* Cleanup: отпускаем task чтобы она не висела */
    if (resolveTask) (resolveTask as () => void)();
    await taskPromise;
    stopSchedulerSnapshotBroadcaster();
  });
});

describe("scheduler-snapshot-broadcaster — graceful behavior", () => {
  it("если windowGetter вернул null — emit пропускается без throw", () => {
    startSchedulerSnapshotBroadcaster(() => null, { intervalMs: 60_000 });
    /* Не throw на forceBroadcast */
    forceBroadcastSchedulerSnapshot();
    /* Никаких событий — нечего проверять кроме absence of throw */
    stopSchedulerSnapshotBroadcaster();
  });

  it("destroyed window — emit пропускается", () => {
    const win = {
      isDestroyed: () => true,
      webContents: {
        sentEvents: [] as Array<{ channel: string; payload: unknown }>,
        send: (channel: string, payload: unknown) => {
          this.sentEvents.push({ channel, payload });
        },
      },
    };
    startSchedulerSnapshotBroadcaster(() => win as never, { intervalMs: 60_000 });
    forceBroadcastSchedulerSnapshot();
    expect(win.webContents.sentEvents.length).toBe(0);
    stopSchedulerSnapshotBroadcaster();
  });

  it("stopSchedulerSnapshotBroadcaster сбрасывает lastSnapshotJson cache", () => {
    const win = makeFakeWindow();
    startSchedulerSnapshotBroadcaster(() => win as never, { intervalMs: 60_000 });
    forceBroadcastSchedulerSnapshot();
    expect(_getLastSnapshotJsonForTests()).not.toBe("");

    stopSchedulerSnapshotBroadcaster();
    expect(_getLastSnapshotJsonForTests()).toBe("");
  });
});
