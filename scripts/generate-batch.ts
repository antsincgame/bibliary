import { existsSync } from "node:fs";
import * as path from "node:path";
import "dotenv/config";
import { initResilienceLayer, coordinator, telemetry } from "../electron/lib/resilience/index.js";
import { registerDatasetPipeline, getPaths } from "../electron/finetune-state.js";
import { generateBatch, type ChunkProgressEvent } from "../electron/dataset-generator.js";
import { BatchSettingsSchema, PHASES } from "../electron/dataset-generator-config.js";

const DEFAULT_BATCH_SIZE = 15;
const DEFAULT_DELAY_MS = 300;
const DEFAULT_FEW_SHOT = 2;
const DEFAULT_CONTEXT_LENGTH = 32768;

interface CliArgs {
  batchSize: number;
  delayMs: number;
  fewShotCount: number;
  contextLength: number;
}

function parseArgs(): CliArgs {
  let batchSize = DEFAULT_BATCH_SIZE;
  let delayMs = DEFAULT_DELAY_MS;
  let fewShotCount = DEFAULT_FEW_SHOT;
  let contextLength = DEFAULT_CONTEXT_LENGTH;

  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === "--batch-size" && process.argv[i + 1]) {
      batchSize = parseInt(process.argv[++i], 10);
    } else if (arg === "--delay-ms" && process.argv[i + 1]) {
      delayMs = parseInt(process.argv[++i], 10);
    } else if (arg === "--few-shot" && process.argv[i + 1]) {
      fewShotCount = parseInt(process.argv[++i], 10);
    } else if (arg === "--context" && process.argv[i + 1]) {
      contextLength = parseInt(process.argv[++i], 10);
    }
  }

  return { batchSize, delayMs, fewShotCount, contextLength };
}

async function main(): Promise<void> {
  const args = parseArgs();

  await initResilienceLayer({ defaultsDir: path.resolve("electron", "defaults") });
  registerDatasetPipeline();

  const { sourcePath } = getPaths();
  if (!existsSync(sourcePath)) {
    console.error(`Source file not found: ${sourcePath}`);
    process.exit(1);
  }

  const settings = BatchSettingsSchema.parse({
    profile: "BIG",
    contextLength: args.contextLength,
    batchSize: args.batchSize,
    delayMs: args.delayMs,
    fewShotCount: args.fewShotCount,
    sampling: {
      temperature: 0.7,
      top_p: 0.8,
      top_k: 20,
      min_p: 0,
      presence_penalty: 1.0,
      max_tokens: 4096,
    },
  });

  const batchId = `cli-${Date.now()}`;
  const controller = new AbortController();

  const onShutdown = (signal: string): void => {
    console.log(`\n[${signal}] Stopping. State will be saved on next chunk boundary.`);
    controller.abort(signal);
  };
  process.on("SIGINT", () => onShutdown("SIGINT"));
  process.on("SIGTERM", () => onShutdown("SIGTERM"));

  console.log("\n--- MECHANICUS Dataset Generator (CLI) ---");
  console.log(`batchSize=${args.batchSize} delayMs=${args.delayMs} fewShot=${args.fewShotCount}`);

  const emitter = (event: ChunkProgressEvent): void => {
    if (event.phase === "done") {
      console.log(
        `[${event.index}/${event.total}] ${event.domain}: ${event.principleHead} OK (${event.elapsedMs}ms)`
      );
    } else if (event.phase === "error") {
      console.error(`[${event.index}/${event.total}] FAILED: ${event.error}`);
    }
  };

  let exitCode = 0;
  try {
    const result = await generateBatch(batchId, controller.signal, settings, emitter);
    console.log("\n--- Result ---");
    console.log(`batch       : ${result.batchName}`);
    console.log(`processed   : ${result.processedCount}`);
    console.log(`examples    : ${result.examplesCount} (${PHASES.length} per chunk)`);
    console.log(`failed      : ${result.failedCount}`);
    console.log(`file        : ${result.batchFile}`);
  } catch (e) {
    console.error("Fatal:", e instanceof Error ? e.message : e);
    exitCode = 1;
  } finally {
    const flush = await coordinator.flushAll(3000);
    if (!flush.ok) {
      console.warn(`flushAll timeout, pending: ${flush.pending.join(", ")}`);
    }
    await telemetry.flush().catch(() => undefined);
  }

  process.exit(exitCode);
}

main().catch((e: unknown) => {
  console.error("Fatal:", e);
  process.exit(1);
});
