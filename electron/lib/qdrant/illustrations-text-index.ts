/**
 * Qdrant illustrations TEXT-index — sidecar поиск по картинкам через
 * текстовые описания, сгенерированные vision-LLM.
 *
 * Зачем:
 *   - CLIP даёт настоящий image search, но требует +200 MB ONNX модели.
 *   - Vision-LLM уже генерирует ОПИСАНИЕ для каждой иллюстрации (Step C).
 *   - Это описание уже впрыскивается в book.md, но НЕ имеет отдельного
 *     индекса — поиск «найди иллюстрации про cache hierarchy» работает
 *     только если текст главы содержит эти слова.
 *
 * Решение (план: «E5 over descriptions, sidecar в Qdrant»):
 *   - Отдельная коллекция `bibliary_illustrations_text`.
 *   - Vector = E5(description) — то же пространство что и текстовые чанки книг,
 *     те же 384 dims, та же модель, БЕЗ дополнительной памяти.
 *   - Payload: { bookSourcePath, bookTitle, sha256, description, score,
 *     chapterTitle, caption, illustrationId }.
 *   - Поиск:
 *       text query → embedQuery (E5 query: префикс) → top-K описаний
 *
 * Соотношение с CLIP-индексом:
 *   - CLIP-индекс (illustrations-index.ts, vector=image) — за feature flag,
 *     для случаев когда текст описания не помогает (визуальное сходство).
 *   - Этот текстовый индекс — ДЕФОЛТ. Включён без feature flag, потому что
 *     E5-модель уже загружена для основной коллекции книг.
 *
 * Idempotency:
 *   - Точки имеют детерминированный id = illustrationPointId(sha256, bookPath).
 *   - Тот же id что и в CLIP-индексе — две коллекции зеркально дополняют
 *     друг друга и могут быть JOIN'нуты по id при гибридном поиске.
 */

import { fetchQdrantJson, QDRANT_URL } from "./http-client.js";
import { embedPassage, embedQuery } from "../embedder/shared.js";
import { illustrationPointId } from "./illustrations-index.js";

/** E5-small dim. Должно совпадать с DEFAULT_EMBED_MODEL в scanner/embedding.ts. */
export const TEXT_EMBED_DIMS = 384;

export const ILLUSTRATIONS_TEXT_COLLECTION =
  process.env.BIBLIARY_ILLUSTRATIONS_TEXT_COLLECTION || "bibliary_illustrations_text";

export interface IllustrationTextPayload {
  /** Absolute path of the source book directory. */
  bookSourcePath: string;
  /** Human-readable title (best-effort, can be empty). */
  bookTitle: string;
  /** Content-addressable storage hash. */
  sha256: string;
  /** Vision-LLM informational score 0-10. */
  score: number;
  /** Vision-LLM description (also the embedded text). */
  description: string;
  /** Optional caption from source markdown / EPUB OPF / FB2. */
  caption?: string;
  /** Optional chapter title for filtering. */
  chapterTitle?: string;
  /** Illustration record id ("img-001", "img-cover", ...). */
  illustrationId: string;
  /** ISO timestamp. */
  indexedAt: string;
}

export async function ensureIllustrationsTextCollection(
  qdrantUrl: string = QDRANT_URL,
): Promise<void> {
  try {
    await fetchQdrantJson<{ result: unknown }>(
      `${qdrantUrl}/collections/${ILLUSTRATIONS_TEXT_COLLECTION}`,
      { method: "GET", timeoutMs: 5_000 },
    );
    return;
  } catch {
    /* fall through to create */
  }

  await fetchQdrantJson<{ result: unknown }>(
    `${qdrantUrl}/collections/${ILLUSTRATIONS_TEXT_COLLECTION}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        vectors: { size: TEXT_EMBED_DIMS, distance: "Cosine" },
        optimizers_config: { default_segment_number: 2 },
      }),
      timeoutMs: 15_000,
    },
  );
}

/**
 * Index one illustration description into the text-vector collection.
 * Uses E5 passage embedding (same model as main book chunks).
 *
 * Failure semantics: throws on Qdrant error. illustration-worker должен
 * ловить и логировать как non-fatal (картинка остаётся в bookmd с описанием).
 */
export async function indexIllustrationDescription(
  payload: Omit<IllustrationTextPayload, "indexedAt">,
  qdrantUrl: string = QDRANT_URL,
): Promise<{ id: string }> {
  const trimmed = payload.description.trim();
  if (trimmed.length < 5) {
    throw new Error(
      `[illustrations-text-index] description too short (${trimmed.length} chars) for ${payload.illustrationId}`,
    );
  }

  const vector = await embedPassage(trimmed);
  if (vector.length !== TEXT_EMBED_DIMS) {
    throw new Error(
      `[illustrations-text-index] embedPassage returned ${vector.length} dims, expected ${TEXT_EMBED_DIMS}`,
    );
  }

  const id = illustrationPointId(payload.sha256, payload.bookSourcePath);
  const fullPayload: IllustrationTextPayload = {
    ...payload,
    description: trimmed,
    indexedAt: new Date().toISOString(),
  };

  await fetchQdrantJson(
    `${qdrantUrl}/collections/${ILLUSTRATIONS_TEXT_COLLECTION}/points?wait=true`,
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

export interface IllustrationTextHit {
  id: string;
  score: number;
  payload: IllustrationTextPayload;
}

/**
 * Search illustrations by free-form text query.
 *
 * Uses E5 query embedding (with "query: " prefix). Returns top-K matches
 * sorted by cosine similarity descending.
 */
export async function searchIllustrationsByText(
  query: string,
  options: {
    limit?: number;
    qdrantUrl?: string;
    bookFilter?: string;        /* exact bookSourcePath match */
    minScore?: number;          /* qdrant similarity threshold 0..1 */
  } = {},
): Promise<IllustrationTextHit[]> {
  const limit = options.limit ?? 12;
  const qdrantUrl = options.qdrantUrl ?? QDRANT_URL;

  const vector = await embedQuery(query);

  const body: Record<string, unknown> = {
    vector,
    limit,
    with_payload: true,
  };
  if (typeof options.minScore === "number") {
    body.score_threshold = options.minScore;
  }
  if (options.bookFilter) {
    body.filter = {
      must: [{ key: "bookSourcePath", match: { value: options.bookFilter } }],
    };
  }

  const resp = await fetchQdrantJson<{
    result: Array<{ id: string; score: number; payload: IllustrationTextPayload }>;
  }>(`${qdrantUrl}/collections/${ILLUSTRATIONS_TEXT_COLLECTION}/points/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    timeoutMs: 15_000,
  });

  return (resp.result ?? []).map((h) => ({
    id: String(h.id),
    score: h.score,
    payload: h.payload,
  }));
}
