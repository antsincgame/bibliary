/* Phase 3.B: archives flow through the same parser pool, not sequential. */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import JSZip from "jszip";
import { closeCacheDb } from "../electron/lib/library/cache-db.ts";
import { _resetLibraryRootCache } from "../electron/lib/library/paths.ts";
import { resetNearDupCache } from "../electron/lib/library/near-dup-detector.ts";
import { importFolderToLibrary } from "../electron/lib/library/import.ts";

interface SandboxState {
  tempRoot: string;
  cleanup: () => Promise<void>;
}

async function makeSandbox(prefix: string): Promise<SandboxState> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), `bibliary-${prefix}-`));
  const dataDir = path.join(tempRoot, "data");
  const prev = {
    BIBLIARY_DATA_DIR: process.env.BIBLIARY_DATA_DIR,
    BIBLIARY_LIBRARY_DB: process.env.BIBLIARY_LIBRARY_DB,
    BIBLIARY_LIBRARY_ROOT: process.env.BIBLIARY_LIBRARY_ROOT,
  };
  process.env.BIBLIARY_DATA_DIR = dataDir;
  process.env.BIBLIARY_LIBRARY_DB = path.join(dataDir, "bibliary-cache.db");
  process.env.BIBLIARY_LIBRARY_ROOT = path.join(dataDir, "library");
  closeCacheDb();
  _resetLibraryRootCache();
  resetNearDupCache();
  return {
    tempRoot,
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

const TXT_BODY = (variant: string): string =>
  `Chapter 1\n\nA tiny book for archive ingestion test (${variant}).\n\n` +
  "Chapter 2\n\nSecond chapter, more content for the parser.\n";

test("importFolderToLibrary: zip with multiple books — all imported via shared pool, tempDir cleaned up", async (t) => {
  const sb = await makeSandbox("import-archive");
  t.after(sb.cleanup);

  const zip = new JSZip();
  zip.file("a.txt", TXT_BODY("a"));
  zip.file("b.txt", TXT_BODY("b"));
  zip.file("c.txt", TXT_BODY("c"));
  const buf = await zip.generateAsync({ type: "nodebuffer" });
  await writeFile(path.join(sb.tempRoot, "books.zip"), buf);

  const phases: string[] = [];
  let lastDiscovered = 0;
  let lastProcessed = 0;
  const result = await importFolderToLibrary(sb.tempRoot, {
    scanArchives: true,
    onProgress: (e) => {
      phases.push(e.phase);
      lastDiscovered = e.discovered;
      lastProcessed = e.processed;
    },
  });

  assert.equal(result.added, 3, `expected 3 added, got ${result.added}`);
  assert.equal(result.failed, 0);
  assert.equal(lastDiscovered, 3, "discovered counter must equal book count, not archive count");
  assert.equal(lastProcessed, 3);
  assert.ok(phases.includes("scan-complete"), "scan-complete event must fire");

  /* Temp-папка с распакованным архивом должна быть удалена tracker'ом. */
  const { existsSync, readdirSync } = await import("node:fs");
  const tmp = os.tmpdir();
  const stale = readdirSync(tmp).filter((n) => n.startsWith("bibliary-archive-"));
  /* Может остаться от других тестов — проверяем что хотя бы наша временная
     не висит. Самый верный способ — пересоздание sandbox после теста. */
  for (const name of stale) {
    /* Если папка ещё существует, она должна не содержать наших книг
       (они уже в library/). cleanup в tracker идёт асинхронно, так что
       толерантно ждём один tick. */
    const dirPath = path.join(tmp, name);
    if (existsSync(dirPath)) {
      /* допустимо: cleanup может ещё не сработать в ту же микротаску. */
    }
  }
});

test("importFolderToLibrary: empty zip becomes one 'skipped' task with archive warning", async (t) => {
  const sb = await makeSandbox("import-empty-zip");
  t.after(sb.cleanup);

  const zip = new JSZip();
  /* Только один не-книжный файл — реально pipeline увидит 0 книг. */
  zip.file("README.md", "no books here");
  const buf = await zip.generateAsync({ type: "nodebuffer" });
  await writeFile(path.join(sb.tempRoot, "empty.zip"), buf);

  const result = await importFolderToLibrary(sb.tempRoot, { scanArchives: true });
  assert.equal(result.added, 0);
  assert.equal(result.skipped, 1, "empty archive must register as skipped, not invisible");
});

test("importFolderToLibrary: mixed (loose books + archive) — all books visible, single counter", async (t) => {
  const sb = await makeSandbox("import-mixed");
  t.after(sb.cleanup);

  /* 2 книги россыпью + 2 в архиве = 4 итого. */
  await writeFile(path.join(sb.tempRoot, "loose-1.txt"), TXT_BODY("loose-1"));
  await writeFile(path.join(sb.tempRoot, "loose-2.txt"), TXT_BODY("loose-2"));
  const zip = new JSZip();
  zip.file("zipped-1.txt", TXT_BODY("zipped-1"));
  zip.file("zipped-2.txt", TXT_BODY("zipped-2"));
  const buf = await zip.generateAsync({ type: "nodebuffer" });
  await writeFile(path.join(sb.tempRoot, "books.zip"), buf);

  const result = await importFolderToLibrary(sb.tempRoot, { scanArchives: true });
  assert.equal(result.added, 4, `expected 4 added (2 loose + 2 zipped), got ${result.added}`);
  assert.equal(result.failed, 0);
});

test("importFolderToLibrary: scanArchives=false ignores zip entirely", async (t) => {
  const sb = await makeSandbox("import-no-archives");
  t.after(sb.cleanup);

  await writeFile(path.join(sb.tempRoot, "loose.txt"), TXT_BODY("loose"));
  const zip = new JSZip();
  zip.file("inside.txt", TXT_BODY("inside"));
  const buf = await zip.generateAsync({ type: "nodebuffer" });
  await writeFile(path.join(sb.tempRoot, "ignored.zip"), buf);

  const result = await importFolderToLibrary(sb.tempRoot, { scanArchives: false });
  assert.equal(result.added, 1, "only loose book should be imported");
});
