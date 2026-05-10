/**
 * tests/ipc-library-import-handlers.test.ts
 *
 * Unit-тесты для validators в library-import-ipc.ts.
 *
 * Покрывает payload-validation для основного flow «импортировать книги
 * в коллекцию» — самые критичные IPC из renderer'а. Раньше эти проверки
 * жили inline без unit-тестов: регрессия типа «приняли отрицательный
 * maxDepth, walker зашёл в бесконечный цикл» проходила бы тихо.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateImportFolderArgs,
  validateImportFilesArgs,
  validateScanFolderArgs,
  validateCancelId,
} from "../electron/ipc/handlers/library-import.handlers.ts";

/* ─── validateImportFolderArgs ────────────────────────────────────── */

test("[ipc/import] validateImportFolderArgs: minimal valid (folder only)", () => {
  const r = validateImportFolderArgs({ folder: "/home/user/books" });
  assert.equal(r.ok, true);
  assert.equal(r.data?.folder, "/home/user/books");
  assert.equal(r.data?.scanArchives, undefined);
  assert.equal(r.data?.ocrEnabled, undefined);
  assert.equal(r.data?.maxDepth, undefined);
});

test("[ipc/import] validateImportFolderArgs: full valid payload", () => {
  const r = validateImportFolderArgs({
    folder: "/path",
    scanArchives: true,
    ocrEnabled: false,
    maxDepth: 5,
  });
  assert.equal(r.ok, true);
  assert.equal(r.data?.scanArchives, true);
  assert.equal(r.data?.ocrEnabled, false);
  assert.equal(r.data?.maxDepth, 5);
});

test("[ipc/import] validateImportFolderArgs: missing/non-string folder rejected", () => {
  for (const v of [{}, { folder: "" }, { folder: 42 }, { folder: null }]) {
    const r = validateImportFolderArgs(v);
    assert.equal(r.ok, false, `${JSON.stringify(v)} should be rejected`);
    assert.equal(r.reason, "folder required");
  }
});

test("[ipc/import] validateImportFolderArgs: non-object input rejected", () => {
  for (const v of [null, undefined, "string", 42, []]) {
    const r = validateImportFolderArgs(v);
    /* `null`, primitives → "args required". Empty array `[]` typeof === "object",
       но без folder property → "folder required". */
    assert.equal(r.ok, false, `${JSON.stringify(v)} should be rejected`);
  }
});

test("[ipc/import] validateImportFolderArgs: invalid maxDepth ignored (not failed)", () => {
  /* maxDepth опционален — мы силенс'но дропаем плохие значения, не fail'им. */
  const r = validateImportFolderArgs({ folder: "/p", maxDepth: -1 });
  assert.equal(r.ok, true);
  assert.equal(r.data?.maxDepth, undefined, "negative dropped");

  const r2 = validateImportFolderArgs({ folder: "/p", maxDepth: 1.5 });
  assert.equal(r2.data?.maxDepth, undefined, "non-integer dropped");

  const r3 = validateImportFolderArgs({ folder: "/p", maxDepth: "5" });
  assert.equal(r3.data?.maxDepth, undefined, "string dropped");
});

test("[ipc/import] validateImportFolderArgs: maxDepth=0 accepted (no descent)", () => {
  const r = validateImportFolderArgs({ folder: "/p", maxDepth: 0 });
  assert.equal(r.ok, true);
  assert.equal(r.data?.maxDepth, 0);
});

test("[ipc/import] validateImportFolderArgs: non-boolean flags ignored", () => {
  const r = validateImportFolderArgs({
    folder: "/p",
    scanArchives: "yes",
    ocrEnabled: 1,
  });
  assert.equal(r.ok, true);
  assert.equal(r.data?.scanArchives, undefined);
  assert.equal(r.data?.ocrEnabled, undefined);
});

/* ─── validateImportFilesArgs ─────────────────────────────────────── */

test("[ipc/import] validateImportFilesArgs: valid array", () => {
  const r = validateImportFilesArgs({ paths: ["/a.pdf", "/b.epub"] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.data?.paths, ["/a.pdf", "/b.epub"]);
});

test("[ipc/import] validateImportFilesArgs: empty array rejected", () => {
  const r = validateImportFilesArgs({ paths: [] });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "paths required");
});

test("[ipc/import] validateImportFilesArgs: array with non-string element rejected", () => {
  /* Не silently filter — пользователь должен знать почему файлы пропали. */
  const r = validateImportFilesArgs({ paths: ["/a.pdf", 42, "/b.epub"] });
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /non-empty strings/);
});

test("[ipc/import] validateImportFilesArgs: array with empty string rejected", () => {
  const r = validateImportFilesArgs({ paths: ["/a.pdf", ""] });
  assert.equal(r.ok, false);
});

test("[ipc/import] validateImportFilesArgs: not-array paths rejected", () => {
  for (const v of [{ paths: "not-array" }, { paths: 42 }, { paths: null }, { paths: { a: 1 } }, {}]) {
    const r = validateImportFilesArgs(v);
    assert.equal(r.ok, false, `${JSON.stringify(v)} should be rejected`);
  }
});

test("[ipc/import] validateImportFilesArgs: optional flags preserved", () => {
  const r = validateImportFilesArgs({
    paths: ["/a.pdf"],
    scanArchives: true,
    ocrEnabled: true,
  });
  assert.equal(r.ok, true);
  assert.equal(r.data?.scanArchives, true);
  assert.equal(r.data?.ocrEnabled, true);
});

/* ─── validateScanFolderArgs ──────────────────────────────────────── */

test("[ipc/import] validateScanFolderArgs: valid folder", () => {
  const r = validateScanFolderArgs({ folder: "/path" });
  assert.equal(r.ok, true);
  assert.equal(r.data?.folder, "/path");
});

test("[ipc/import] validateScanFolderArgs: missing folder rejected", () => {
  for (const v of [{}, { folder: "" }, null, undefined, { folder: 42 }]) {
    const r = validateScanFolderArgs(v);
    assert.equal(r.ok, false);
  }
});

/* ─── validateCancelId ────────────────────────────────────────────── */

test("[ipc/import] validateCancelId: valid string", () => {
  assert.equal(validateCancelId("import-abc-123"), "import-abc-123");
});

test("[ipc/import] validateCancelId: empty/non-string → null", () => {
  /* Возвращает null, не throw — caller просто вернёт false. */
  for (const v of ["", null, undefined, 42, {}, []]) {
    assert.equal(validateCancelId(v), null, `${JSON.stringify(v)} → null`);
  }
});
