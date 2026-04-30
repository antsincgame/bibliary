import { ipcMain } from "electron";
import {
  fetchQdrantJson,
  QDRANT_URL,
  QDRANT_API_KEY,
} from "../lib/qdrant/http-client.js";
import { EMBEDDING_DIM } from "../lib/scanner/embedding.js";
import { getPreferencesStore } from "../lib/preferences/store.js";
import { CollectionNameSchema, parseOrThrow } from "./validators.js";

interface CollectionInfo {
  name: string;
  pointsCount: number;
  vectorsCount: number;
  segmentsCount: number;
  status: string;
  vectorSize?: number;
  distance?: string;
  diskDataSize?: number;
  ramDataSize?: number;
}

interface CollectionsListItem {
  name: string;
  pointsCount: number;
  vectorSize?: number;
  status: string;
}

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  const h: Record<string, string> = { ...(extra ?? {}) };
  if (QDRANT_API_KEY) h["api-key"] = QDRANT_API_KEY;
  return h;
}

/**
 * Raw `Response`-returning Qdrant call (used when the IPC handler needs
 * to inspect the status code or body itself; `fetchQdrantJson` always
 * throws on !ok).
 *
 * Honours `prefs.qdrantTimeoutMs` so it can't hang the IPC channel
 * forever when Qdrant is slow. Fallback default 8000 ms.
 */
async function qdrantRaw(url: string, init?: RequestInit, timeoutMs?: number): Promise<Response> {
  const ms = typeof timeoutMs === "number" && timeoutMs > 0 ? timeoutMs : 8000;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(`qdrant timeout ${ms}ms`), ms);
  try {
    return await fetch(url, {
      ...(init ?? {}),
      headers: authHeaders(init?.headers as Record<string, string> | undefined),
      signal: ctl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

export function registerQdrantIpc(): void {
  ipcMain.handle("qdrant:collections", async (): Promise<string[]> => {
    try {
      const data = await fetchQdrantJson<{ result: { collections: Array<{ name: string }> } }>(
        `${QDRANT_URL}/collections`
      );
      return data.result.collections.map((c) => c.name);
    } catch (e) {
      console.error("[qdrant:collections]", e instanceof Error ? e.message : e);
      return [];
    }
  });

  /* ──────────────── Management: list / info / create / delete ──────────────── */

  ipcMain.handle("qdrant:collections-detailed", async (): Promise<CollectionsListItem[]> => {
    try {
      const data = await fetchQdrantJson<{ result: { collections: Array<{ name: string }> } }>(
        `${QDRANT_URL}/collections`
      );
      const items: CollectionsListItem[] = [];
      for (const c of data.result.collections) {
        try {
          const info = await fetchQdrantJson<{
            result: {
              points_count?: number;
              status?: string;
              config?: { params?: { vectors?: { size?: number } } };
            };
          }>(`${QDRANT_URL}/collections/${encodeURIComponent(c.name)}`);
          items.push({
            name: c.name,
            pointsCount: info.result.points_count ?? 0,
            vectorSize: info.result.config?.params?.vectors?.size,
            status: info.result.status ?? "unknown",
          });
        } catch {
          items.push({ name: c.name, pointsCount: 0, status: "error" });
        }
      }
      return items.sort((a, b) => a.name.localeCompare(b.name));
    } catch (e) {
      console.error("[qdrant:collections-detailed]", e instanceof Error ? e.message : e);
      return [];
    }
  });

  ipcMain.handle("qdrant:collection-info", async (_e, name: string): Promise<CollectionInfo | null> => {
    if (typeof name !== "string" || !name) return null;
    try {
      const data = await fetchQdrantJson<{
        result: {
          points_count?: number;
          vectors_count?: number;
          segments_count?: number;
          status?: string;
          config?: {
            params?: { vectors?: { size?: number; distance?: string } };
          };
          payload_schema?: Record<string, unknown>;
          disk_data_size?: number;
          ram_data_size?: number;
        };
      }>(`${QDRANT_URL}/collections/${encodeURIComponent(name)}`);
      return {
        name,
        pointsCount: data.result.points_count ?? 0,
        vectorsCount: data.result.vectors_count ?? 0,
        segmentsCount: data.result.segments_count ?? 0,
        status: data.result.status ?? "unknown",
        vectorSize: data.result.config?.params?.vectors?.size,
        distance: data.result.config?.params?.vectors?.distance,
        diskDataSize: data.result.disk_data_size,
        ramDataSize: data.result.ram_data_size,
      };
    } catch (e) {
      console.error("[qdrant:collection-info]", e instanceof Error ? e.message : e);
      return null;
    }
  });

  ipcMain.handle(
    "qdrant:create-collection",
    async (
      _e,
      args: {
        name: string;
        vectorSize?: number;
        distance?: "Cosine" | "Euclid" | "Dot";
        /**
         * Если true — коллекция создаётся как hybrid (named dense + sparse BM25 с
         * server-side IDF). Это включает `searchHybridChunks` через `searchSmart`:
         * BM25 ловит редкие токены (ISBN, имена, версии) — точные совпадения, которые
         * dense embedder часто промахивает. RRF fusion и затем BGE-reranker.
         *
         * Без этого флага создаётся unnamed dense — обратно совместимо с legacy.
         */
        hybrid?: boolean;
      }
    ): Promise<{ ok: boolean; error?: string; hybrid?: boolean }> => {
      try {
        if (!args) return { ok: false, error: "args required" };
        args = { ...args, name: parseOrThrow(CollectionNameSchema, args.name, "name") };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
      const size = args.vectorSize ?? EMBEDDING_DIM;
      const distance = args.distance ?? "Cosine";
      const hybrid = args.hybrid === true;
      try {
        if (hybrid) {
          /* Через ensureQdrantCollection — включаем sparse + HNSW best-practice
             конфиги + payload indexes (bookSourcePath, language). */
          const { ensureQdrantCollection } = await import("../lib/qdrant/collection-config.js");
          const res = await ensureQdrantCollection({
            name: args.name,
            vectorSize: size,
            distance,
            sparseVectors: true,
            hnsw: { m: 24, ef_construct: 128 },
            payloadIndexes: [
              { field: "bookSourcePath", type: "keyword" },
              { field: "domain", type: "keyword" },
              { field: "language", type: "keyword" },
            ],
          });
          return { ok: true, hybrid: res.created };
        }
        const resp = await qdrantRaw(`${QDRANT_URL}/collections/${encodeURIComponent(args.name)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ vectors: { size, distance } }),
        });
        if (!resp.ok) {
          const txt = await resp.text().catch(() => "");
          return { ok: false, error: `HTTP ${resp.status}: ${txt.slice(0, 240)}` };
        }
        return { ok: true, hybrid: false };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    }
  );

  ipcMain.handle(
    "qdrant:delete-collection",
    async (_e, name: string): Promise<{ ok: boolean; error?: string }> => {
      try {
        name = parseOrThrow(CollectionNameSchema, name, "name");
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
      try {
        const resp = await qdrantRaw(`${QDRANT_URL}/collections/${encodeURIComponent(name)}`, {
          method: "DELETE",
        });
        if (!resp.ok) {
          const txt = await resp.text().catch(() => "");
          return { ok: false, error: `HTTP ${resp.status}: ${txt.slice(0, 240)}` };
        }
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    }
  );

  ipcMain.handle(
    "qdrant:search",
    async (
      _e,
      args: {
        collection: string;
        vector?: number[];
        query?: string;
        limit?: number;
        scoreThreshold?: number;
      }
    ): Promise<Array<{ id: string; score: number; payload: Record<string, unknown> }>> => {
      if (!args || !args.collection) return [];
      try {
        let vector = args.vector;
        if (!vector && args.query) {
          const { embedQuery } = await import("../lib/rag/index.js");
          vector = await embedQuery(args.query);
        }
        if (!vector) return [];
        const prefs = await getPreferencesStore().getAll();
        /* score_threshold: clamp to [0, 1]. Without it поиск «размывается» при
           росте коллекции — даже плохие совпадения проходят. */
        const rawThreshold = args.scoreThreshold ?? prefs.ragScoreThreshold;
        const scoreThreshold = Math.max(0, Math.min(1, rawThreshold));
        const data = await fetchQdrantJson<{
          result: Array<{ id: string | number; score: number; payload: Record<string, unknown> }>;
        }>(`${QDRANT_URL}/collections/${encodeURIComponent(args.collection)}/points/search`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            vector,
            limit: args.limit ?? prefs.qdrantSearchLimit,
            with_payload: true,
            score_threshold: scoreThreshold,
          }),
          timeoutMs: prefs.qdrantTimeoutMs,
        });
        return data.result.map((r) => ({
          id: String(r.id),
          score: r.score,
          payload: r.payload,
        }));
      } catch (e) {
        console.error("[qdrant:search]", e instanceof Error ? e.message : e);
        return [];
      }
    }
  );

  /**
   * Smart search: автоматически выбирает hybrid (dense+sparse+RRF+rerank) если
   * коллекция создана с sparseVectors, иначе dense+rerank через
   * searchRelevantChunks. См. `electron/lib/rag/hybrid-search.ts:searchSmart`.
   *
   * Возвращает поле `rerankScore` для UI (показывает что reranker применён).
   * Используется из dataset-v2 UI (раздел Hybrid Search).
   */
  ipcMain.handle(
    "qdrant:search-smart",
    async (
      _e,
      args: {
        collection: string;
        query: string;
        limit?: number;
      },
    ): Promise<Array<{ id: string; score: number; payload: Record<string, unknown>; rerankScore?: number }>> => {
      if (!args || !args.collection || !args.query) return [];
      try {
        const collectionName = parseOrThrow(CollectionNameSchema, args.collection, "collection");
        const prefs = await getPreferencesStore().getAll();
        const limit = Math.max(1, Math.min(50, args.limit ?? prefs.qdrantSearchLimit));
        const { searchSmart } = await import("../lib/rag/hybrid-search.js");
        const results = await searchSmart(collectionName, args.query, limit, prefs.qdrantTimeoutMs);
        return results.map((r) => ({
          id: r.id,
          score: r.score,
          payload: r.payload,
          ...(typeof r.rerankScore === "number" ? { rerankScore: r.rerankScore } : {}),
        }));
      } catch (e) {
        console.error("[qdrant:search-smart]", e instanceof Error ? e.message : e);
        return [];
      }
    },
  );

  ipcMain.handle(
    "qdrant:cluster-info",
    async (): Promise<{ url: string; online: boolean; version?: string; collectionsCount: number }> => {
      try {
        const resp = await qdrantRaw(`${QDRANT_URL}/`);
        if (!resp.ok) return { url: QDRANT_URL, online: false, collectionsCount: 0 };
        const root = (await resp.json().catch(() => ({}))) as { version?: string };
        const data = await fetchQdrantJson<{ result: { collections: Array<{ name: string }> } }>(
          `${QDRANT_URL}/collections`
        );
        return {
          url: QDRANT_URL,
          online: true,
          version: root.version,
          collectionsCount: data.result.collections.length,
        };
      } catch {
        return { url: QDRANT_URL, online: false, collectionsCount: 0 };
      }
    }
  );
}
