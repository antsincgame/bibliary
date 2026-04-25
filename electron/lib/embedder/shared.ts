/**
 * Shared embedder singleton.
 *
 * Before: scanner/ingest.ts and rag/index.ts each owned a separate
 * pipeline("feature-extraction", model) instance. transformers.js loaded
 * the same multilingual-e5-small twice, costing roughly 150 MB per
 * Electron process when both ingest and chat ran in parallel.
 *
 * After: one cached pipeline per model key. Both call sites import
 * `getEmbedder()`. Race-safe: parallel callers wait on a single Promise
 * during cold-start so we never call `pipeline()` twice for the same key.
 *
 * Embedding text is wrapped here so encoding conventions
 * ("query: " vs "passage: " for E5 family) live in one place.
 */
import type { FeatureExtractionPipeline } from "@xenova/transformers";
import { DEFAULT_EMBED_MODEL } from "../scanner/embedding.js";

async function loadPipeline(): Promise<typeof import("@xenova/transformers")["pipeline"]> {
  const mod = await import("@xenova/transformers");
  return mod.pipeline;
}

interface CachedExtractor {
  ready: Promise<FeatureExtractionPipeline>;
  resolved: FeatureExtractionPipeline | null;
}

const cache = new Map<string, CachedExtractor>();

/* AUDIT 2026-04-21: до этой правки ни pipeline init, ни сам вызов экстрактора
   не были обёрнуты таймаутом. Один зависший ONNX inference (например, OOM в
   Wasm runtime, GPU stall) подвешивал весь Bibliary: ingest, RAG-чат, judge.
   Cold-start легитимно длинный (модель ~150MB качается из HF при первом
   запуске), поэтому два разных лимита. */
const COLD_START_TIMEOUT_MS = 120_000;
const EMBED_CALL_TIMEOUT_MS = 15_000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`[embedder] ${label} timed out after ${ms}ms`));
    }, ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/**
 * Lazy-loaded extractor for the given model key. Subsequent callers
 * with the same key get the cached instance; concurrent callers during
 * cold-start await the same in-flight Promise.
 *
 * Cold-start обёрнут в COLD_START_TIMEOUT_MS — если pipeline init завис,
 * сбрасываем кэш чтобы следующий вызов мог попробовать заново вместо
 * вечного зависания.
 */
export async function getEmbedder(model: string = DEFAULT_EMBED_MODEL): Promise<FeatureExtractionPipeline> {
  const existing = cache.get(model);
  if (existing) {
    return existing.resolved ?? existing.ready;
  }
  const ready = withTimeout(
    (async () => {
      const pipelineFn = await loadPipeline();
      const m = await pipelineFn("feature-extraction", model);
      const slot = cache.get(model);
      if (slot) slot.resolved = m;
      return m;
    })(),
    COLD_START_TIMEOUT_MS,
    `cold-start ${model}`,
  ).catch((e) => {
    /* Сбрасываем неудачный init, чтобы следующая попытка не наследовала
       зависший Promise. */
    cache.delete(model);
    throw e;
  });
  cache.set(model, { ready, resolved: null });
  return ready;
}

/**
 * Embed a single passage (used during ingest -- E5 expects the prefix
 * "passage: " for stored vectors).
 */
export async function embedPassage(text: string, model: string = DEFAULT_EMBED_MODEL): Promise<number[]> {
  const extractor = await getEmbedder(model);
  const out = await withTimeout(
    extractor(`passage: ${text}`, { pooling: "mean", normalize: true }),
    EMBED_CALL_TIMEOUT_MS,
    "embedPassage",
  );
  return Array.from(out.data as Float32Array);
}

/**
 * Embed a search query (E5 expects the prefix "query: " for retrieval-
 * time vectors -- different from passage to maximise cross-encoder match).
 */
export async function embedQuery(text: string, model: string = DEFAULT_EMBED_MODEL): Promise<number[]> {
  const extractor = await getEmbedder(model);
  const out = await withTimeout(
    extractor(`query: ${text}`, { pooling: "mean", normalize: true }),
    EMBED_CALL_TIMEOUT_MS,
    "embedQuery",
  );
  return Array.from(out.data as Float32Array);
}
