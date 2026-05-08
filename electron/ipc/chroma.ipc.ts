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
 * **Channel names сохранены как `chroma:*`** на этой фазе миграции —
 * renderer (Settings UI / Welcome Wizard / Collection picker) меняется
 * в Phase 4 одним консолидированным PR'ом. Внутренности при этом уже
 * работают через `vectordb/*` (in-process LanceDB) без HTTP / child-process.
 *
 * Каналы:
 *   chroma:collections           — список имён коллекций (string[])
 *   chroma:collections-detailed  — список с countRows (CollectionsListItem[])
 *   chroma:collection-info       — детали одной коллекции
 *   chroma:create-collection     — идемпотентный ensureCollection
 *   chroma:delete-collection     — drop table + idempotent
 *   chroma:heartbeat             — vectordb всегда online (collections count)
 *   chroma:start-embedded        — back-compat no-op (LanceDB всегда в-процессе)
 *
 * `chroma:cluster-info` НЕ ДОБАВЛЕН — single-node embedded store.
 */
export function registerChromaIpc(): void {
  ipcMain.handle("chroma:collections", async (): Promise<string[]> => {
    try {
      const names = await listCollections();
      return [...names].sort((a, b) => a.localeCompare(b));
    } catch (e) {
      console.error("[chroma:collections]", e instanceof Error ? e.message : e);
      return [];
    }
  });

  ipcMain.handle("chroma:collections-detailed", async (): Promise<CollectionsListItem[]> => {
    try {
      const names = await listCollections();
      const items: CollectionsListItem[] = [];
      /* fan-out per-collection countRows. Дешевле чем chroma-эра HTTP fan-out
       * потому что in-process — миллисекунды на коллекцию. */
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
      console.error("[chroma:collections-detailed]", e instanceof Error ? e.message : e);
      return [];
    }
  });

  ipcMain.handle("chroma:collection-info", async (_e, name: string): Promise<CollectionInfoUI | null> => {
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
        /** Distance metric. Default cosine. l2/ip оставлены для back-compat
         * с UI dropdown'ом, в LanceDB маппится в "cosine"/"l2"/"dot". */
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
        await ensureCollection({
          name: args.name,
          distance: args.distance === "ip" ? "dot" : (args.distance ?? "cosine"),
          hnsw: { m: 24, constructionEf: 128 },
        });
        /* hnswMismatch концепт из chroma больше не релевантен — schema/index
         * параметры применяются строго при первом ensureCollection, дальше
         * не сравниваются. Возвращаем undefined для UI back-compat. */
        return { ok: true };
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
        await deleteCollection(name);
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  );

  ipcMain.handle(
    "chroma:heartbeat",
    async (): Promise<{ url: string; online: boolean; version?: string; collectionsCount: number }> => {
      /* In-process LanceDB всегда online — connection открыт в boot. Поле
       * `url` пустое (back-compat для renderer'а который рендерил его как
       * tooltip; в Phase 4 переименуется и tooltip уйдёт). */
      try {
        const names = await listCollections();
        return { url: "", online: true, version: "lancedb-embedded", collectionsCount: names.length };
      } catch (e) {
        console.error("[chroma:heartbeat]", e instanceof Error ? e.message : e);
        return { url: "", online: false, collectionsCount: 0 };
      }
    },
  );

  /**
   * `chroma:start-embedded` — back-compat no-op. В chroma-эре трayлся
   * `uvx chromadb run` как child-process. С LanceDB embedded такой шаг
   * не нужен — connection открывается на boot. Возвращаем `alreadyRunning:true`
   * чтобы Welcome Wizard UI отрендерил [OK] статус без cosmetic ошибки.
   */
  ipcMain.handle("chroma:start-embedded", async (): Promise<{ ok: boolean; reason?: string; alreadyRunning?: boolean }> => {
    return { ok: true, alreadyRunning: true };
  });

  /* silence unused import, used only for type-checker assurance */
  void collectionExists;
}
