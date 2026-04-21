import { promises as fs } from "fs";
import * as path from "path";
import { TELEMETRY_MAX_BYTES } from "./constants";

export type TelemetryEvent =
  | { type: "batch.start"; batchId: string; pipeline: "extraction" | "forge"; config: unknown; ts: string }
  | { type: "forge.run.start"; runId: string; target: string; baseModel: string; method: string; ts: string }
  | { type: "forge.run.success"; runId: string; durationMs: number; ts: string }
  | { type: "forge.run.fail"; runId: string; target: string; error: string; ts: string }
  | { type: "forge.cloud.upload"; runId: string; target: string; sizeMB: number; ok: boolean; ts: string }
  | { type: "forge.eval.judge_error"; caseIndex: number; tunedModel: string; error: string; ts: string }
  | {
      type: "batch.chunk.ok";
      batchId: string;
      chunkId: string;
      latencyMs: number;
      tokens?: { prompt: number; completion: number };
      recovered?: boolean;
      ts: string;
    }
  | { type: "batch.chunk.fail"; batchId: string; chunkId: string; error: string; attempt: number; ts: string }
  | { type: "batch.end"; batchId: string; ok: number; failed: number; durationMs: number; ts: string }
  | { type: "shutdown.flush.start"; pendingBatches: string[]; ts: string }
  | { type: "shutdown.flush.ok"; durationMs: number; ts: string }
  | { type: "shutdown.flush.timeout"; pendingBatches: string[]; ts: string }
  | { type: "shutdown.flush.error"; error: string; ts: string }
  | { type: "lmstudio.offline"; consecutiveFailures: number; ts: string }
  | { type: "lmstudio.online"; ts: string }
  | { type: "lmstudio.throttle"; tps: number; newCoolDownMs: number; ts: string }
  | { type: "lmstudio.crash_detected"; modelKey: string; ts: string }
  | { type: "yarn.context.changed"; modelKey: string; fromTokens: number; toTokens: number; factor: number | null; kvDtype: string; ts: string }
  | { type: "yarn.preset.applied"; modelKey: string; presetId: string; targetTokens: number; ts: string }
  | { type: "yarn.suggestion.shown"; modelKey: string; suggestionId: string; severity: string; ts: string }
  | { type: "yarn.suggestion.applied"; modelKey: string; suggestionId: string; action: string; ts: string }
  | { type: "yarn.applied"; modelKey: string; factor: number; kvDtype: string; vramEstimateGb: number; ts: string }
  | { type: "yarn.reverted"; modelKey: string; reason: string; ts: string }
  | { type: "yarn.error"; modelKey: string; error: string; ts: string };

export type TelemetryEventInput<E extends TelemetryEvent = TelemetryEvent> = E extends TelemetryEvent
  ? Omit<E, "ts"> & { ts?: string }
  : never;

let configuredPath: string | null = null;
let configuredMaxBytes = TELEMETRY_MAX_BYTES;
let writeChain: Promise<void> = Promise.resolve();

export function configureTelemetry(opts: { filePath: string; maxBytes?: number }): void {
  configuredPath = opts.filePath;
  if (typeof opts.maxBytes === "number" && opts.maxBytes > 0) {
    configuredMaxBytes = opts.maxBytes;
  }
}

export function logEvent<E extends TelemetryEvent>(event: TelemetryEventInput<E>): void {
  if (!configuredPath) return;
  const enriched = { ts: new Date().toISOString(), ...(event as object) } as TelemetryEvent;
  const line = JSON.stringify(enriched) + "\n";
  const targetPath = configuredPath;
  writeChain = writeChain
    .then(() => appendWithRotation(targetPath, line, configuredMaxBytes))
    .catch((err) => {
      console.error("[telemetry] write failed:", err instanceof Error ? err.message : err);
    });
}

export async function flush(): Promise<void> {
  await writeChain;
}

export async function tail(n: number): Promise<TelemetryEvent[]> {
  if (!configuredPath) return [];
  await flush();
  let raw: string;
  try {
    raw = await fs.readFile(configuredPath, "utf8");
  } catch {
    return [];
  }
  const lines = raw.split("\n").filter((line) => line.trim().length > 0);
  const slice = n > 0 ? lines.slice(-n) : lines;
  const events: TelemetryEvent[] = [];
  for (const line of slice) {
    try {
      events.push(JSON.parse(line) as TelemetryEvent);
    } catch {
      // повреждённую строку пропускаем
    }
  }
  return events;
}

async function appendWithRotation(filePath: string, line: string, maxBytes: number): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  let size = 0;
  try {
    const stat = await fs.stat(filePath);
    size = stat.size;
  } catch {
    size = 0;
  }

  if (size + line.length > maxBytes && size > 0) {
    await rotate(filePath);
  }

  await fs.appendFile(filePath, line, "utf8");
}

async function rotate(filePath: string): Promise<void> {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath, ".jsonl");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const rotated = path.join(dir, `${base}-${stamp}.jsonl`);
  try {
    await fs.rename(filePath, rotated);
  } catch (err) {
    console.error("[telemetry] rotation failed:", err instanceof Error ? err.message : err);
  }
}
