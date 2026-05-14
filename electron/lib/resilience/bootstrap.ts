import { promises as fs, existsSync, lstatSync, rmSync } from "fs";
import * as path from "path";
import { configureTelemetry } from "./telemetry.js";
import { TELEMETRY_MAX_BYTES } from "./constants.js";
import { initPromptStore } from "../prompts/store.js";

export interface ResilienceInitOptions {
  dataDir?: string;
  defaultsDir?: string;
  telemetryMaxBytes?: number;
}

let initialized = false;

/**
 * Remove orphaned junction / symlink whose target no longer exists.
 * On Windows a dead junction makes `mkdir(path, {recursive:true})` throw
 * ENOENT even though the directory entry is present in the filesystem.
 */
function removeDeadJunction(dir: string): void {
  try {
    if (!existsSync(dir)) {
      const stat = lstatSync(dir);
      if (stat.isSymbolicLink() || stat.isDirectory()) {
        rmSync(dir, { force: true });
        console.warn(`[bootstrap] removed dead junction/symlink: ${dir}`);
      }
    }
  } catch {
    /* entry truly absent — nothing to do */
  }
}

export async function initResilienceLayer(opts: ResilienceInitOptions = {}): Promise<void> {
  if (initialized) return;
  const dataDir = path.resolve(opts.dataDir ?? "data");
  const defaultsDir = path.resolve(opts.defaultsDir ?? path.join(__dirname, "..", "..", "defaults"));
  const checkpointsDir = path.join(dataDir, "checkpoints");
  const promptsDir = path.join(dataDir, "prompts");
  const telemetryPath = path.join(dataDir, "telemetry.jsonl");

  removeDeadJunction(checkpointsDir);
  removeDeadJunction(promptsDir);

  await fs.mkdir(checkpointsDir, { recursive: true });
  await fs.mkdir(promptsDir, { recursive: true });
  await fs.mkdir(path.dirname(telemetryPath), { recursive: true });

  await assertWritable(dataDir);

  configureTelemetry({
    filePath: telemetryPath,
    maxBytes: opts.telemetryMaxBytes ?? TELEMETRY_MAX_BYTES,
  });

  const promptStore = initPromptStore({
    dataDir: promptsDir,
    defaultsDir: path.join(defaultsDir, "prompts"),
  });
  await promptStore.ensureDefaults();

  initialized = true;
}

async function assertWritable(dir: string): Promise<void> {
  const probe = path.join(dir, `.write-probe-${Date.now()}`);
  try {
    await fs.writeFile(probe, "ok", "utf8");
  } finally {
    await fs.unlink(probe).catch((err) => console.error("[bootstrap/ensureWritable] unlink Error:", err));
  }
}
