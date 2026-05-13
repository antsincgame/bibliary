import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface VersionInfo {
  version: string;
  commit: string | null;
  builtAt: string | null;
}

let cached: VersionInfo | null = null;

export function getVersionInfo(): VersionInfo {
  if (cached) return cached;

  const here = dirname(fileURLToPath(import.meta.url));
  const pkgPath = resolve(here, "..", "..", "package.json");

  let version = "0.0.0";
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    if (pkg.version) version = pkg.version;
  } catch {
    /* package.json missing in some test contexts — fall through with default */
  }

  cached = {
    version,
    commit: process.env.GIT_COMMIT ?? null,
    builtAt: process.env.BUILT_AT ?? null,
  };
  return cached;
}
