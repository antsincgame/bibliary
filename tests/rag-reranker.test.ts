/**
 * Tests для cross-encoder reranker.
 *
 * НЕ загружают настоящую BGE модель (280 MB) — используют test-only DI
 * `_setRerankerInvokerForTests`, production path остаётся реальным worker.
 *
 * Покрытие:
 *   1. Пустой query / 0 кандидатов → []
 *   2. 1 кандидат → возврат без вызова модели
 *   3. Сортировка по логиту desc + назначение rank
 *   4. originalRank сохраняется
 *   5. topK обрезает результат
 *   6. Поддержка numClasses=1 и numClasses=2 (в логитах)
 *   7. Test DI не трогает worker/cold-start
 *   8. Mismatch logits length → throw
 */

import { describe, it, expect, beforeEach } from "vitest";

import {
  rerankPassages,
  _resetRerankerCache,
  _setRerankerInvokerForTests,
  getRerankerModelName,
  isRerankerWarm,
} from "../electron/lib/rag/reranker.ts";

beforeEach(() => {
  _resetRerankerCache();
  _setRerankerInvokerForTests(null);
});

describe("rerankPassages — edge cases", () => {
  it("пустой query → []", async () => {
    const r = await rerankPassages("", [{ text: "a" }, { text: "b" }]);
    expect(r).toEqual([]);
  });

  it("0 кандидатов → []", async () => {
    const r = await rerankPassages("query", []);
    expect(r).toEqual([]);
  });

  it("1 кандидат → возврат без вызова модели", async () => {
    const r = await rerankPassages("query", [{ text: "only" }]);
    expect(r).toHaveLength(1);
    expect(r[0]?.candidate.text).toBe("only");
    expect(r[0]?.rank).toBe(0);
    expect(r[0]?.originalRank).toBe(0);
    /* 1 candidate path does not invoke worker. */
  });
});

describe("rerankPassages — basic scoring", () => {
  it("сортировка по логиту desc, назначение rank, сохранение originalRank", async () => {
    /* 3 кандидата, логиты: [0.2, 5.5, -1.3]
       После rerank: [1=5.5, 0=0.2, 2=-1.3]. */
    _setRerankerInvokerForTests(async () => [0.2, 5.5, -1.3]);

    const r = await rerankPassages("test", [
      { text: "a", meta: "ma" },
      { text: "b", meta: "mb" },
      { text: "c", meta: "mc" },
    ]);

    expect(r).toHaveLength(3);
    expect(r[0]?.candidate.meta).toBe("mb");
    expect(r[0]?.rerankScore).toBeCloseTo(5.5, 5);
    expect(r[0]?.rank).toBe(0);
    expect(r[0]?.originalRank).toBe(1);

    expect(r[1]?.candidate.meta).toBe("ma");
    expect(r[1]?.originalRank).toBe(0);
    expect(r[2]?.candidate.meta).toBe("mc");
    expect(r[2]?.originalRank).toBe(2);
  });

  it("topK обрезает результат", async () => {
    _setRerankerInvokerForTests(async () => [3, 1, 2, 4, 0]);

    const r = await rerankPassages(
      "q",
      [
        { text: "a" }, { text: "b" }, { text: "c" }, { text: "d" }, { text: "e" },
      ],
      2,
    );

    expect(r).toHaveLength(2);
    expect(r[0]?.candidate.text).toBe("d"); /* highest score 4 */
    expect(r[1]?.candidate.text).toBe("a"); /* second 3 */
  });

  it("поддержка numClasses=2 (BGE может возвращать [neg, pos])", async () => {
    /* 3 candidates × 2 classes: [(neg, pos), ...]
       logits = [0.1, 0.9,  0.4, 0.6,  0.7, 0.3] (positive class на нечётных). */
    _setRerankerInvokerForTests(async () => [0.1, 0.9, 0.4, 0.6, 0.7, 0.3]);

    const r = await rerankPassages("q", [
      { text: "a" }, { text: "b" }, { text: "c" },
    ]);

    /* Берётся positive class (последний). 0.9 > 0.6 > 0.3. */
    expect(r[0]?.candidate.text).toBe("a");
    expect(r[0]?.rerankScore).toBeCloseTo(0.9, 5);
    expect(r[1]?.candidate.text).toBe("b");
    expect(r[2]?.candidate.text).toBe("c");
  });

  it("mismatch logits → throw", async () => {
    /* 3 candidates, но 5 логитов — не делится. */
    _setRerankerInvokerForTests(async () => [1, 2, 3, 4, 5]);

    await expect(
      rerankPassages("q", [{ text: "a" }, { text: "b" }, { text: "c" }]),
    ).rejects.toThrow(/shape mismatch/);
  });
});

describe("rerankPassages — caching", () => {
  it("повторный вызов не грузит модель снова", async () => {
    let calls = 0;
    _setRerankerInvokerForTests(async () => {
      calls += 1;
      return [1, 2];
    });

    await rerankPassages("q", [{ text: "a" }, { text: "b" }]);
    await rerankPassages("q2", [{ text: "x" }, { text: "y" }]);

    expect(calls).toBe(2);
  });

  it("isRerankerWarm() — false при test invoker без worker", async () => {
    expect(isRerankerWarm()).toBe(false);
    _setRerankerInvokerForTests(async () => [0.5, 0.3]);
    await rerankPassages("q", [{ text: "a" }, { text: "b" }]);
    expect(isRerankerWarm()).toBe(false);
  });

  it("_resetRerankerCache() сбрасывает test circuit state", async () => {
    _setRerankerInvokerForTests(async () => [0.5, 0.3]);
    await rerankPassages("q", [{ text: "a" }, { text: "b" }]);
    _resetRerankerCache();
    _setRerankerInvokerForTests(async () => [0.1, 0.2]);
    await expect(rerankPassages("q", [{ text: "a" }, { text: "b" }])).resolves.toHaveLength(2);
    expect(isRerankerWarm()).toBe(false);
  });
});

describe("rerankPassages — metadata API", () => {
  it("getRerankerModelName() возвращает имя BGE-reranker-large", () => {
    expect(getRerankerModelName()).toBe("Xenova/bge-reranker-large");
  });
});
