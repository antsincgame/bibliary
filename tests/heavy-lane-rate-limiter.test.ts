/**
 * Heavy Lane Rate Limiter — sliding-window лимитер для vision-OCR DDoS защиты.
 *
 * Тесты используют fake clock (передаётся через opts.now), чтобы не ждать
 * реальной минуты. Sleep'ы при limit reached измеряются через сравнение
 * до/после `now()`.
 */

import { describe, it } from "node:test";
import { expect } from "./helpers/expect-shim.ts";
import { HeavyLaneRateLimiter } from "../server/lib/scanner/_vendor/llm/heavy-lane-rate-limiter.js";

describe("HeavyLaneRateLimiter — basic acquire", () => {
  it("первые N acquire (N <= limit) проходят immediately", async () => {
    const limiter = new HeavyLaneRateLimiter({ limitPerMinute: 5 });
    const start = Date.now();
    for (let i = 0; i < 5; i++) {
      await limiter.acquire("model-a");
    }
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(100); /* фактически мгновенно */
    expect(limiter.currentInWindow("model-a")).toBe(5);
  });

  it("acquire после превышения limit ждёт; AbortSignal корректно отменяет ожидание", async () => {
    /* Лимит 2, после превышения acquire должен заблокироваться. */
    const limiter = new HeavyLaneRateLimiter({ limitPerMinute: 2 });

    await limiter.acquire("model-a");
    await limiter.acquire("model-a");

    /* Третий acquire должен ждать. Используем AbortController чтобы отменить
       ожидание (иначе тест бы висел реальные 60 сек на setTimeout). */
    const ctl = new AbortController();
    let resolved = false;
    const p = limiter.acquire("model-a", ctl.signal).then(() => { resolved = true; });
    /* Критично: catch синхронно регистрируется чтобы не было unhandledRejection. */
    p.catch(() => undefined);

    await new Promise((r) => setTimeout(r, 50));
    expect(resolved).toBe(false); /* ждёт, не резолвилась */

    ctl.abort();
    await expect(p).rejects.toThrow(/aborted/);
    expect(resolved).toBe(false); /* реально не резолвилась */
  });

  it("per-modelKey изоляция: разные модели не блокируют друг друга", async () => {
    const limiter = new HeavyLaneRateLimiter({ limitPerMinute: 1 });
    await limiter.acquire("model-a");
    /* model-b совершенно отдельная очередь — должна пройти immediately. */
    const start = Date.now();
    await limiter.acquire("model-b");
    expect(Date.now() - start).toBeLessThan(50);
    expect(limiter.currentInWindow("model-a")).toBe(1);
    expect(limiter.currentInWindow("model-b")).toBe(1);
  });

  it("acquire с aborted signal throws сразу", async () => {
    const limiter = new HeavyLaneRateLimiter({ limitPerMinute: 1 });
    const ctl = new AbortController();
    ctl.abort();
    await expect(limiter.acquire("model-a", ctl.signal)).rejects.toThrow(/aborted/);
  });

  it("evict expired: после смещения clock на 60+ сек окно очищается", async () => {
    let fakeNow = 1_000_000;
    const limiter = new HeavyLaneRateLimiter({
      limitPerMinute: 2,
      now: () => fakeNow,
    });
    await limiter.acquire("model-a");
    await limiter.acquire("model-a");
    expect(limiter.currentInWindow("model-a")).toBe(2);

    /* Смещаем clock на 61 сек — оба таймстампа должны выпасть. */
    fakeNow += 61_000;
    expect(limiter.currentInWindow("model-a")).toBe(0);
  });

  it("getLimit возвращает текущий лимит", () => {
    const limiter = new HeavyLaneRateLimiter({ limitPerMinute: 42 });
    expect(limiter.getLimit()).toBe(42);
  });

  it("default limit когда не передан = 60", () => {
    const limiter = new HeavyLaneRateLimiter();
    expect(limiter.getLimit()).toBe(60);
  });

  it("min limit = 1 даже если переданы 0 или отрицательное", () => {
    expect(new HeavyLaneRateLimiter({ limitPerMinute: 0 }).getLimit()).toBe(1);
    expect(new HeavyLaneRateLimiter({ limitPerMinute: -5 }).getLimit()).toBe(1);
  });

  it("reset очищает state", async () => {
    const limiter = new HeavyLaneRateLimiter({ limitPerMinute: 5 });
    await limiter.acquire("model-a");
    await limiter.acquire("model-b");
    limiter.reset();
    expect(limiter.currentInWindow("model-a")).toBe(0);
    expect(limiter.currentInWindow("model-b")).toBe(0);
  });
});
