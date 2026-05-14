import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { loadEdgeParse, _resetEdgeParseCacheForTests } from "../server/lib/scanner/parsers/edgeparse-bridge.js";
import { tryParsePdfWithEdgeParse } from "../server/lib/scanner/parsers/edgeparse-parser.js";

const CORPUS_DIR = "D:\\Bibliarifull";
const hasCorpus = fs.existsSync(CORPUS_DIR);

describe("edgeparse-bridge", () => {
  it("loadEdgeParse returns a working module", async () => {
    _resetEdgeParseCacheForTests();
    const mod = await loadEdgeParse();
    assert.ok(mod, "edgeparse module should load on win32-x64");
    assert.equal(typeof mod!.convert, "function");
    assert.equal(typeof mod!.version, "function");
    const ver = mod!.version();
    assert.ok(ver.length > 0, `version should be non-empty, got: ${ver}`);
  });
});

describe("edgeparse-parser integration", { skip: !hasCorpus && "D:\\Bibliarifull not found" }, () => {
  it("parses Stroustrup C++ (text-based PDF)", async () => {
    const pdf = path.join(CORPUS_DIR, "Stroustrup B. - A Tour of C++ - Second Edition - 2018.pdf");
    if (!fs.existsSync(pdf)) {
      return;
    }
    const outcome = await tryParsePdfWithEdgeParse(pdf);
    assert.equal(outcome.status, "ok", `expected ok, got: ${outcome.status} — ${outcome.reason}`);
    assert.ok(outcome.result, "result should exist");
    assert.ok(outcome.result!.sections.length > 5, `sections: ${outcome.result!.sections.length}`);
    assert.ok(outcome.result!.rawCharCount > 100_000, `chars: ${outcome.result!.rawCharCount}`);
    assert.ok(outcome.durationMs! > 0, `durationMs: ${outcome.durationMs}`);
  });

  it("returns ok for a small text PDF", async () => {
    const files = fs.readdirSync(CORPUS_DIR).filter((f) => f.endsWith(".pdf")).slice(0, 5);
    let tested = 0;
    for (const file of files) {
      const outcome = await tryParsePdfWithEdgeParse(path.join(CORPUS_DIR, file));
      if (outcome.status === "ok") {
        assert.ok(outcome.result!.sections.length > 0);
        tested++;
        if (tested >= 2) break;
      }
    }
    assert.ok(tested > 0, "at least one PDF from corpus should parse with edgeparse");
  });

  it("gracefully handles non-PDF file", async () => {
    const tmpFile = path.join(CORPUS_DIR, "__edgeparse_test_not_a_pdf.txt");
    let created = false;
    try {
      fs.writeFileSync(tmpFile, "This is not a PDF file.");
      created = true;
      const outcome = await tryParsePdfWithEdgeParse(tmpFile);
      assert.ok(
        outcome.status === "fallback" || outcome.status === "skipped",
        `expected fallback/skipped, got: ${outcome.status}`,
      );
    } finally {
      if (created) fs.unlinkSync(tmpFile);
    }
  });
});
