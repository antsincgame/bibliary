import type { ParseOptions, ParseResult } from "./parser-types.js";

/**
 * Runtime adapter for the parser pipeline at `./parsers/`.
 *
 * The scanner closure now lives in-tree under `server/lib/scanner/`. The
 * variable-indirection `import(path)` is kept for now (rather than a static
 * import) so the bridge stays a thin, dependency-light seam; a later cleanup
 * can collapse it once the test-import codemod lands.
 */

interface ParsersModule {
  parseBook: (filePath: string, opts?: ParseOptions) => Promise<ParseResult>;
}

let cached: ParsersModule | null = null;

async function load(): Promise<ParsersModule> {
  if (cached) return cached;
  /* Variable indirection keeps the bridge a thin runtime-only seam. */
  const target = "./parsers/index.js";
  const mod = (await import(target)) as unknown as ParsersModule;
  cached = mod;
  return mod;
}

export async function parseBook(
  filePath: string,
  opts?: ParseOptions,
): Promise<ParseResult> {
  const m = await load();
  return m.parseBook(filePath, opts);
}
