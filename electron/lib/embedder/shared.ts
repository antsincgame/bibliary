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
import { pipeline, type FeatureExtractionPipeline } from "@xenova/transformers";
import { DEFAULT_EMBED_MODEL } from "../scanner/embedding.js";

interface CachedExtractor {
  ready: Promise<FeatureExtractionPipeline>;
  resolved: FeatureExtractionPipeline | null;
}

const cache = new Map<string, CachedExtractor>();

/**
 * Lazy-loaded extractor for the given model key. Subsequent callers
 * with the same key get the cached instance; concurrent callers during
 * cold-start await the same in-flight Promise.
 */
export async function getEmbedder(model: string = DEFAULT_EMBED_MODEL): Promise<FeatureExtractionPipeline> {
  const existing = cache.get(model);
  if (existing) {
    return existing.resolved ?? existing.ready;
  }
  const ready = (async () => {
    const m = await pipeline("feature-extraction", model);
    const slot = cache.get(model);
    if (slot) slot.resolved = m;
    return m;
  })();
  cache.set(model, { ready, resolved: null });
  return ready;
}

/**
 * Embed a single passage (used during ingest -- E5 expects the prefix
 * "passage: " for stored vectors).
 */
export async function embedPassage(text: string, model: string = DEFAULT_EMBED_MODEL): Promise<number[]> {
  const extractor = await getEmbedder(model);
  const out = await extractor(`passage: ${text}`, { pooling: "mean", normalize: true });
  return Array.from(out.data as Float32Array);
}

/**
 * Embed a search query (E5 expects the prefix "query: " for retrieval-
 * time vectors -- different from passage to maximise cross-encoder match).
 */
export async function embedQuery(text: string, model: string = DEFAULT_EMBED_MODEL): Promise<number[]> {
  const extractor = await getEmbedder(model);
  const out = await extractor(`query: ${text}`, { pooling: "mean", normalize: true });
  return Array.from(out.data as Float32Array);
}
