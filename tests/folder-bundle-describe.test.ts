/* describeSidecars: проверка поведения с моками + fallback при отсутствии LLM. */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";

import { discoverBundle } from "../electron/lib/scanner/folder-bundle/classifier.ts";
import { describeSidecars } from "../electron/lib/scanner/folder-bundle/describe-sidecars.ts";

async function setupBundle(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "bibliary-describe-test-"));
  await writeFile(path.join(root, "Book.pdf"), Buffer.alloc(50_000, 1));
  await mkdir(path.join(root, "img"), { recursive: true });
  await writeFile(path.join(root, "img", "fig1.png"), Buffer.alloc(2048, 1));
  await mkdir(path.join(root, "code"), { recursive: true });
  await writeFile(path.join(root, "code", "main.py"), "def hello(): print('hi')\n");
  await mkdir(path.join(root, "site"), { recursive: true });
  await writeFile(path.join(root, "site", "index.html"), "<html><body><h1>Tutorial</h1></body></html>");
  return root;
}

test("describeSidecars: uses provided describeImage and describeText hooks", async (t) => {
  const root = await setupBundle();
  t.after(() => rm(root, { recursive: true, force: true }));

  const bundle = await discoverBundle(root);
  const calls: { kind: string; preview: string }[] = [];

  const { descriptions, warnings } = await describeSidecars(bundle, {
    describeImage: async (p) => {
      calls.push({ kind: "image", preview: path.basename(p) });
      return "Mocked image description";
    },
    describeText: async (text, kind) => {
      calls.push({ kind, preview: text.slice(0, 30) });
      return `Mocked ${kind} description`;
    },
    concurrency: 1,
  });

  assert.equal(warnings.length, 0);
  assert.ok(descriptions.size >= 3, `expected ≥3 descriptions, got ${descriptions.size}`);

  /* image */
  const img = bundle.sidecars.find((s) => s.kind === "image");
  assert.ok(img);
  assert.equal(descriptions.get(img!.absPath)?.description, "Mocked image description");

  /* code */
  const code = bundle.sidecars.find((s) => s.kind === "code");
  assert.ok(code);
  assert.equal(descriptions.get(code!.absPath)?.description, "Mocked code description");
  assert.match(descriptions.get(code!.absPath)?.fullText ?? "", /def hello/);

  /* html-site */
  const site = bundle.sidecars.find((s) => s.kind === "html-site");
  assert.ok(site);
  assert.equal(descriptions.get(site!.absPath)?.description, "Mocked html-site description");

  /* hooks were actually called */
  assert.ok(calls.some((c) => c.kind === "image"));
  assert.ok(calls.some((c) => c.kind === "code"));
  assert.ok(calls.some((c) => c.kind === "html-site"));
});

test("describeSidecars: progress events fire for each file + start/done", async (t) => {
  const root = await setupBundle();
  t.after(() => rm(root, { recursive: true, force: true }));

  const bundle = await discoverBundle(root);
  const events: { type: string; file?: string }[] = [];

  await describeSidecars(bundle, {
    describeImage: async () => "img",
    describeText: async () => "txt",
    concurrency: 1,
    onProgress: (e) => {
      if (e.type === "describe.start") events.push({ type: e.type });
      else if (e.type === "describe.file.start") events.push({ type: e.type, file: e.absPath });
      else if (e.type === "describe.file.done") events.push({ type: e.type, file: e.absPath });
      else if (e.type === "describe.done") events.push({ type: e.type });
    },
  });

  assert.equal(events[0]!.type, "describe.start");
  assert.equal(events[events.length - 1]!.type, "describe.done");
  const fileStarts = events.filter((e) => e.type === "describe.file.start").length;
  const fileDones = events.filter((e) => e.type === "describe.file.done").length;
  assert.equal(fileStarts, fileDones, "each file gets matching start+done events");
  assert.ok(fileStarts >= 3);
});

test("describeSidecars: returns null gracefully when describeImage hook fails", async (t) => {
  const root = await setupBundle();
  t.after(() => rm(root, { recursive: true, force: true }));

  const bundle = await discoverBundle(root);

  const { warnings, descriptions } = await describeSidecars(bundle, {
    describeImage: async () => { throw new Error("LM Studio offline"); },
    describeText: async () => "ok",
    concurrency: 1,
  });

  /* image не попадает в descriptions, warning записан */
  assert.ok(warnings.some((w) => w.includes("LM Studio offline")));
  /* code и html описаны нормально */
  const code = bundle.sidecars.find((s) => s.kind === "code");
  assert.ok(descriptions.has(code!.absPath));
});

test("describeSidecars: respects abort signal", async (t) => {
  const root = await setupBundle();
  t.after(() => rm(root, { recursive: true, force: true }));

  const bundle = await discoverBundle(root);
  const ctrl = new AbortController();
  ctrl.abort();
  const { descriptions } = await describeSidecars(bundle, {
    describeImage: async () => "x",
    describeText: async () => "y",
    signal: ctrl.signal,
  });
  assert.equal(descriptions.size, 0, "aborted before start → nothing described");
});
