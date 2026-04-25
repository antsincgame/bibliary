import { promises as fs } from "fs";
import * as path from "path";
import { configureTelemetry } from "./telemetry";
import { TELEMETRY_MAX_BYTES } from "./constants";
import { initPromptStore } from "../prompts/store";
import { initProfileStore } from "../profiles/store";

/**
 * Note: forge store is intentionally NOT initialised here. It used to be,
 * but that created a circular dependency (`forge/state` imports the
 * resilience barrel; this file imports `forge/state`). Forge store is
 * now bootstrapped from `electron/main.ts` after this layer is up.
 */

export interface ResilienceInitOptions {
  dataDir?: string;
  defaultsDir?: string;
  telemetryMaxBytes?: number;
}

let initialized = false;

export async function initResilienceLayer(opts: ResilienceInitOptions = {}): Promise<void> {
  if (initialized) return;
  const dataDir = path.resolve(opts.dataDir ?? "data");
  const defaultsDir = path.resolve(opts.defaultsDir ?? path.join(__dirname, "..", "..", "defaults"));
  const checkpointsDir = path.join(dataDir, "checkpoints");
  const promptsDir = path.join(dataDir, "prompts");
  const telemetryPath = path.join(dataDir, "telemetry.jsonl");

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

  const profileStore = initProfileStore({ dataDir });
  await profileStore.ensureDefaults();

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
