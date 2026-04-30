/**
 * Qdrant illustrations index — multimodal векторный поиск по картинкам книг.
 *
 * Зачем:
 *   - Текстовый E5 не умеет искать по визуальному контенту.
 *   - illustration-worker генерирует ОПИСАНИЕ картинки vision-LLM, но без CLIP
 *     описание индексируется только как текст в основной коллекции — нельзя
 *     сделать "найди похожие картинки" или "найди иллюстрацию по запросу
 *     'cache hierarchy diagram'".
 *
 * Решение:
 *   - Отдельная коллекция `bibliary_illustrations` в Qdrant.
 *   - Vector = CLIP image embedding (512 dims, cosine).
 *   - Payload: { bookSourcePath, bookTitle, sha256, mimeType, score,
 *     description, chapterTitle, caption, illustrationId }.
 *   - Поиск:
 *       text query → embedTextForImage (CLIP text encoder, same 512-dim space)
 *       image query → embedImage
 *
 * Idempotency:
 *   - Точки имеют детерминированный id = sha1(sha256+bookSourcePath).
 *   - Повторная индексация той же иллюстрации перезаписывает точку.
 */

import { fetchQdrantJson, QDRANT_URL } from "./http-client.js";
import { IMAGE_EMBED_DIMS, embedImage } from "../embedder/image-embedder.js";
import { ensurePayloadIndex } from "./collection-config.js";
import { createHash } from "crypto";

/** Default collection name. Overridable via ENV for tests. */
export const ILLUSTRATIONS_COLLECTION =
  process.env.BIBLIARY_ILLUSTRATIONS_COLLECTION || "bibliary_illustrations";

export interface IllustrationVectorPayload {
  /** Absolute path of the source book (same as text-index payload). */
  bookSourcePath: string;
  /** Human-readable title (best-effort, can be empty). */
  bookTitle: string;
  /** Content-addressable storage hash — used to dedupe + locate blob. */
  sha256: string;
  /** MIME of the stored blob (image/jpeg, image/png, ...). */
  mimeType: string;
  /** Vision-LLM informational score 0-10. */
  score: number;
  /** Vision-LLM description (also indexed in main text collection). */
  description: string;
  /** Optional caption from source markdown / EPUB OPF / FB2. */
  caption?: string;
  /** Optional chapter title for filtering. */
  chapterTitle?: string;
  /** Illustration record id (e.g. "img-001", "img-cover"). */
  illustrationId: string;
  /** ISO timestamp when this vector was indexed. */
  indexedAt: string;
}

/**
 * Compute the deterministic point id for an illustration.
 * Uses sha1(sha256+bookSourcePath) → hex (Qdrant accepts UUID-ish hex).
 */
export function illustrationPointId(sha256: string, bookSourcePath: string): string {
  const h = createHash("sha1");
  h.update(sha256);
  h.update("|");
  h.update(bookSourcePath);
  /* Qdrant требует UUID или unsigned int; sha1 hex ровно 40 символов — приведём
   * к формату 8-4-4-4-12 чтобы пройти UUID-валидацию (иначе qdrant отвергает). */
  const hex = h.digest("hex").slice(0, 32); /* 32 nibbles = 128 bit как UUID */
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Ensure the illustrations collection exists with the expected vector size.
 * Idempotent: safe to call on every app start.
 */
export async function ensureIllustrationsCollection(qdrantUrl: string = QDRANT_URL): Promise<void> {
  /* Probe existing collection. */
  try {
    await fetchQdrantJson<{ result: unknown }>(
      `${qdrantUrl}/collections/${ILLUSTRATIONS_COLLECTION}`,
      { method: "GET", timeoutMs: 5_000 },
    );
    return; /* exists */
  } catch {
    /* not found → create */
  }

  await fetchQdrantJson<{ result: unknown }>(
    `${qdrantUrl}/collections/${ILLUSTRATIONS_COLLECTION}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        vectors: { size: IMAGE_EMBED_DIMS, distance: "Cosine" },
        optimizers_config: { default_segment_number: 2 },
        /* HNSW tuning (Qdrant 2026 best practice for 10K+ vectors): m=24
           даёт +5-8% recall vs default 16, ef_construct=128 — стандартное
           build quality. CLIP 512d не требует более высоких значений. */
        hnsw_config: { m: 24, ef_construct: 128 },
      }),
      timeoutMs: 15_000,
    },
  );

  /* Payload indexes — превращают filtered search "по книге" из O(N) в O(log N).
     Безопасно для новой коллекции, идемпотентно для существующей. */
  await ensurePayloadIndex(ILLUSTRATIONS_COLLECTION, "bookSourcePath", "keyword", qdrantUrl);
  await ensurePayloadIndex(ILLUSTRATIONS_COLLECTION, "sha256", "keyword", qdrantUrl);
}

/**
 * Index one illustration: read its CLIP embedding from disk and upsert
 * into Qdrant with full payload.
 *
 * `imagePathOrDataUrl` — absolute file path or data: URL accepted by
 * `embedImage()`.
 */
export async function indexIllustration(
  imagePathOrDataUrl: string,
  payload: Omit<IllustrationVectorPayload, "indexedAt">,
  qdrantUrl: string = QDRANT_URL,
): Promise<{ id: string }> {
  const vector = await embedImage(imagePathOrDataUrl);
  if (vector.length !== IMAGE_EMBED_DIMS) {
    throw new Error(
      `[illustrations-index] embedImage returned ${vector.length} dims, expected ${IMAGE_EMBED_DIMS}`,
    );
  }

  const id = illustrationPointId(payload.sha256, payload.bookSourcePath);
  const fullPayload: IllustrationVectorPayload = {
    ...payload,
    indexedAt: new Date().toISOString(),
  };

  await fetchQdrantJson(
    `${qdrantUrl}/collections/${ILLUSTRATIONS_COLLECTION}/points?wait=true`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        points: [{ id, vector, payload: fullPayload }],
      }),
      timeoutMs: 15_000,
    },
  );

  return { id };
}

/**
 * Search illustrations by a TEXT query (CLIP text encoder → image space).
 * Returns top-N with payload + similarity score.
 */
export async function searchIllustrationsByText(
  queryText: string,
  opts: {
    limit?: number;
    scoreThreshold?: number;
    bookSourcePath?: string; /* optional filter: scope to single book */
    qdrantUrl?: string;
  } = {},
): Promise<Array<{ id: string; score: number; payload: IllustrationVectorPayload }>> {
  const { embedTextForImage } = await import("../embedder/image-embedder.js");
  const vector = await embedTextForImage(queryText);

  const body: Record<string, unknown> = {
    vector,
    limit: opts.limit ?? 16,
    with_payload: true,
    score_threshold: opts.scoreThreshold ?? 0.20, /* CLIP cosine similarity is bounded: 0.20 ≈ weak match, 0.30+ relevant */
  };
  if (opts.bookSourcePath) {
    body.filter = {
      must: [{ key: "bookSourcePath", match: { value: opts.bookSourcePath } }],
    };
  }

  const url = `${opts.qdrantUrl ?? QDRANT_URL}/collections/${ILLUSTRATIONS_COLLECTION}/points/search`;
  const r = await fetchQdrantJson<{
    result: Array<{ id: string; score: number; payload?: IllustrationVectorPayload }>;
  }>(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    timeoutMs: 10_000,
  });

  return (r.result || []).map((p) => ({
    id: String(p.id),
    score: p.score,
    payload: p.payload as IllustrationVectorPayload,
  }));
}

/**
 * Search illustrations by an IMAGE query (image-to-image similarity).
 * Useful for "find diagrams similar to this one".
 */
export async function searchIllustrationsByImage(
  imagePathOrDataUrl: string,
  opts: { limit?: number; scoreThreshold?: number; qdrantUrl?: string } = {},
): Promise<Array<{ id: string; score: number; payload: IllustrationVectorPayload }>> {
  const vector = await embedImage(imagePathOrDataUrl);
  const url = `${opts.qdrantUrl ?? QDRANT_URL}/collections/${ILLUSTRATIONS_COLLECTION}/points/search`;
  const r = await fetchQdrantJson<{
    result: Array<{ id: string; score: number; payload?: IllustrationVectorPayload }>;
  }>(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      vector,
      limit: opts.limit ?? 16,
      with_payload: true,
      score_threshold: opts.scoreThreshold ?? 0.30,
    }),
    timeoutMs: 10_000,
  });
  return (r.result || []).map((p) => ({
    id: String(p.id),
    score: p.score,
    payload: p.payload as IllustrationVectorPayload,
  }));
}
