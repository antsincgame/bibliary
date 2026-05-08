import { ipcMain } from "electron";

import {
  ensureCollection,
  listCollections,
  getCollectionInfo,
  deleteCollection,
  vectorCount,
  collectionExists,
} from "../lib/vectordb/index.js";
import { CollectionNameSchema, parseOrThrow } from "./validators.js";

interface CollectionInfoUI {
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

/**
 * IPC слой для in-process LanceDB vector store.
 *
 * Каналы:
 *   vectordb:collections           — список имён коллекций (string[])
 *   vectordb:collections-detailed  — список с countRows (CollectionsListItem[])
 *   vectordb:collection-info       — детали одной коллекции
 *   vectordb:create-collection     — идемпотентный ensureCollection
 *   vectordb:delete-collection     — drop table + idempotent
 *   vectordb:heartbeat             — vectordb всегда online (collections count)
 */
export function registerVectorDbIpc(): void {
  ipcMain.handle("vectordb:collections", async (): Promise<string[]> => {
    try {
      const names = await listCollections();
      return [...names].sort((a, b) => a.localeCompare(b));
    } catch (e) {
      console.error("[vectordb:collections]", e instanceof Error ? e.message : e);
      return [];
    }
  });

  ipcMain.handle("vectordb:collections-detailed", async (): Promise<CollectionsListItem[]> => {
    try {
      const names = await listCollections();
      const items: CollectionsListItem[] = [];
      /* fan-out per-collection countRows. In-process — миллисекунды на коллекцию. */
      await Promise.all(
        names.map(async (name) => {
          let pointsCount = 0;
          let status = "ok";
          try {
            pointsCount = await vectorCount(name);
          } catch {
            status = "error";
          }
          items.push({ name, pointsCount, status });
        }),
      );
      return items.sort((a, b) => a.name.localeCompare(b.name));
    } catch (e) {
      console.error("[vectordb:collections-detailed]", e instanceof Error ? e.message : e);
      return [];
    }
  });

  ipcMain.handle("vectordb:collection-info", async (_e, name: string): Promise<CollectionInfoUI | null> => {
    if (typeof name !== "string" || !name) return null;
    try {
      const info = await getCollectionInfo(name);
      if (!info) return null;
      return {
        name: info.name,
        pointsCount: info.rowCount,
        status: "ok",
        metadata: info.hasVectorIndex ? { hasVectorIndex: true } : null,
      };
    } catch (e) {
      console.error("[vectordb:collection-info]", e instanceof Error ? e.message : e);
      return null;
    }
  });

  ipcMain.handle(
    "vectordb:create-collection",
    async (
      _e,
      args: {
        name: string;
        /** Distance metric. Default cosine. "ip" принимается для back-compat
         * со старыми UI dropdown'ами и маппится в "dot". */
        distance?: "cosine" | "l2" | "ip";
      },
    ): Promise<{ ok: boolean; error?: string }> => {
      try {
        if (!args) return { ok: false, error: "args required" };
        args = { ...args, name: parseOrThrow(CollectionNameSchema, args.name, "name") };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
      try {
        await ensureCollection({
          name: args.name,
          distance: args.distance === "ip" ? "dot" : (args.distance ?? "cosine"),
          hnsw: { m: 24, constructionEf: 128 },
        });
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  );

  ipcMain.handle(
    "vectordb:delete-collection",
    async (_e, name: string): Promise<{ ok: boolean; error?: string }> => {
      try {
        name = parseOrThrow(CollectionNameSchema, name, "name");
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
      try {
        await deleteCollection(name);
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  );

  ipcMain.handle(
    "vectordb:heartbeat",
    async (): Promise<{ url: string; online: boolean; version?: string; collectionsCount: number }> => {
      /* In-process LanceDB всегда online — connection открыт в boot.
       * `url` всегда пустой: embedded vector store не имеет network endpoint'а. */
      try {
        const names = await listCollections();
        return { url: "", online: true, version: "lancedb-embedded", collectionsCount: names.length };
      } catch (e) {
        console.error("[vectordb:heartbeat]", e instanceof Error ? e.message : e);
        return { url: "", online: false, collectionsCount: 0 };
      }
    },
  );

  /* silence unused import, used only for type-checker assurance */
  void collectionExists;
}
