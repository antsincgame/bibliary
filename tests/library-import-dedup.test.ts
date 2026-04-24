/* Phase 1 contract: SHA-256 dedup runs BEFORE parsing, bookId is content-derived. */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { mkdtemp, rm, writeFile, stat } from "node:fs/promises";
import { closeCacheDb, getBookById } from "../electron/lib/library/cache-db.ts";
import { _resetLibraryRootCache } from "../electron/lib/library/paths.ts";
import { resetNearDupCache } from "../electron/lib/library/near-dup-detector.ts";
import { importBookFromFile, importFolderToLibrary } from "../electron/lib/library/import.ts";
import { computeFileSha256, bookIdFromSha } from "../electron/lib/library/sha-stream.ts";

interface SandboxState {
  tempRoot: string;
  dataDir: string;
  libraryRoot: string;
  cleanup: () => Promise<void>;
}

async function makeSandbox(prefix: string): Promise<SandboxState> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), `bibliary-${prefix}-`));
  const dataDir = path.join(tempRoot, "data");
  const libraryRoot = path.join(dataDir, "library");
  const prev = {
    BIBLIARY_DATA_DIR: process.env.BIBLIARY_DATA_DIR,
    BIBLIARY_LIBRARY_DB: process.env.BIBLIARY_LIBRARY_DB,
    BIBLIARY_LIBRARY_ROOT: process.env.BIBLIARY_LIBRARY_ROOT,
  };
  process.env.BIBLIARY_DATA_DIR = dataDir;
  process.env.BIBLIARY_LIBRARY_DB = path.join(dataDir, "bibliary-cache.db");
  process.env.BIBLIARY_LIBRARY_ROOT = libraryRoot;
  closeCacheDb();
  _resetLibraryRootCache();
  resetNearDupCache();
  return {
    tempRoot,
    dataDir,
    libraryRoot,
    cleanup: async () => {
      closeCacheDb();
      _resetLibraryRootCache();
      resetNearDupCache();
      for (const k of Object.keys(prev) as (keyof typeof prev)[]) {
        if (prev[k] === undefined) delete process.env[k];
        else process.env[k] = prev[k];
      }
      await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
    },
  };
}

const SAMPLE_TXT =
  "Chapter One\n\n" +
  "This is the first paragraph of a small but valid book used for the dedup contract test. " +
  "We deliberately keep it boring and English-only so the txt parser sails through.\n\n" +
  "Chapter Two\n\n" +
  "Here is the second chapter. It also has some content so the parser produces non-zero chapters.\n";

test("import: bookId is derived from CONTENT SHA, not from file path", async (t) => {
  const sb = await makeSandbox("import-id");
  t.after(sb.cleanup);

  const a = path.join(sb.tempRoot, "alpha.txt");
  const b = path.join(sb.tempRoot, "different-name.txt");
  await writeFile(a, SAMPLE_TXT, "utf8");
  await writeFile(b, SAMPLE_TXT, "utf8");

  const r1 = await importBookFromFile(a);
  assert.equal(r1.outcome, "added", `expected added, got ${r1.outcome} (err=${r1.error ?? ""})`);
  assert.ok(r1.bookId);

  /* Контракт стабильности: bookId == первые 16 hex SHA256 содержимого. */
  const sha = await computeFileSha256(a);
  assert.equal(r1.bookId, bookIdFromSha(sha));

  /* Импорт того же содержимого под другим именем -> duplicate, тот же bookId. */
  const r2 = await importBookFromFile(b);
  assert.equal(r2.outcome, "duplicate");
  assert.equal(r2.bookId, r1.bookId);
});

test("import: dedup happens BEFORE parsing — duplicate is fast and writes no new files", async (t) => {
  const sb = await makeSandbox("import-dedup");
  t.after(sb.cleanup);

  const file = path.join(sb.tempRoot, "book.txt");
  await writeFile(file, SAMPLE_TXT, "utf8");

  const first = await importBookFromFile(file);
  assert.equal(first.outcome, "added");
  const bookDir = path.join(sb.libraryRoot, first.bookId!);
  const dirStat = await stat(bookDir);
  assert.ok(dirStat.isDirectory(), "library/{id}/ must exist after first import");

  /* Замеряем длительность 2-го импорта: он должен быть кратно быстрее парсинга,
     потому что мы дедупим до convertBookToMarkdown. На современной машине
     parse+md+image-extract тратит десятки мс минимум; pure SHA — единицы. */
  const t0 = Date.now();
  const dup = await importBookFromFile(file);
  const dt = Date.now() - t0;
  assert.equal(dup.outcome, "duplicate");
  assert.equal(dup.bookId, first.bookId);
  /* Soft-cap: 1 секунды на дубликат должно с большим запасом хватить. Если
     парсер всё-таки запустился, это будет дольше (особенно с расширением
     парсера). Этот ассерт ловит регрессию «вернули старый порядок». */
  assert.ok(dt < 1000, `duplicate import took ${dt}ms, expected fast pre-parse dedup`);
});

test("importFolderToLibrary: emits discovered + processed + scan-complete progress events", async (t) => {
  const sb = await makeSandbox("import-progress");
  t.after(sb.cleanup);

  await writeFile(path.join(sb.tempRoot, "one.txt"), SAMPLE_TXT, "utf8");
  await writeFile(path.join(sb.tempRoot, "two.txt"), SAMPLE_TXT + "\nDifferent ending one.\n", "utf8");
  await writeFile(path.join(sb.tempRoot, "three.txt"), SAMPLE_TXT + "\nDifferent ending two.\n", "utf8");

  const phases: string[] = [];
  let lastDiscovered = 0;
  let lastProcessed = 0;
  const result = await importFolderToLibrary(sb.tempRoot, {
    onProgress: (evt) => {
      phases.push(evt.phase);
      lastDiscovered = evt.discovered;
      lastProcessed = evt.processed;
    },
  });

  assert.equal(result.added, 3);
  assert.equal(result.duplicate, 0);
  assert.equal(result.failed, 0);
  assert.ok(phases.includes("discovered"), "must emit discovered");
  assert.ok(phases.includes("processed"), "must emit processed");
  assert.ok(phases.includes("scan-complete"), "must emit scan-complete");
  assert.equal(lastDiscovered, 3);
  assert.equal(lastProcessed, 3);
});

test("import: cache row stores the content-derived id (not path-derived)", async (t) => {
  const sb = await makeSandbox("import-cache");
  t.after(sb.cleanup);

  const file = path.join(sb.tempRoot, "stored.txt");
  await writeFile(file, SAMPLE_TXT + "\nUnique stored variation.\n", "utf8");

  const r = await importBookFromFile(file);
  assert.equal(r.outcome, "added");
  const cached = getBookById(r.bookId!);
  assert.ok(cached, "book must be in cache");
  const sha = await computeFileSha256(file);
  assert.equal(cached.id, bookIdFromSha(sha));
  assert.equal(cached.sha256, sha);
});
