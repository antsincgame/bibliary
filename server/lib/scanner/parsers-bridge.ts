import type { ParseOptions, ParseResult } from "./parser-types.js";

/**
 * Runtime adapter that loads the real parser pipeline from
 * `electron/lib/scanner/parsers/` without dragging tsc into a transitive
 * type-check across the two trees (the electron tree compiles with
 * different module settings — extensionless imports, CJS, etc.).
 *
 * We load via a NON-literal `import(path)` expression so TypeScript's
 * static analyser cannot resolve the target file. The runtime is plain
 * Node ESM (tsx in dev, tsc-emitted JS in prod). Until Phase 12 moves
 * scanner core into `server/lib/scanner/`, this bridge is the seam.
 */

interface ParsersModule {
  parseBook: (filePath: string, opts?: ParseOptions) => Promise<ParseResult>;
}

let cached: ParsersModule | null = null;

async function load(): Promise<ParsersModule> {
  if (cached) return cached;
  /* Variable indirection so tsc treats the import as runtime-only. */
  const target = "../../../electron/lib/scanner/parsers/index.js";
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
