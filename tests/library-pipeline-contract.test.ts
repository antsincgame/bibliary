/* Integration-test the shared storage/gate contract across library cache and batch paths. */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { closeCacheDb, getBookById, upsertBook } from "../electron/lib/library/cache-db.ts";
import { _resetLibraryRootCache } from "../electron/lib/library/paths.ts";
import {
  gateCatalogBookForCrystallize,
  gateE2EBookForCrystallize,
  resolveCatalogBookSourcePath,
  resolveStoredBookPaths,
} from "../electron/lib/library/storage-contract.ts";
import type { BookCatalogMeta } from "../electron/lib/library/types.ts";

test("shared storage contract keeps FS path, cache row, and batch source-path aligned", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "bibliary-contract-test-"));
  const dataDir = path.join(tempRoot, "data");
  const libraryRoot = path.join(dataDir, "library");
  const prevDataDir = process.env.BIBLIARY_DATA_DIR;
  const prevLibraryDb = process.env.BIBLIARY_LIBRARY_DB;
  const prevLibraryRoot = process.env.BIBLIARY_LIBRARY_ROOT;

  process.env.BIBLIARY_DATA_DIR = dataDir;
  process.env.BIBLIARY_LIBRARY_DB = path.join(dataDir, "bibliary-cache.db");
  process.env.BIBLIARY_LIBRARY_ROOT = libraryRoot;
  closeCacheDb();
  _resetLibraryRootCache();

  t.after(async () => {
    closeCacheDb();
    _resetLibraryRootCache();
    if (prevDataDir === undefined) delete process.env.BIBLIARY_DATA_DIR;
    else process.env.BIBLIARY_DATA_DIR = prevDataDir;
    if (prevLibraryDb === undefined) delete process.env.BIBLIARY_LIBRARY_DB;
    else process.env.BIBLIARY_LIBRARY_DB = prevLibraryDb;
    if (prevLibraryRoot === undefined) delete process.env.BIBLIARY_LIBRARY_ROOT;
    else process.env.BIBLIARY_LIBRARY_ROOT = prevLibraryRoot;
    await rm(tempRoot, { recursive: true, force: true });
  });

  const meta: BookCatalogMeta = {
    id: "feedfacecafebeef",
    sha256: "b".repeat(64),
    originalFile: "downloaded-book-name.pdf",
    originalFormat: "pdf",
    title: "Integration Contract Book",
    wordCount: 2048,
    chapterCount: 24,
    qualityScore: 88,
    isFictionOrWater: false,
    status: "evaluated",
  };

  const stored = resolveStoredBookPaths(libraryRoot, meta.id, meta.originalFormat);
  assert.equal(stored.bookDir, path.join(libraryRoot, meta.id));
  assert.equal(stored.originalFile, "original.pdf");
  assert.equal(stored.originalPath, path.join(libraryRoot, meta.id, "original.pdf"));
  assert.equal(stored.mdPath, path.join(libraryRoot, meta.id, "book.md"));

  upsertBook({ ...meta, originalFile: stored.originalFile }, stored.mdPath);

  const cached = getBookById(meta.id);
  assert.ok(cached, "cached row should exist");
  assert.equal(cached.originalFile, "original.pdf");
  assert.equal(resolveCatalogBookSourcePath(cached), stored.originalPath);

  assert.deepEqual(
    gateCatalogBookForCrystallize(cached, { minQuality: 70, skipFictionOrWater: true }),
    { canCrystallize: true, reason: null },
  );
  assert.deepEqual(
    gateCatalogBookForCrystallize({ ...cached, qualityScore: 55 }, { minQuality: 70, skipFictionOrWater: true }),
    { canCrystallize: false, reason: "qualityScore=55 < 70" },
  );
  assert.deepEqual(
    gateE2EBookForCrystallize({
      parseVerdict: "PASS",
      skipEvaluate: false,
      skipCrystallize: false,
      minQuality: 70,
      evaluation: { quality_score: 88, is_fiction_or_water: false },
    }),
    { canCrystallize: true, reason: null },
  );
  assert.deepEqual(
    gateE2EBookForCrystallize({
      parseVerdict: "PASS",
      skipEvaluate: true,
      skipCrystallize: false,
      minQuality: 70,
      evaluation: { quality_score: 88, is_fiction_or_water: false },
    }),
    { canCrystallize: false, reason: "evaluate-disabled" },
  );
});
