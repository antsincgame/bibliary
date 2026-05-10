/**
 * tests/ipc-vectordb-handlers.test.ts
 *
 * Unit-тесты для pure validators/mappers vectordb.ipc.ts.
 *
 * Покрывает:
 *   - sanitizeDistance (включая legacy "ip" → "dot" маппинг)
 *   - preValidateCollectionName (pre-zod null guard)
 *   - buildCollectionInfoUI (LanceDB → UI payload shape)
 *   - validateCreateCollectionShape (full payload validation)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sanitizeDistance,
  preValidateCollectionName,
  buildCollectionInfoUI,
  validateCreateCollectionShape,
} from "../electron/ipc/handlers/vectordb.handlers.ts";

/* ─── sanitizeDistance ────────────────────────────────────────────── */

test("[ipc/vectordb] sanitizeDistance: passthrough valid values", () => {
  assert.equal(sanitizeDistance("cosine"), "cosine");
  assert.equal(sanitizeDistance("l2"), "l2");
  assert.equal(sanitizeDistance("dot"), "dot");
});

test("[ipc/vectordb] sanitizeDistance: legacy 'ip' → 'dot' (critical mapping)", () => {
  /* Регрессия-страж: старый UI dropdown посылал "ip", LanceDB ожидает "dot".
     Если кто-то удалит этот маппинг — старые UI ломанутся. */
  assert.equal(sanitizeDistance("ip"), "dot");
});

test("[ipc/vectordb] sanitizeDistance: undefined → cosine (default)", () => {
  assert.equal(sanitizeDistance(undefined), "cosine");
});

test("[ipc/vectordb] sanitizeDistance: unknown values → cosine fallback", () => {
  for (const v of [null, "", "manhattan", "euclidean", 42, {}, []]) {
    assert.equal(sanitizeDistance(v), "cosine", `${JSON.stringify(v)} → cosine fallback`);
  }
});

/* ─── preValidateCollectionName ───────────────────────────────────── */

test("[ipc/vectordb] preValidateCollectionName: valid string", () => {
  assert.equal(preValidateCollectionName("my-collection"), "my-collection");
});

test("[ipc/vectordb] preValidateCollectionName: empty/non-string → null", () => {
  for (const v of ["", null, undefined, 42, {}]) {
    assert.equal(preValidateCollectionName(v), null, `${JSON.stringify(v)} → null`);
  }
});

/* ─── buildCollectionInfoUI ───────────────────────────────────────── */

test("[ipc/vectordb] buildCollectionInfoUI: collection с vector index → metadata flag", () => {
  const ui = buildCollectionInfoUI({ name: "books", rowCount: 1500, hasVectorIndex: true });
  assert.equal(ui.name, "books");
  assert.equal(ui.pointsCount, 1500, "rowCount → pointsCount rename");
  assert.equal(ui.status, "ok");
  assert.deepEqual(ui.metadata, { hasVectorIndex: true });
});

test("[ipc/vectordb] buildCollectionInfoUI: collection без vector index → metadata=null", () => {
  const ui = buildCollectionInfoUI({ name: "empty", rowCount: 0, hasVectorIndex: false });
  assert.equal(ui.pointsCount, 0);
  assert.equal(ui.metadata, null, "no metadata when no vector index (UI uses null to hide indicator)");
});

test("[ipc/vectordb] buildCollectionInfoUI: large counts preserved (no precision loss)", () => {
  const ui = buildCollectionInfoUI({ name: "big", rowCount: 2_500_000, hasVectorIndex: true });
  assert.equal(ui.pointsCount, 2_500_000);
});

/* ─── validateCreateCollectionShape ───────────────────────────────── */

test("[ipc/vectordb] validateCreateCollectionShape: full valid args", () => {
  const r = validateCreateCollectionShape({ name: "my-coll", distance: "l2" });
  assert.equal(r.ok, true);
  assert.equal(r.data?.name, "my-coll");
  assert.equal(r.data?.distance, "l2");
});

test("[ipc/vectordb] validateCreateCollectionShape: missing distance → cosine default", () => {
  const r = validateCreateCollectionShape({ name: "x" });
  assert.equal(r.ok, true);
  assert.equal(r.data?.distance, "cosine");
});

test("[ipc/vectordb] validateCreateCollectionShape: legacy 'ip' distance normalized to 'dot'", () => {
  const r = validateCreateCollectionShape({ name: "x", distance: "ip" });
  assert.equal(r.ok, true);
  assert.equal(r.data?.distance, "dot");
});

test("[ipc/vectordb] validateCreateCollectionShape: missing name → error", () => {
  for (const v of [{}, { name: "" }, { name: 42 }, null, undefined]) {
    const r = validateCreateCollectionShape(v);
    assert.equal(r.ok, false, `${JSON.stringify(v)} should fail`);
    assert.match(r.error ?? "", /required/);
  }
});

test("[ipc/vectordb] validateCreateCollectionShape: unknown distance → cosine fallback (no error)", () => {
  /* Не fail'им — silent default = forgiving UX. */
  const r = validateCreateCollectionShape({ name: "x", distance: "manhattan" });
  assert.equal(r.ok, true);
  assert.equal(r.data?.distance, "cosine");
});
