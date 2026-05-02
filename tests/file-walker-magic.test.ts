/**
 * Walker × magic-guard integration: verifies that `verifyMagic: true`
 * silently rejects renamed binaries and reports through onMagicReject.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { walkSupportedFiles } from "../electron/lib/library/file-walker.ts";
import type { SupportedExt } from "../electron/lib/scanner/parsers/index.ts";

const SUPPORTED: ReadonlySet<SupportedExt> = new Set(["pdf", "epub", "txt"]);

test("walkSupportedFiles + verifyMagic: drops PE renamed as .pdf and reports reason", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bibliary-walker-magic-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  /* Real PDF (passes magic + structural %%EOF check) */
  const realPdf = Buffer.concat([
    Buffer.from("%PDF-1.7\n", "binary"),
    Buffer.alloc(20_000 - "%PDF-1.7\n".length - "%%EOF\n".length, 0x20),
    Buffer.from("%%EOF\n", "binary"),
  ]);
  await writeFile(path.join(root, "real.pdf"), realPdf);

  /* PE/MZ renamed to .pdf */
  const peGarbage = Buffer.alloc(20_000);
  peGarbage[0] = 0x4d;
  peGarbage[1] = 0x5a;
  await writeFile(path.join(root, "fake.pdf"), peGarbage);

  /* Plain text accepted as .txt */
  await writeFile(path.join(root, "ok.txt"), "plain ascii text ".repeat(2000));

  const rejected: Array<{ file: string; reason: string }> = [];
  const found: string[] = [];
  for await (const f of walkSupportedFiles(root, SUPPORTED, {
    minFileBytes: 0,
    verifyMagic: true,
    onMagicReject: (file, reason) => rejected.push({ file: path.basename(file), reason }),
  })) {
    found.push(path.basename(f));
  }
  found.sort();

  assert.deepEqual(found, ["ok.txt", "real.pdf"]);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0]!.file, "fake.pdf");
  assert.match(rejected[0]!.reason, /windows-executable/);
});

test("walkSupportedFiles: verifyMagic disabled keeps backward-compatible behaviour", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bibliary-walker-magic-off-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  /* fake content but legitimate filename — older callers/tests rely on this */
  await writeFile(path.join(root, "any.pdf"), "fake pdf content");

  const found: string[] = [];
  for await (const f of walkSupportedFiles(root, SUPPORTED, { minFileBytes: 0 })) {
    found.push(path.basename(f));
  }
  assert.deepEqual(found, ["any.pdf"]);
});

test("walkSupportedFiles + verifyMagic: tolerates onMagicReject throwing", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bibliary-walker-magic-throw-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const peGarbage = Buffer.alloc(20_000);
  peGarbage[0] = 0x4d;
  peGarbage[1] = 0x5a;
  await writeFile(path.join(root, "junk.pdf"), peGarbage);

  const found: string[] = [];
  /* even if onMagicReject crashes, walker must still skip the file silently */
  for await (const f of walkSupportedFiles(root, SUPPORTED, {
    minFileBytes: 0,
    verifyMagic: true,
    onMagicReject: () => { throw new Error("logger unavailable"); },
  })) {
    found.push(path.basename(f));
  }
  assert.deepEqual(found, []);
});
