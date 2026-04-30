/**
 * Run a TypeScript/JavaScript script using Electron's embedded Node runtime.
 *
 * Why this exists:
 *   Heavy E2E import scripts use better-sqlite3 through the real Bibliary
 *   library pipeline. In this repo, `postinstall` rebuilds better-sqlite3 for
 *   Electron ABI, while `npx tsx ...` runs under system Node ABI. Running the
 *   script with plain Node can fail with ERR_DLOPEN_FAILED:
 *     NODE_MODULE_VERSION 145 vs 127
 *
 * This wrapper launches Electron with ELECTRON_RUN_AS_NODE=1 so native modules
 * use the same ABI as the real app. No rebuild flip-flop required.
 *
 * Usage:
 *   node scripts/run-electron-node.cjs scripts/e2e-1000-random-sample.ts --root D:\Bibliarifull --sample 1000
 */

const { spawnSync } = require("child_process");
const path = require("path");

const [, , script, ...args] = process.argv;
if (!script) {
  console.error("Usage: node scripts/run-electron-node.cjs <script.ts|script.js> [...args]");
  process.exit(1);
}

const electronCli = path.join(__dirname, "..", "node_modules", "electron", "cli.js");
const scriptPath = path.isAbsolute(script) ? script : path.join(process.cwd(), script);

const result = spawnSync(
  process.execPath,
  [
    electronCli,
    "--import",
    "tsx",
    scriptPath,
    ...args,
  ],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
    },
    cwd: process.cwd(),
  },
);

if (result.error) {
  console.error(result.error);
  process.exit(1);
}
process.exit(typeof result.status === "number" ? result.status : 1);
