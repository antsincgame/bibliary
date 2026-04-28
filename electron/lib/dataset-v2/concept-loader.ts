/**
 * concept-loader — единый источник правды для чтения принятых концептов
 * из Qdrant. Контракт payload зафиксирован здесь, чтобы export, synth и любой
 * будущий потребитель не уходили в дрейф между собой.
 *
 * Поля payload (после Stage 4 пайплайна v2):
 *   essence        — короткая суть концепта (используется как основной "ответ")
 *   cipher         — формула / краткий код знания (опционально)
 *   proof          — обоснование (опционально)
 *   applicability  — где применять (опционально)
 *   chapterContext — для какого тематического узла главы это
 *   domain         — предметная область (всегда есть)
 *   tags           — массив тегов
 *   bookSourcePath — исходник книги
 *   bookTitle      — название (если установлено)
 *
 * Legacy-совместимость: если попадётся старая точка с `principle/explanation`,
 * она тоже распознаётся (essence ← principle, proof ← explanation).
 */

import {
  fetchQdrantJson,
  QDRANT_URL,
  SCROLL_PAGE_SIZE,
} from "../qdrant/http-client.js";

export interface AcceptedConcept {
  id: string;
  domain: string;
  essence: string;
  cipher?: string;
  proof?: string;
  applicability?: string;
  chapterContext?: string;
  tags: string[];
  bookSourcePath?: string;
  bookTitle?: string;
}

interface QdrantPoint {
  id: string | number;
  payload?: Record<string, unknown>;
}

interface QdrantScrollResp {
  result: {
    points: QdrantPoint[];
    next_page_offset?: string | number | null;
  };
}

/**
 * Преобразовать сырую точку Qdrant в AcceptedConcept либо вернуть null,
 * если payload не содержит обязательных полей (essence + domain).
 */
export function parseConceptPoint(point: QdrantPoint): AcceptedConcept | null {
  const p = (point.payload ?? {}) as Record<string, unknown>;
  /* essence — основной ключ; principle — legacy-схема Iter 5/6. */
  const essence = String(p.essence ?? p.principle ?? "").trim();
  const domain = String(p.domain ?? "").trim();
  if (!essence || !domain) return null;

  const tags = Array.isArray(p.tags)
    ? (p.tags as unknown[]).map(String).filter(Boolean)
    : [];

  /* proof — основной; explanation — legacy. */
  const proof = p.proof
    ? String(p.proof)
    : p.explanation
      ? String(p.explanation)
      : undefined;

  const bookTitle = p.bookTitle
    ? String(p.bookTitle)
    : p.book_title
      ? String(p.book_title)
      : undefined;

  return {
    id: String(point.id),
    essence,
    domain,
    cipher: p.cipher ? String(p.cipher) : undefined,
    proof,
    applicability: p.applicability ? String(p.applicability) : undefined,
    chapterContext: p.chapterContext ? String(p.chapterContext) : undefined,
    tags,
    bookSourcePath: p.bookSourcePath ? String(p.bookSourcePath) : undefined,
    bookTitle,
  };
}

export interface IterAcceptedOptions {
  /** Хард-кэп. Default — без лимита. */
  limit?: number;
  /** Размер страницы scroll. Default — SCROLL_PAGE_SIZE. */
  pageSize?: number;
  /** Внешний AbortSignal. */
  signal?: AbortSignal;
}

/**
 * Стримит принятые концепты страницами Qdrant scroll. Не загружает всё в RAM.
 * Сразу пропускает точки с пустыми обязательными полями.
 */
export async function* iterAcceptedConcepts(
  collection: string,
  options: IterAcceptedOptions = {},
): AsyncGenerator<AcceptedConcept> {
  const { limit, pageSize = SCROLL_PAGE_SIZE, signal } = options;

  let offset: string | number | null = null;
  let yielded = 0;

  for (;;) {
    if (signal?.aborted) return;

    const body: Record<string, unknown> = {
      limit: pageSize,
      with_payload: true,
      with_vector: false,
    };
    if (offset !== null) body.offset = offset;

    const resp = await fetchQdrantJson<QdrantScrollResp>(
      `${QDRANT_URL}/collections/${collection}/points/scroll`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        timeoutMs: 60_000,
      },
    );

    for (const point of resp.result.points) {
      if (signal?.aborted) return;
      const concept = parseConceptPoint(point);
      if (!concept) continue;
      yield concept;
      yielded++;
      if (limit && yielded >= limit) return;
    }

    offset = resp.result.next_page_offset ?? null;
    if (!offset) return;
  }
}
