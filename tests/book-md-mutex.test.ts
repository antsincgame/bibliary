/**
 * Иt 8Г.1 — book-md-mutex: per-bookId сериализация + AbortSignal + cleanup.
 *
 * Регрессионная защита от lost-update при конкурирующих writer'ах одного
 * book.md (raw text + frontmatter). Изначально была между evaluator и
 * illustration-worker (последний удалён в 2026-05); сейчас актуально для
 * любого пайплайна который пишет тот же mdPath с разных scheduler lanes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  withBookMdLock,
  getBookMdLockStats,
  _resetBookMdLocksForTests,
} from "../electron/lib/library/book-md-mutex.ts";

test.beforeEach(() => {
  _resetBookMdLocksForTests();
});

test("[Г.1] withBookMdLock: тот же bookId — FIFO сериализация (нет наложения окон)", async () => {
  const order: string[] = [];
  const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  const a = withBookMdLock("book-1", async () => {
    order.push("A:start");
    await wait(20);
    order.push("A:end");
  });

  /* Очерёдность регистрации: B стартует ПОСЛЕ A (микротик). */
  await wait(1);
  const b = withBookMdLock("book-1", async () => {
    order.push("B:start");
    await wait(5);
    order.push("B:end");
  });

  await Promise.all([a, b]);

  /* Ожидаем строго: A полностью → B полностью. */
  assert.deepStrictEqual(order, ["A:start", "A:end", "B:start", "B:end"]);
});

test("[Г.1] withBookMdLock: разные bookId — параллельны (нет лишней сериализации)", async () => {
  const order: string[] = [];
  const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  const a = withBookMdLock("book-A", async () => {
    order.push("A:start");
    await wait(20);
    order.push("A:end");
  });
  const b = withBookMdLock("book-B", async () => {
    order.push("B:start");
    await wait(5);
    order.push("B:end");
  });

  await Promise.all([a, b]);

  /* B короче — должен закончиться раньше A. */
  assert.strictEqual(order[0], "A:start");
  assert.strictEqual(order[1], "B:start");
  assert.strictEqual(order[2], "B:end");
  assert.strictEqual(order[3], "A:end");
});

test("[Г.1] withBookMdLock: ошибка одной операции не ломает следующую", async () => {
  let bRan = false;

  const a = withBookMdLock("book-1", async () => {
    throw new Error("evaluator failed");
  }).catch((e) => e);

  const b = withBookMdLock("book-1", async () => {
    bRan = true;
    return "ok";
  });

  const aErr = await a;
  const bRes = await b;

  assert.match((aErr as Error).message, /evaluator failed/);
  assert.strictEqual(bRan, true);
  assert.strictEqual(bRes, "ok");
});

test("[Г.1] withBookMdLock: AbortSignal до acquire — fn не запускается", async () => {
  const ctrl = new AbortController();
  ctrl.abort("user cancel");

  let ran = false;
  await assert.rejects(
    withBookMdLock("book-1", async () => {
      ran = true;
    }, { signal: ctrl.signal }),
    /cancel|abort/i,
  );
  assert.strictEqual(ran, false);
});

test("[Г.1] withBookMdLock: AbortSignal во время ожидания предыдущего — fn не запускается", async () => {
  const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  const ctrl = new AbortController();
  let bRan = false;

  const a = withBookMdLock("book-1", async () => {
    await wait(30);
  });

  /* B встаёт за A в очередь и ждёт. Прерываем во время ожидания. */
  const b = withBookMdLock("book-1", async () => {
    bRan = true;
  }, { signal: ctrl.signal });

  await wait(5);
  ctrl.abort("user cancel during wait");

  await a;
  await assert.rejects(b, /cancel|abort/i);
  assert.strictEqual(bRan, false);
});

test("[Г.1] withBookMdLock: освобождает entry после завершения (нет утечки)", async () => {
  await withBookMdLock("book-1", async () => "ok");
  /* Сразу после finally entry должен быть удалён (за нами никого). */
  assert.strictEqual(getBookMdLockStats().count, 0);
});

test("[Г.1] withBookMdLock: regression lost-update — последовательная RMW не теряет данные", async () => {
  /* Симулируем гонку evaluator+illustration: оба читают, модифицируют,
     пишут одно «in-memory shared state». Без mutex здесь lost update;
     с mutex — обе модификации сохранены. */
  let sharedDoc = "frontmatter:initial\nbody:initial";
  const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  const evaluatorRMW = withBookMdLock("book-1", async () => {
    const snapshot = sharedDoc;
    await wait(20);
    /* «evaluator» обновляет frontmatter, body не меняет */
    sharedDoc = snapshot.replace("frontmatter:initial", "frontmatter:scored");
  });

  await wait(1);
  const illustrationRMW = withBookMdLock("book-1", async () => {
    const snapshot = sharedDoc;
    await wait(5);
    /* Параллельный writer'ы обновляет body, frontmatter не меняет */
    sharedDoc = snapshot.replace("body:initial", "body:enriched");
  });

  await Promise.all([evaluatorRMW, illustrationRMW]);

  /* Обе модификации должны быть сохранены. Без mutex — последний победил
     бы и одна правка потерялась. */
  assert.match(sharedDoc, /frontmatter:scored/);
  assert.match(sharedDoc, /body:enriched/);
});
