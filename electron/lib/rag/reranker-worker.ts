/**
 * Worker-thread entrypoint for BGE reranking.
 *
 * Runs @xenova/transformers outside the Electron main thread. If ONNX/WASM
 * cold-start or tokenization hangs, the parent can terminate this worker without
 * freezing the app.
 */

import { parentPort } from "worker_threads";
import type { FeatureExtractionPipeline } from "@xenova/transformers";
import * as path from "path";

const RERANKER_MODEL = "Xenova/bge-reranker-large";

type LoadedReranker = {
  tokenizer: (input: string[] | string, opts?: Record<string, unknown>) => Promise<unknown> | unknown;
  model: (inputs: unknown) => Promise<{ logits: { data: Float32Array | number[] } }>;
};

let ready: Promise<LoadedReranker> | null = null;

async function loadReranker(): Promise<LoadedReranker> {
  if (ready) return ready;
  ready = (async () => {
    configureTransformersCacheForWorker();
    const mod = await import("@xenova/transformers");
    mod.env.cacheDir = process.env.TRANSFORMERS_CACHE ?? mod.env.cacheDir;
    const { AutoTokenizer, AutoModelForSequenceClassification } = mod as unknown as {
      AutoTokenizer: { from_pretrained(model: string): Promise<LoadedReranker["tokenizer"]> };
      AutoModelForSequenceClassification: { from_pretrained(model: string): Promise<LoadedReranker["model"]> };
    };
    const tokenizer = await AutoTokenizer.from_pretrained(RERANKER_MODEL);
    const model = await AutoModelForSequenceClassification.from_pretrained(RERANKER_MODEL);
    return { tokenizer, model };
  })();
  return ready;
}

function configureTransformersCacheForWorker(): void {
  const dataDir = process.env.BIBLIARY_DATA_DIR?.trim();
  if (!dataDir) return;
  const modelsDir = path.join(dataDir, "models");
  process.env.TRANSFORMERS_CACHE = modelsDir;
  process.env.HF_HOME = modelsDir;
}

parentPort?.on("message", async (msg: { id: string; query: string; passages: string[] }) => {
  try {
    const { tokenizer, model } = await loadReranker();
    const queries = msg.passages.map(() => msg.query);
    const inputs = await tokenizer(queries, {
      text_pair: msg.passages,
      padding: true,
      truncation: true,
      max_length: 512,
    });
    const outputs = await model(inputs);
    parentPort?.postMessage({
      id: msg.id,
      ok: true,
      logits: Array.from(outputs.logits.data),
    });
  } catch (e) {
    parentPort?.postMessage({
      id: msg.id,
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    });
  }
});

/* Type-only import guard: keeps TS aware of transformers types in this module. */
void (undefined as unknown as FeatureExtractionPipeline | undefined);
