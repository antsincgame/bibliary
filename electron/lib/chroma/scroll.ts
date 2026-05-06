/**
 * Helper для batched-pagination через Chroma `/collections/{id}/get`.
 *
 * Chroma не имеет cursor-API — только integer offset. Этот helper
 * автоматически итерируется через offsets до пустой страницы. Используется в
 * dataset-v2 domain breakdown (50K-cap) и любых других местах, где нужно
 * пройтись по всем точкам коллекции.
 *
 * Yields каждую страницу отдельно — caller сам решает, что делать с данными
 * (накапливать в массив, агрегировать, стримить наружу).
 */

import { chromaUrl, fetchChromaJson, SCROLL_PAGE_SIZE, CHROMA_TIMEOUT_MS } from "./http-client.js";

export type ChromaInclude = "documents" | "metadatas" | "embeddings" | "distances";

export interface ScrollChromaOptions {
  /** Pre-resolved collection_id (UUID). Передаётся caller'ом — не делаем lookup тут. */
  collectionId: string;
  /** Optional Chroma `where` filter (metadata equality / $or / $and). */
  where?: Record<string, unknown>;
  /** Поля, которые нужны (`metadatas`, `documents`, etc.). По умолчанию `["metadatas"]`. */
  include?: ChromaInclude[];
  /** Размер одной страницы. По умолчанию SCROLL_PAGE_SIZE (256). */
  pageSize?: number;
  /** Hard cap на общее количество точек (защита от runaway-loop). По умолчанию 50_000. */
  maxItems?: number;
  /** Per-call timeout. По умолчанию CHROMA_TIMEOUT_MS. */
  timeoutMs?: number;
  /** AbortSignal для cooperative cancellation. */
  signal?: AbortSignal;
}

export interface ChromaPage {
  ids: string[];
  documents?: (string | null)[];
  metadatas?: (Record<string, unknown> | null)[];
  embeddings?: (number[] | null)[];
}

/**
 * Async generator: один yield на страницу. Завершается когда страница пустая
 * или достигнут maxItems. На abort бросает `Error("aborted")`.
 *
 * Пример:
 * ```ts
 * for await (const page of scrollChroma({ collectionId, where: { domain: "x" } })) {
 *   for (const m of page.metadatas ?? []) { ... }
 * }
 * ```
 */
export async function* scrollChroma(opts: ScrollChromaOptions): AsyncGenerator<ChromaPage, void, void> {
  const include = opts.include ?? ["metadatas"];
  const pageSize = Math.max(1, Math.min(opts.pageSize ?? SCROLL_PAGE_SIZE, 10_000));
  const maxItems = Math.max(1, opts.maxItems ?? 50_000);
  const timeoutMs = opts.timeoutMs ?? CHROMA_TIMEOUT_MS;

  let offset = 0;
  let yielded = 0;

  while (yielded < maxItems) {
    if (opts.signal?.aborted) throw new Error("scrollChroma: aborted");

    const body: Record<string, unknown> = {
      limit: Math.min(pageSize, maxItems - yielded),
      offset,
      include,
    };
    if (opts.where && Object.keys(opts.where).length > 0) body.where = opts.where;

    const page = await fetchChromaJson<ChromaPage>(
      chromaUrl(`/collections/${encodeURIComponent(opts.collectionId)}/get`),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        timeoutMs,
        signal: opts.signal,
      },
    );

    const count = page.ids?.length ?? 0;
    if (count === 0) return;

    /* Hard cap maxItems: если сервер вернул больше чем нужно
     * (mock-сценарий или server без limit-respect) — режем страницу. */
    const remaining = maxItems - yielded;
    if (count > remaining) {
      const trimmed: ChromaPage = {
        ids: page.ids.slice(0, remaining),
        documents: page.documents?.slice(0, remaining),
        metadatas: page.metadatas?.slice(0, remaining),
        embeddings: page.embeddings?.slice(0, remaining),
      };
      yield trimmed;
      return;
    }

    yield page;
    yielded += count;
    offset += count;

    /* Если страница неполная — это последняя страница. */
    if (count < pageSize) return;
  }
}

/**
 * Удобная обёртка: накопить ВСЕ страницы в один массив metadata-объектов.
 * Удобно для domain breakdown'а где итоговый объём <= 50K.
 * Возвращает только metadatas (без ids/documents).
 */
export async function collectAllMetadatas(opts: ScrollChromaOptions): Promise<Array<Record<string, unknown> | null>> {
  const acc: Array<Record<string, unknown> | null> = [];
  for await (const page of scrollChroma({ ...opts, include: ["metadatas"] })) {
    for (const m of page.metadatas ?? []) acc.push(m);
  }
  return acc;
}
