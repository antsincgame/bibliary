/**
 * Tests для illustration semaphore.
 *
 * Покрытие:
 *   1. Capacity respect: > capacity параллельных run() сериализуются
 *   2. FIFO порядок очереди
 *   3. Drain ждёт всех (active + queued)
 *   4. setCapacity на лету пробуждает ожидающих
 *   5. setCapacity(0) ставит на паузу
 *   6. Ошибка в task не блокирует семафор (release всё равно)
 *   7. getStatus возвращает правильные числа
 */

import { describe, it, expect, beforeEach } from "vitest";
import { IllustrationSemaphore } from "../electron/lib/library/illustration-semaphore.ts";

describe("IllustrationSemaphore", () => {
  let sem: IllustrationSemaphore;

  beforeEach(() => {
    sem = new IllustrationSemaphore(2);
  });

  it("позволяет параллельный запуск до capacity", async () => {
    const observed: number[] = [];
    let active = 0;
    let maxActive = 0;

    const task = async (id: number): Promise<void> => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      observed.push(id);
      await new Promise((r) => setTimeout(r, 10));
      active -= 1;
    };

    await Promise.all([
      sem.run(() => task(1)),
      sem.run(() => task(2)),
      sem.run(() => task(3)),
      sem.run(() => task(4)),
      sem.run(() => task(5)),
    ]);

    expect(maxActive).toBeLessThanOrEqual(2);
    expect(observed.length).toBe(5);
  });

  it("при capacity=1 — строго последовательная обработка", async () => {
    const sem1 = new IllustrationSemaphore(1);
    const order: number[] = [];

    const task = async (id: number): Promise<void> => {
      order.push(id);
      await new Promise((r) => setTimeout(r, 5));
    };

    await Promise.all([
      sem1.run(() => task(1)),
      sem1.run(() => task(2)),
      sem1.run(() => task(3)),
    ]);

    expect(order).toEqual([1, 2, 3]);
  });

  it("drain() ждёт active + queued", async () => {
    let completed = 0;
    const task = async (): Promise<void> => {
      await new Promise((r) => setTimeout(r, 30));
      completed += 1;
    };

    /* Запускаем 4 jobs (capacity=2 → 2 active + 2 queued). */
    void sem.run(task);
    void sem.run(task);
    void sem.run(task);
    void sem.run(task);

    /* Сразу status — 2 active, 2 queued. */
    const initial = sem.getStatus();
    expect(initial.active).toBe(2);
    expect(initial.queued).toBe(2);

    await sem.drain();

    expect(completed).toBe(4);
    const final = sem.getStatus();
    expect(final.active).toBe(0);
    expect(final.queued).toBe(0);
  });

  it("ошибка в task не блокирует семафор", async () => {
    const sem1 = new IllustrationSemaphore(1);
    const completed: string[] = [];

    /* Первый таск падает, второй должен всё равно выполниться. */
    void sem1.run(async () => {
      throw new Error("boom");
    }).catch(() => undefined);

    await sem1.run(async () => {
      completed.push("ok");
    });

    expect(completed).toEqual(["ok"]);
  });

  it("getStatus отражает текущее состояние", async () => {
    const initial = sem.getStatus();
    expect(initial).toEqual({ active: 0, queued: 0, capacity: 2 });

    /* Запускаем 3 jobs с задержкой. */
    const promises = [1, 2, 3].map((_) =>
      sem.run(async () => {
        await new Promise((r) => setTimeout(r, 30));
      }),
    );

    /* Микротаск ждёт чтобы run() начал выполнение. */
    await new Promise((r) => setTimeout(r, 0));

    const mid = sem.getStatus();
    expect(mid.active).toBe(2);
    expect(mid.queued).toBe(1);
    expect(mid.capacity).toBe(2);

    await Promise.all(promises);
  });

  it("setCapacity(0) останавливает обработку", async () => {
    const sem1 = new IllustrationSemaphore(2);
    let completed = 0;

    /* Сразу ставим capacity=0 — ничего не должно стартовать. */
    sem1.setCapacity(0);

    const promises = [1, 2, 3].map(() =>
      sem1.run(async () => {
        completed += 1;
      }),
    );

    await new Promise((r) => setTimeout(r, 30));
    expect(completed).toBe(0);
    expect(sem1.getStatus().queued).toBe(3);

    /* Восстанавливаем — все должны выполниться. */
    sem1.setCapacity(2);
    await Promise.all(promises);
    expect(completed).toBe(3);
  });

  it("FIFO порядок при пробуждении из очереди", async () => {
    const sem1 = new IllustrationSemaphore(1);
    const order: number[] = [];

    const task = async (id: number): Promise<void> => {
      order.push(id);
      await new Promise((r) => setTimeout(r, 5));
    };

    /* 5 jobs в очередь (capacity=1). FIFO означает что они выполнятся
       строго в порядке 1,2,3,4,5. */
    await Promise.all([
      sem1.run(() => task(1)),
      sem1.run(() => task(2)),
      sem1.run(() => task(3)),
      sem1.run(() => task(4)),
      sem1.run(() => task(5)),
    ]);

    expect(order).toEqual([1, 2, 3, 4, 5]);
  });
});
