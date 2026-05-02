import { test } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { closeCacheDb } from "../electron/lib/library/cache-db.ts";
import { _resetLibraryRootCache } from "../electron/lib/library/paths.ts";
import { resetNearDupCache } from "../electron/lib/library/near-dup-detector.ts";
import {
  buildWorkKey,
  computeRevisionScore,
  resetRevisionDedupCache,
} from "../electron/lib/library/revision-dedup.ts";
import { importBookFromFile } from "../electron/lib/library/import.ts";

interface SandboxState {
  tempRoot: string;
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
  resetRevisionDedupCache();
  return {
    tempRoot,
    cleanup: async () => {
      closeCacheDb();
      _resetLibraryRootCache();
      resetNearDupCache();
      resetRevisionDedupCache();
      for (const k of Object.keys(prev) as (keyof typeof prev)[]) {
        if (prev[k] === undefined) delete process.env[k];
        else process.env[k] = prev[k];
      }
      await rm(tempRoot, { recursive: true, force: true }).catch((err) => console.error("[library-revision-dedup/cleanup] rm Error:", err));
    },
  };
}

const BODY = "Simple paragraph with enough text for txt parser.\n\nSecond block.\n";

test("revision-dedup: workKey ignores edition markers", () => {
  const a = buildWorkKey({ title: "Neural Systems 2nd Edition 2024", author: "John Doe" });
  const b = buildWorkKey({ title: "Neural Systems", author: "John Doe" });
  assert.equal(a, b);
});

test("revision-dedup: score prefers newer semantic revision markers", () => {
  const older = computeRevisionScore({ title: "Neural Systems", sourceArchive: "old.zip" });
  const newer = computeRevisionScore({ title: "Neural Systems 2nd Edition 2024" });
  assert.ok(newer > older, `expected newer(${newer}) > older(${older})`);
});

test("import: older revision is skipped when newer already exists", async (t) => {
  const sb = await makeSandbox("rev-skip");
  t.after(sb.cleanup);

  const newerPath = path.join(sb.tempRoot, "Neural_Systems_2nd_Edition_2024.txt");
  const olderPath = path.join(sb.tempRoot, "Neural_Systems.txt");
  await writeFile(newerPath, `${BODY}\nnewer unique line\n`, "utf8");
  await writeFile(olderPath, `${BODY}\nolder unique line\n`, "utf8");

  const first = await importBookFromFile(newerPath);
  assert.equal(first.outcome, "added");

  const second = await importBookFromFile(olderPath);
  assert.equal(second.outcome, "duplicate");
  assert.equal(second.duplicateReason, "duplicate_older_revision");
  assert.equal(second.existingBookId, first.bookId);
  assert.ok(second.existingBookTitle);
});

test("import: newer revision is kept when older already exists", async (t) => {
  const sb = await makeSandbox("rev-keep");
  t.after(sb.cleanup);

  const olderPath = path.join(sb.tempRoot, "Neural_Systems.txt");
  const newerPath = path.join(sb.tempRoot, "Neural_Systems_2nd_Edition_2024.txt");
  await writeFile(olderPath, `${BODY}\nolder first\n`, "utf8");
  await writeFile(newerPath, `${BODY}\nnewer second\n`, "utf8");

  const first = await importBookFromFile(olderPath);
  assert.equal(first.outcome, "added");

  const second = await importBookFromFile(newerPath);
  assert.equal(second.outcome, "added");
  assert.notEqual(second.bookId, first.bookId);
});

test("Iter 12 P1.2: HARD+REPLACE — newer revision evicts older after success", async (t) => {
  const sb = await makeSandbox("rev-replace");
  t.after(sb.cleanup);
  const { getBookById } = await import("../electron/lib/library/cache-db.ts");

  const olderPath = path.join(sb.tempRoot, "Neural_Systems.txt");
  const newerPath = path.join(sb.tempRoot, "Neural_Systems_2nd_Edition_2024.txt");
  await writeFile(olderPath, `${BODY}\nolder first\n`, "utf8");
  await writeFile(newerPath, `${BODY}\nnewer second\n`, "utf8");

  const first = await importBookFromFile(olderPath);
  assert.equal(first.outcome, "added");
  const oldBookId = first.bookId!;
  assert.ok(getBookById(oldBookId), "old book must be in DB before replace");

  const second = await importBookFromFile(newerPath);
  assert.equal(second.outcome, "added");
  assert.notEqual(second.bookId, oldBookId);

  /* Phalanx P1.2: старая ревизия удалена из DB ПОСЛЕ успеха новой. */
  assert.equal(getBookById(oldBookId), null, "old book must be removed from DB after replace");
  /* Новая ревизия осталась. */
  assert.ok(getBookById(second.bookId!), "new book must remain");
});
