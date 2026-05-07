import { ipcMain } from "electron";
import {
  fetchChromaJson,
  chromaUrl,
  CHROMA_URL,
} from "../lib/chroma/http-client.js";
import { ensureChromaCollection } from "../lib/chroma/collection-config.js";
import { resolveCollectionId, invalidate as invalidateCache, setMapping } from "../lib/chroma/collection-cache.js";
import { CollectionNameSchema, parseOrThrow } from "./validators.js";

interface CollectionInfo {
  name: string;
  pointsCount: number;
  status: string;
  metadata?: Record<string, unknown> | null;
}

interface CollectionsListItem {
  name: string;
  pointsCount: number;
  status: string;
}

interface ChromaCollectionResponse {
  id: string;
  name: string;
  metadata?: Record<string, unknown> | null;
}

/**
 * IPC слой для Chroma vector store.
 *
 * Каналы:
 *   chroma:collections           — list collection names (string[])
 *   chroma:collections-detailed  — list with point counts (CollectionsListItem[])
 *   chroma:collection-info       — single collection details (CollectionInfo | null)
 *   chroma:create-collection     — idempotent create через ensureChromaCollection
 *   chroma:delete-collection     — DELETE + invalidate name→id cache
 *   chroma:heartbeat             — простой ping для status badge
 *
 * `chroma:cluster-info` НЕ ДОБАВЛЕН (был qdrant:cluster-info) — Chroma это
 * single-node key-value хранилище, peer/raft/replica state нет смысла показывать.
 * heartbeat достаточен для UI online-индикатора.
 */
export function registerChromaIpc(): void {
  ipcMain.handle("chroma:collections", async (): Promise<string[]> => {
    try {
      const data = await fetchChromaJson<ChromaCollectionResponse[]>(chromaUrl("/collections"));
      const names: string[] = [];
      for (const c of data ?? []) {
        if (c?.id && c?.name) {
          setMapping(c.name, c.id);
          names.push(c.name);
        }
      }
      return names.sort((a, b) => a.localeCompare(b));
    } catch (e) {
      console.error("[chroma:collections]", e instanceof Error ? e.message : e);
      return [];
    }
  });

  ipcMain.handle("chroma:collections-detailed", async (): Promise<CollectionsListItem[]> => {
    try {
      const data = await fetchChromaJson<ChromaCollectionResponse[]>(chromaUrl("/collections"));
      const items: CollectionsListItem[] = [];
      /* Fan-out per-collection /count в parallel — Chroma не отдаёт счётчик
         в общем list endpoint'е (в отличие от Chroma). */
      await Promise.all(
        (data ?? []).map(async (c) => {
          if (!c?.id || !c?.name) return;
          setMapping(c.name, c.id);
          let pointsCount = 0;
          let status = "ok";
          try {
            const n = await fetchChromaJson<number>(
              chromaUrl(`/collections/${encodeURIComponent(c.id)}/count`),
              { timeoutMs: 5_000 },
            );
            pointsCount = typeof n === "number" ? n : 0;
          } catch {
            status = "error";
          }
          items.push({ name: c.name, pointsCount, status });
        }),
      );
      return items.sort((a, b) => a.name.localeCompare(b.name));
    } catch (e) {
      console.error("[chroma:collections-detailed]", e instanceof Error ? e.message : e);
      return [];
    }
  });

  ipcMain.handle("chroma:collection-info", async (_e, name: string): Promise<CollectionInfo | null> => {
    if (typeof name !== "string" || !name) return null;
    try {
      const info = await fetchChromaJson<ChromaCollectionResponse>(
        chromaUrl(`/collections/${encodeURIComponent(name)}`),
      );
      if (!info?.id) return null;
      setMapping(info.name, info.id);
      let pointsCount = 0;
      try {
        const n = await fetchChromaJson<number>(chromaUrl(`/collections/${encodeURIComponent(info.id)}/count`));
        pointsCount = typeof n === "number" ? n : 0;
      } catch { /* count failed — return 0 */ }
      return {
        name: info.name,
        pointsCount,
        status: "ok",
        metadata: info.metadata ?? null,
      };
    } catch (e) {
      console.error("[chroma:collection-info]", e instanceof Error ? e.message : e);
      return null;
    }
  });

  ipcMain.handle(
    "chroma:create-collection",
    async (
      _e,
      args: {
        name: string;
        /** Distance metric. Chroma values: cosine | l2 | ip. Default cosine. */
        distance?: "cosine" | "l2" | "ip";
      },
    ): Promise<{ ok: boolean; error?: string; hnswMismatch?: string[] }> => {
      try {
        if (!args) return { ok: false, error: "args required" };
        args = { ...args, name: parseOrThrow(CollectionNameSchema, args.name, "name") };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
      try {
        const result = await ensureChromaCollection({
          name: args.name,
          distance: args.distance ?? "cosine",
          hnsw: { m: 24, construction_ef: 128 },
        });
        return { ok: true, hnswMismatch: result.hnswMismatch.length > 0 ? result.hnswMismatch : undefined };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  );

  ipcMain.handle(
    "chroma:delete-collection",
    async (_e, name: string): Promise<{ ok: boolean; error?: string }> => {
      try {
        name = parseOrThrow(CollectionNameSchema, name, "name");
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
      try {
        await fetchChromaJson(chromaUrl(`/collections/${encodeURIComponent(name)}`), {
          method: "DELETE",
        });
        invalidateCache(name);
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  );

  ipcMain.handle(
    "chroma:heartbeat",
    async (): Promise<{ url: string; online: boolean; version?: string; collectionsCount: number }> => {
      try {
        await fetchChromaJson(chromaUrl("/heartbeat"), { timeoutMs: 3_000 });
        let version: string | undefined;
        let collectionsCount = 0;
        try {
          const v = await fetchChromaJson<unknown>(chromaUrl("/version"), { timeoutMs: 3_000 });
          if (typeof v === "string") version = v;
          else if (v && typeof v === "object" && typeof (v as { version?: string }).version === "string") {
            version = (v as { version: string }).version;
          }
        } catch { /* version optional */ }
        try {
          const list = await fetchChromaJson<ChromaCollectionResponse[]>(chromaUrl("/collections"), { timeoutMs: 3_000 });
          collectionsCount = (list ?? []).length;
        } catch { /* collections list optional */ }
        return { url: CHROMA_URL, online: true, version, collectionsCount };
      } catch {
        return { url: CHROMA_URL, online: false, collectionsCount: 0 };
      }
    },
  );

  /**
   * `chroma:start-embedded` — manual trigger из Welcome Wizard UI.
   * Полезен когда auto-spawn выключен (chromaAutoSpawn=false) или не сработал
   * (uvx/python отсутствовали в момент boot, но пользователь установил их
   * после). Идемпотентно: если Chroma уже запущена — return уже-OK статус.
   */
  ipcMain.handle("chroma:start-embedded", async (): Promise<{ ok: boolean; reason?: string; alreadyRunning?: boolean }> => {
    try {
      const { startEmbeddedChroma, defaultChromaDataPath } = await import("../lib/chroma/auto-spawn.js");
      const { app } = await import("electron");
      const dataDir = process.env.BIBLIARY_DATA_DIR ?? app.getPath("userData");
      const result = await startEmbeddedChroma({
        dataPath: defaultChromaDataPath(dataDir),
        port: 8000,
      });
      if (!result) {
        /* Уже запущена (heartbeat OK) — для UI это успех. */
        return { ok: true, alreadyRunning: true };
      }
      await result.ready;
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, reason: msg };
    }
  });

  /* Helper, used internally by other IPC handlers — exposed via export of name→id cache. */
  void resolveCollectionId; /* silence unused-import if not used directly here */
}
