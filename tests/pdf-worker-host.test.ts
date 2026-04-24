/* PDF worker host: feature flag, graceful fallback when worker entry missing. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isWorkerPdfEnabled,
  parsePdfInWorker,
} from "../electron/lib/scanner/parsers/pdf-worker-host.ts";

test("isWorkerPdfEnabled: false by default (no env)", (t) => {
  const prev = process.env.BIBLIARY_PARSE_WORKERS;
  delete process.env.BIBLIARY_PARSE_WORKERS;
  t.after(() => {
    if (prev !== undefined) process.env.BIBLIARY_PARSE_WORKERS = prev;
  });
  assert.equal(isWorkerPdfEnabled(), false);
});

test("isWorkerPdfEnabled: true when env=1", (t) => {
  const prev = process.env.BIBLIARY_PARSE_WORKERS;
  process.env.BIBLIARY_PARSE_WORKERS = "1";
  t.after(() => {
    if (prev === undefined) delete process.env.BIBLIARY_PARSE_WORKERS;
    else process.env.BIBLIARY_PARSE_WORKERS = prev;
  });
  assert.equal(isWorkerPdfEnabled(), true);
});

test("isWorkerPdfEnabled: false for any other value (strict opt-in)", (t) => {
  const prev = process.env.BIBLIARY_PARSE_WORKERS;
  for (const val of ["0", "true", "yes", "on", " 1 ", ""]) {
    process.env.BIBLIARY_PARSE_WORKERS = val;
    assert.equal(isWorkerPdfEnabled(), false, `value="${val}" must not enable worker`);
  }
  if (prev === undefined) delete process.env.BIBLIARY_PARSE_WORKERS;
  else process.env.BIBLIARY_PARSE_WORKERS = prev;
});

test("parsePdfInWorker: rejects with 'aborted' if signal pre-aborted (no worker spawn)", async () => {
  const ctl = new AbortController();
  ctl.abort();
  await assert.rejects(
    () => parsePdfInWorker("/anything.pdf", { signal: ctl.signal }),
    (err: Error) => err.message === "aborted",
  );
});

test("parsePdfInWorker: rejects cleanly when worker cannot parse missing file", async () => {
  /* In tsx mode the host may now reuse dist-electron/pdf-worker.js when it
     exists. Both acceptable failures are explicit: no worker entry, or worker
     starts and reports the missing PDF. */
  await assert.rejects(
    () => parsePdfInWorker("/anything.pdf", {}),
    (err: Error) => /worker not available|ENOENT/i.test(err.message),
  );
});
