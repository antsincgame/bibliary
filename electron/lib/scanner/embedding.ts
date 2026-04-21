/**
 * Embedding model contract -- single source of truth for vector dimension
 * and chunk truncation budget.
 *
 * Why a separate file: hard-coded `384` was duplicated across ingest.ts,
 * dataset-v2/judge.ts and qdrant.ipc.ts. Any future model swap (BGE,
 * mxbai, OpenAI) means changing the number in one place and everything
 * downstream stays consistent.
 *
 * If you change EMBEDDING_DIM, you MUST also change the model name and
 * vacate existing Qdrant collections (different dim = incompatible vectors).
 */

/**
 * Default embedding model. Used by the scanner ingest pipeline and the
 * judge cross-library dedupe step.
 */
export const DEFAULT_EMBED_MODEL = "Xenova/multilingual-e5-small";

/**
 * Vector dimension produced by the default embedding model.
 *
 * multilingual-e5-small: 384 dims.
 * If you switch model, update this constant. Verify with:
 *   const v = await pipeline("feature-extraction", MODEL)(text, ...);
 *   v.data.length === EMBEDDING_DIM
 */
export const EMBEDDING_DIM = 384;

/**
 * Hard cap on input text length per chunk before embedding.
 *
 * Reasoning: e5-small has a 512-token context window; ~8000 characters of
 * mixed Cyrillic + Latin text comfortably fits after BPE tokenisation
 * (avg ~3-4 chars/token). Going higher risks silent truncation by the
 * tokenizer, which produces unstable embeddings.
 *
 * If you change EMBEDDING_DIM (different model), reconsider this cap.
 */
export const EMBED_MAX_INPUT_CHARS = 8000;
