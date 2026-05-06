/**
 * tests/chroma-scroll.test.ts
 *
 * Проверки `scrollChroma` paged generator:
 *   1. Один полный page → один yield → завершение
 *   2. Несколько страниц + неполная последняя → останов
 *   3. maxItems hard cap → останов до конца
 *   4. AbortSignal → throws "aborted"
 *   5. include передаётся в body
 *   6. where добавляется только если непустой
 */

import test from "node:test";
import assert from "node:assert/strict";
import { setupMockFetch, jsonResponse } from "./helpers/mock-fetch.js";
import { scrollChroma } from "../electron/lib/chroma/scroll.js";

test("scrollChroma: одна полная страница + следующая пустая → 1 yield", async () => {
  let callIdx = 0;
  const mock = setupMockFetch(() => {
    callIdx++;
    if (callIdx === 1) {
      return jsonResponse({
        ids: ["a", "b", "c"],
        metadatas: [{ x: 1 }, { x: 2 }, { x: 3 }],
      });
    }
    return jsonResponse({ ids: [], metadatas: [] });
  });
  try {
    const pages: unknown[] = [];
    for await (const p of scrollChroma({ collectionId: "uuid-c", pageSize: 3 })) {
      pages.push(p);
    }
    /* Первая страница ровно pageSize=3 → пробуем следующую → пустая → выход. */
    assert.equal(pages.length, 1);
    assert.equal(mock.calls.length, 2);
  } finally {
    mock.restore();
  }
});

test("scrollChroma: неполная страница = последняя", async () => {
  const mock = setupMockFetch(() =>
    jsonResponse({ ids: ["a", "b"], metadatas: [{}, {}] }),
  );
  try {
    const pages: unknown[] = [];
    for await (const p of scrollChroma({ collectionId: "c", pageSize: 5 })) pages.push(p);
    /* count=2 < pageSize=5 → нет следующего HTTP-запроса. */
    assert.equal(pages.length, 1);
    assert.equal(mock.calls.length, 1);
  } finally {
    mock.restore();
  }
});

test("scrollChroma: maxItems hard cap", async () => {
  let callIdx = 0;
  const mock = setupMockFetch(() => {
    callIdx++;
    return jsonResponse({
      ids: Array.from({ length: 10 }, (_, i) => `c${callIdx}-${i}`),
      metadatas: Array.from({ length: 10 }, () => ({})),
    });
  });
  try {
    let yielded = 0;
    for await (const p of scrollChroma({ collectionId: "c", pageSize: 10, maxItems: 25 })) {
      yielded += p.ids.length;
    }
    /* Должно остановиться <= 25; offset shifts в каждой итерации. */
    assert.ok(yielded <= 25);
    assert.ok(yielded >= 10);
  } finally {
    mock.restore();
  }
});

test("scrollChroma: include передаётся в body", async () => {
  const mock = setupMockFetch(() => jsonResponse({ ids: [], metadatas: [] }));
  try {
    const iter = scrollChroma({ collectionId: "c", include: ["metadatas", "documents"] });
    await iter.next();
    const body = mock.calls[0].body as { include: string[] };
    assert.deepEqual(body.include, ["metadatas", "documents"]);
  } finally {
    mock.restore();
  }
});

test("scrollChroma: пустой where не добавляется в body", async () => {
  const mock = setupMockFetch(() => jsonResponse({ ids: [], metadatas: [] }));
  try {
    const iter = scrollChroma({ collectionId: "c" });
    await iter.next();
    const body = mock.calls[0].body as { where?: unknown };
    assert.equal(body.where, undefined);
  } finally {
    mock.restore();
  }
});

test("scrollChroma: aborted signal → throws", async () => {
  const ctrl = new AbortController();
  ctrl.abort();
  const mock = setupMockFetch(() => jsonResponse({ ids: [], metadatas: [] }));
  try {
    const iter = scrollChroma({ collectionId: "c", signal: ctrl.signal });
    await assert.rejects(iter.next());
  } finally {
    mock.restore();
  }
});
