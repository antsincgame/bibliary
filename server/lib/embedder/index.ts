import * as path from "node:path";

import type { FeatureExtractionPipeline } from "@xenova/transformers";

import { loadConfig } from "../../config.js";

/**
 * Phase 10 — server-side embedder для DeltaKnowledge concepts.
 *
 * Lazy-loaded singleton over @xenova/transformers ONNX pipeline.
 * Один процесс — одна кэшированная модель; concurrent callers ждут
 * shared Promise во время cold-start.
 *
 * E5 prefix discipline (intfloat/multilingual-e5-small):
 *   - "passage: <text>" для stored vectors (corpus side)
 *   - "query: <text>"   для retrieval queries
 * Смешивание prefix'ов снижает cosine similarity на ~5-8 пунктов F1.
 *
 * Cold-start: ~5-15s (модель ~120MB ONNX скачивается из HuggingFace
 * Hub если не в cache). В Docker image pre-bake'нём в Phase 11 build.
 *
 * Output: 384-dim Float32Array (multilingual-e5-small dim per HF model
 * card). Matches sqlite-vec concepts_vec schema (BIBLIARY_EMBEDDING_DIM
 * = 384 default).
 */

export const DEFAULT_EMBED_MODEL = "Xenova/multilingual-e5-small";

const COLD_START_TIMEOUT_MS = 120_000;
const EMBED_CALL_TIMEOUT_MS = 15_000;

interface CachedExtractor {
  ready: Promise<FeatureExtractionPipeline>;
  resolved: FeatureExtractionPipeline | null;
}

const cache = new Map<string, CachedExtractor>();

/**
 * Configure HF cache directory so ONNX-модели live в BIBLIARY_DATA_DIR/models
 * (deterministic location for Docker volume mount; не разбросано в
 * ~/.cache/huggingface). Idempotent.
 */
function configureCache(): void {
  const cfg = loadConfig();
  if (!cfg.BIBLIARY_DATA_DIR) return;
  const modelsDir = path.join(cfg.BIBLIARY_DATA_DIR, "models");
  process.env["TRANSFORMERS_CACHE"] = modelsDir;
  process.env["HF_HOME"] = modelsDir;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`[embedder] ${label} timed out after ${ms}ms`));
    }, ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

export async function getEmbedder(
  model: string = DEFAULT_EMBED_MODEL,
): Promise<FeatureExtractionPipeline> {
  const existing = cache.get(model);
  if (existing) {
    return existing.resolved ?? existing.ready;
  }
  const ready = withTimeout(
    (async () => {
      configureCache();
      const mod = await import("@xenova/transformers");
      mod.env.cacheDir = process.env["TRANSFORMERS_CACHE"] ?? mod.env.cacheDir;
      const pipeline = await mod.pipeline("feature-extraction", model);
      const slot = cache.get(model);
      if (slot) slot.resolved = pipeline;
      return pipeline as FeatureExtractionPipeline;
    })(),
    COLD_START_TIMEOUT_MS,
    `cold-start ${model}`,
  ).catch((e) => {
    /* Сбрасываем неудачный init — следующая попытка может попробовать заново. */
    cache.delete(model);
    throw e;
  });
  cache.set(model, { ready, resolved: null });
  return ready;
}

/**
 * Embed a passage (stored vector side — DeltaKnowledge essence/cipher/proof).
 * Возвращает 384-dim Float32Array, normalized (cosine similarity = dot product).
 */
export async function embedPassage(
  text: string,
  model: string = DEFAULT_EMBED_MODEL,
): Promise<Float32Array> {
  const extractor = await getEmbedder(model);
  const out = await withTimeout(
    extractor(`passage: ${text}`, { pooling: "mean", normalize: true }),
    EMBED_CALL_TIMEOUT_MS,
    "embedPassage",
  );
  return new Float32Array(out.data as Float32Array);
}

/**
 * Embed a query (search side — user input для semantic retrieval).
 * Cross-encoder match с stored passage vectors.
 */
export async function embedQuery(
  text: string,
  model: string = DEFAULT_EMBED_MODEL,
): Promise<Float32Array> {
  const extractor = await getEmbedder(model);
  const out = await withTimeout(
    extractor(`query: ${text}`, { pooling: "mean", normalize: true }),
    EMBED_CALL_TIMEOUT_MS,
    "embedQuery",
  );
  return new Float32Array(out.data as Float32Array);
}

/**
 * Helper для concept persistence: builds embed text из delta fields
 * naturally weighting them. Essence + cipher + tags = «смысловая
 * сердцевина» concept'а. Domain context добавлен для cross-domain
 * disambiguation (same word в physics vs philosophy).
 */
export function buildConceptEmbedText(delta: {
  domain: string;
  essence: string;
  cipher: string;
  proof: string;
  tags: string[];
}): string {
  return [
    `domain: ${delta.domain}`,
    `essence: ${delta.essence}`,
    `cipher: ${delta.cipher}`,
    `tags: ${delta.tags.join(", ")}`,
    `proof: ${delta.proof}`,
  ].join("\n");
}

/**
 * Pre-warm hook for server startup. Triggers cold-start in the
 * background so the first user-facing embed call doesn't pay the
 * ~5-15s ONNX model load latency. Fire-and-forget — failures here are
 * non-fatal (the lazy path will retry on the first real call).
 *
 * Call once from server bootstrap AFTER the HTTP listener is bound,
 * so the warm-up never blocks the readiness probe.
 *
 * Skipped via BIBLIARY_SKIP_EMBEDDER_PREWARM=1 (useful in CI and on
 * resource-constrained dev machines).
 */
export function prewarmEmbedderInBackground(): void {
  if (process.env["BIBLIARY_SKIP_EMBEDDER_PREWARM"] === "1") return;
  void getEmbedder()
    .then(async (extractor) => {
      /* One tiny inference primes the ONNX session graph + kernel
       * caches so the first real embed isn't slow either. */
      try {
        await extractor("query: warm", { pooling: "mean", normalize: true });
      } catch {
        /* tolerate — primary getEmbedder already succeeded; the warm
         * inference is best-effort */
      }
    })
    .catch((err) => {
      console.warn(
        "[embedder] pre-warm failed:",
        err instanceof Error ? err.message : err,
      );
    });
}

/** Test helpers — drop cached pipelines between tests. */
export function _resetEmbedderForTesting(): void {
  cache.clear();
}
