/**
 * Golden-corpus reference generator.
 *
 * Runs the *current* scanner over each fixture in the manifest and
 * writes its rendered parse to `<name>.ref.md`. The operator then
 * hand-verifies each `.ref.md` per `tests/golden-corpus/README.md`
 * before committing it — that verified snapshot is what
 * `tests/golden-corpus.test.ts` gates future scanner changes against.
 *
 * Usage:
 *   npm run golden:generate                 # (re)generate every entry
 *   npm run golden:generate 01-rus.epub     # one or more named fixtures
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { FIXTURES_DIR, loadManifest, parseFixture } from "../tests/golden-corpus/harness.ts";

async function main(): Promise<void> {
  const manifest = loadManifest();
  if (manifest.length === 0) {
    console.log(
      "[golden] manifest is empty — add books + entries to " +
        "tests/golden-corpus/fixtures/manifest.json first " +
        "(see tests/golden-corpus/README.md).",
    );
    return;
  }

  const only = process.argv.slice(2);
  const entries = only.length > 0 ? manifest.filter((e) => only.includes(e.name)) : manifest;
  if (entries.length === 0) {
    console.log(`[golden] no manifest entries match: ${only.join(", ")}`);
    return;
  }

  let ok = 0;
  let failed = 0;
  for (const entry of entries) {
    process.stdout.write(`[golden] parsing ${entry.name} … `);
    try {
      const rendered = await parseFixture(entry.name);
      writeFileSync(join(FIXTURES_DIR, entry.referenceMarkdown), rendered, "utf-8");
      console.log(`→ ${entry.referenceMarkdown} (${rendered.length} chars)`);
      ok += 1;
    } catch (err) {
      console.log(`FAILED: ${err instanceof Error ? err.message : String(err)}`);
      failed += 1;
    }
  }

  console.log(
    `[golden] ${ok} reference(s) written, ${failed} failed. ` +
      "Hand-verify each .ref.md per tests/golden-corpus/README.md before committing.",
  );
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("[golden] fatal:", err);
  process.exit(1);
});
