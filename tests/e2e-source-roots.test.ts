import { test, describe } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";

import { getSourceRootsFromArgv } from "../scripts/e2e-source-roots.ts";

describe("[e2e-source-roots] source root selection", () => {
  test("uses explicit --source-dir roots without adding defaults", () => {
    const roots = getSourceRootsFromArgv(["--source-dir", "D:\\Bibliarifull"], "D:\\projects\\bibliary\\data\\library");

    assert.deepEqual(roots, [path.resolve("D:\\Bibliarifull")]);
  });

  test("falls back to Downloads and library when no explicit root exists", () => {
    const roots = getSourceRootsFromArgv([], "D:\\projects\\bibliary\\data\\library");

    assert.equal(roots.length, 2);
    assert.equal(roots[1], path.resolve("D:\\projects\\bibliary\\data\\library"));
  });
});
