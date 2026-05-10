/**
 * tests/ipc-lmstudio-handlers.test.ts
 *
 * Unit-тесты для payload validators в lmstudio.ipc.ts.
 *
 * Покрывает probe-url (вызывается onboarding wizard'ом с любым input'ом),
 * load model (UI «Load model» с opts), unload, get-actions-log maxLines.
 * Раньше эти validators жили inline без unit-тестов.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sanitizeProbeUrlArgs,
  validateLoadModelArgs,
  validateUnloadIdentifier,
  sanitizeMaxLines,
} from "../electron/ipc/handlers/lmstudio.handlers.ts";

/* ─── sanitizeProbeUrlArgs ────────────────────────────────────────── */

test("[ipc/lmstudio] sanitizeProbeUrlArgs: valid string + options", () => {
  const r = sanitizeProbeUrlArgs("http://localhost:1234", { timeoutMs: 3000, ipv4Fallback: true });
  assert.equal(r.url, "http://localhost:1234");
  assert.equal(r.timeoutMs, 3000);
  assert.equal(r.ipv4Fallback, true);
});

test("[ipc/lmstudio] sanitizeProbeUrlArgs: non-string url → empty string", () => {
  /* Не throw — onboarding должен быть устойчив к любому input. */
  for (const v of [null, undefined, 42, {}, []]) {
    const r = sanitizeProbeUrlArgs(v, {});
    assert.equal(r.url, "");
  }
});

test("[ipc/lmstudio] sanitizeProbeUrlArgs: invalid timeoutMs ignored", () => {
  /* Negative, NaN, fractional, string → undefined. */
  for (const v of [-1, 0, NaN, Infinity, 1.5, "3000", null]) {
    const r = sanitizeProbeUrlArgs("http://x", { timeoutMs: v });
    assert.equal(r.timeoutMs, undefined, `${v} should be ignored`);
  }
});

test("[ipc/lmstudio] sanitizeProbeUrlArgs: non-boolean ipv4Fallback ignored", () => {
  for (const v of ["true", 1, null, {}]) {
    const r = sanitizeProbeUrlArgs("http://x", { ipv4Fallback: v });
    assert.equal(r.ipv4Fallback, undefined, `${JSON.stringify(v)} should be ignored`);
  }
});

test("[ipc/lmstudio] sanitizeProbeUrlArgs: missing opts → no opts in result", () => {
  const r = sanitizeProbeUrlArgs("http://x", undefined);
  assert.equal(r.url, "http://x");
  assert.equal(r.timeoutMs, undefined);
  assert.equal(r.ipv4Fallback, undefined);
});

/* ─── validateLoadModelArgs ───────────────────────────────────────── */

test("[ipc/lmstudio] validateLoadModelArgs: valid modelKey + opts", () => {
  const r = validateLoadModelArgs("qwen3-4b", { contextLength: 8192, ttlSec: 600, gpuOffload: "max" });
  assert.equal(r.ok, true);
  assert.equal(r.data?.modelKey, "qwen3-4b");
  assert.equal(r.data?.contextLength, 8192);
  assert.equal(r.data?.ttlSec, 600);
  assert.equal(r.data?.gpuOffload, "max");
});

test("[ipc/lmstudio] validateLoadModelArgs: gpuOffload accepts integer layers", () => {
  const r = validateLoadModelArgs("m", { gpuOffload: 32 });
  assert.equal(r.data?.gpuOffload, 32);
});

test("[ipc/lmstudio] validateLoadModelArgs: gpuOffload=0 accepted (CPU-only)", () => {
  const r = validateLoadModelArgs("m", { gpuOffload: 0 });
  assert.equal(r.data?.gpuOffload, 0);
});

test("[ipc/lmstudio] validateLoadModelArgs: gpuOffload invalid → dropped", () => {
  /* "auto", -1, 1.5, "max-1" — отбрасываются. */
  for (const v of ["auto", -1, 1.5, "max-1", null]) {
    const r = validateLoadModelArgs("m", { gpuOffload: v });
    assert.equal(r.data?.gpuOffload, undefined, `${JSON.stringify(v)} should be dropped`);
  }
});

test("[ipc/lmstudio] validateLoadModelArgs: missing modelKey → reason", () => {
  for (const v of [null, undefined, 42, "", {}]) {
    const r = validateLoadModelArgs(v, {});
    assert.equal(r.ok, false, `${JSON.stringify(v)} should be rejected`);
    assert.equal(r.reason, "modelKey required");
  }
});

test("[ipc/lmstudio] validateLoadModelArgs: invalid contextLength / ttlSec dropped", () => {
  const r = validateLoadModelArgs("m", { contextLength: -100, ttlSec: 0 });
  assert.equal(r.ok, true);
  assert.equal(r.data?.contextLength, undefined);
  assert.equal(r.data?.ttlSec, undefined);

  const r2 = validateLoadModelArgs("m", { contextLength: 1.5, ttlSec: "60" });
  assert.equal(r2.data?.contextLength, undefined);
  assert.equal(r2.data?.ttlSec, undefined);
});

test("[ipc/lmstudio] validateLoadModelArgs: no opts → minimal valid data", () => {
  const r = validateLoadModelArgs("m", undefined);
  assert.equal(r.ok, true);
  assert.equal(r.data?.modelKey, "m");
  assert.equal(r.data?.contextLength, undefined);
});

/* ─── validateUnloadIdentifier ────────────────────────────────────── */

test("[ipc/lmstudio] validateUnloadIdentifier: valid string returned", () => {
  assert.equal(validateUnloadIdentifier("model-id-1"), "model-id-1");
});

test("[ipc/lmstudio] validateUnloadIdentifier: empty / non-string → null", () => {
  for (const v of ["", null, undefined, 42, {}]) {
    assert.equal(validateUnloadIdentifier(v), null);
  }
});

/* ─── sanitizeMaxLines ────────────────────────────────────────────── */

test("[ipc/lmstudio] sanitizeMaxLines: valid integer ≥1", () => {
  assert.equal(sanitizeMaxLines(100, 500), 100);
  assert.equal(sanitizeMaxLines(1, 500), 1);
});

test("[ipc/lmstudio] sanitizeMaxLines: invalid → default", () => {
  for (const v of [-1, 0, 1.5, NaN, "100", null, undefined, {}]) {
    assert.equal(sanitizeMaxLines(v, 500), 500, `${JSON.stringify(v)} → default`);
  }
});
