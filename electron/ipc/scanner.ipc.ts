/**
 * Phase 2.6 — Book Scanner IPC.
 *
 * Регистрируется отдельно от `electron/ipc-handlers.ts`, чтобы не разрастать
 * монолитный файл и зафиксировать новый паттерн "один домен → один ipc-модуль".
 *
 * Каналы:
 *   - scanner:probe-folder   → BookFileSummary[]  (опционально открывает диалог)
 *   - scanner:probe-path     → BookFileSummary[]  (по уже выбранному пути)
 *   - scanner:parse-preview  → ParsePreview       (TOC + первые 2 чанка, без embed)
 *   - scanner:start-ingest   → IngestResult       (полный pipeline с прогрессом)
 *   - scanner:cancel-ingest  → boolean            (по ingestId)
 *   - scanner:list-state     → ScannerState       (что обработано раньше)
 *
 * Прогресс летит в renderer через 'scanner:ingest-progress' (push event).
 */

import { ipcMain, dialog, app, type BrowserWindow } from "electron";
import * as path from "path";
import { getPreferencesStore } from "../lib/preferences/store.js";
import { randomUUID } from "crypto";
import {
  probeBooks,
  probeFiles,
  parseBook,
  chunkBook,
  ingestBook,
  ScannerStateStore,
  isSupportedBook,
  isOcrSupported,
  getOcrSupport,
  type BookFileSummary,
  type IngestResult,
  type IngestProgress,
  type ScannerState,
  type ScannerBookState,
  type OcrSupportInfo,
} from "../lib/scanner/index.js";

const QDRANT_URL = process.env.QDRANT_URL || "http://localhost:6333";
const QDRANT_API_KEY = process.env.QDRANT_API_KEY || undefined;

interface ParsePreview {
  metadata: {
    title: string;
    author?: string;
    language?: string;
    warnings: string[];
  };
  sectionCount: number;
  estimatedChunks: number;
  rawCharCount: number;
  sampleChunks: Array<{
    chapterTitle: string;
    chapterIndex: number;
    chunkIndex: number;
    text: string;
    charCount: number;
  }>;
}

const activeIngests = new Map<string, AbortController>();

function stateStore(): ScannerStateStore {
  const dir = path.join(app.getPath("userData"), "scanner");
  return new ScannerStateStore(path.join(dir, "scanner-progress.json"));
}

export function registerScannerIpc(getMainWindow: () => BrowserWindow | null): void {
  ipcMain.handle("scanner:probe-folder", async (): Promise<BookFileSummary[]> => {
    const win = getMainWindow();
    const sel = await dialog.showOpenDialog(win ?? undefined!, {
      title: "Выберите папку с книгами",
      properties: ["openDirectory"],
    });
    if (sel.canceled || sel.filePaths.length === 0) return [];
    return probeBooks(sel.filePaths[0]);
  });

  ipcMain.handle("scanner:probe-path", async (_e, folder: string): Promise<BookFileSummary[]> => {
    if (typeof folder !== "string" || folder.length === 0) return [];
    return probeBooks(folder);
  });

  ipcMain.handle("scanner:probe-files", async (_e, paths: string[]): Promise<BookFileSummary[]> => {
    if (!Array.isArray(paths) || paths.length === 0) return [];
    return probeFiles(paths);
  });

  ipcMain.handle("scanner:open-files", async (): Promise<BookFileSummary[]> => {
    const win = getMainWindow();
    const sel = await dialog.showOpenDialog(win ?? undefined!, {
      title: "Add books",
      properties: ["openFile", "multiSelections"],
      filters: [
        { name: "Books & Images", extensions: ["pdf", "epub", "fb2", "docx", "txt", "png", "jpg", "jpeg", "bmp", "tif", "tiff", "webp"] },
        { name: "Books", extensions: ["pdf", "epub", "fb2", "docx", "txt"] },
        { name: "Images (OCR)", extensions: ["png", "jpg", "jpeg", "bmp", "tif", "tiff", "webp"] },
        { name: "All files", extensions: ["*"] },
      ],
    });
    if (sel.canceled || sel.filePaths.length === 0) return [];
    return probeFiles(sel.filePaths);
  });

  ipcMain.handle("scanner:ocr-support", async (): Promise<OcrSupportInfo> => {
    return getOcrSupport();
  });

  ipcMain.handle("scanner:parse-preview", async (_e, filePath: string): Promise<ParsePreview> => {
    if (typeof filePath !== "string" || !isSupportedBook(filePath)) {
      throw new Error("unsupported file");
    }
    const prefs = await getPreferencesStore().getAll();
    const parsed = await parseBook(filePath, {
      ocrEnabled: prefs.ocrEnabled && isOcrSupported(),
      ocrLanguages: prefs.ocrLanguages,
      ocrAccuracy: prefs.ocrAccuracy,
      ocrPdfDpi: prefs.ocrPdfDpi,
    });
    const chunks = chunkBook(parsed, filePath);
    return {
      metadata: {
        title: parsed.metadata.title,
        author: parsed.metadata.author,
        language: parsed.metadata.language,
        warnings: parsed.metadata.warnings,
      },
      sectionCount: parsed.sections.length,
      estimatedChunks: chunks.length,
      rawCharCount: parsed.rawCharCount,
      sampleChunks: chunks.slice(0, 2).map((c) => ({
        chapterTitle: c.chapterTitle,
        chapterIndex: c.chapterIndex,
        chunkIndex: c.chunkIndex,
        text: c.text.slice(0, 600),
        charCount: c.charCount,
      })),
    };
  });

  ipcMain.handle(
    "scanner:start-ingest",
    async (
      _e,
      args: {
        filePath: string;
        collection: string;
        chunkerOptions?: { targetChars?: number; maxChars?: number; minChars?: number };
        ocrOverride?: boolean;
      }
    ): Promise<{ ingestId: string; result: IngestResult }> => {
      if (!args || typeof args.filePath !== "string" || !isSupportedBook(args.filePath)) {
        throw new Error("invalid filePath");
      }
      if (typeof args.collection !== "string" || args.collection.trim().length === 0) {
        throw new Error("invalid collection");
      }
      const ingestId = randomUUID();
      const ctrl = new AbortController();
      activeIngests.set(ingestId, ctrl);
      const win = getMainWindow();

      try {
        const prefs = await getPreferencesStore().getAll();
        const ocrWanted = typeof args.ocrOverride === "boolean" ? args.ocrOverride : prefs.ocrEnabled;
        const result = await ingestBook(args.filePath, {
          collection: args.collection,
          qdrantUrl: QDRANT_URL,
          qdrantApiKey: QDRANT_API_KEY,
          state: stateStore(),
          signal: ctrl.signal,
          chunkerOptions: args.chunkerOptions,
          upsertBatch: prefs.ingestUpsertBatch,
          maxBookChars: prefs.maxBookChars,
          parseOptions: {
            ocrEnabled: ocrWanted && isOcrSupported(),
            ocrLanguages: prefs.ocrLanguages,
            ocrAccuracy: prefs.ocrAccuracy,
            ocrPdfDpi: prefs.ocrPdfDpi,
            signal: ctrl.signal,
          },
          onProgress: (p: IngestProgress) => {
            if (win && !win.isDestroyed()) {
              win.webContents.send("scanner:ingest-progress", { ingestId, ...p });
            }
          },
        });
        return { ingestId, result };
      } finally {
        activeIngests.delete(ingestId);
      }
    }
  );

  ipcMain.handle("scanner:cancel-ingest", async (_e, ingestId: string): Promise<boolean> => {
    const ctrl = activeIngests.get(ingestId);
    if (!ctrl) return false;
    ctrl.abort("user-cancel");
    activeIngests.delete(ingestId);
    return true;
  });

  ipcMain.handle("scanner:list-state", async (): Promise<ScannerState> => {
    return stateStore().read();
  });

  /**
   * Группированная история ingest по коллекциям.
   * Возвращает уже агрегированный для UI вид: каждая коллекция → свои книги
   * (с total/processed chunk-counts, статусом, last-update).
   */
  ipcMain.handle(
    "scanner:list-history",
    async (): Promise<
      Array<{
        collection: string;
        books: Array<{
          bookSourcePath: string;
          fileName: string;
          status: ScannerBookState["status"];
          totalChunks: number;
          processedChunks: number;
          startedAt: string;
          lastUpdatedAt: string;
          errorMessage?: string;
        }>;
        totalBooks: number;
        totalChunks: number;
      }>
    > => {
      const state = await stateStore().read();
      const byCollection = new Map<string, ScannerBookState[]>();
      for (const book of Object.values(state.books)) {
        const list = byCollection.get(book.collection) ?? [];
        list.push(book);
        byCollection.set(book.collection, list);
      }
      const result: Array<{
        collection: string;
        books: Array<{
          bookSourcePath: string;
          fileName: string;
          status: ScannerBookState["status"];
          totalChunks: number;
          processedChunks: number;
          startedAt: string;
          lastUpdatedAt: string;
          errorMessage?: string;
        }>;
        totalBooks: number;
        totalChunks: number;
      }> = [];
      for (const [collection, books] of byCollection.entries()) {
        const sorted = books.slice().sort((a, b) => b.lastUpdatedAt.localeCompare(a.lastUpdatedAt));
        result.push({
          collection,
          books: sorted.map((b) => ({
            bookSourcePath: b.bookSourcePath,
            fileName: path.basename(b.bookSourcePath),
            status: b.status,
            totalChunks: b.totalChunks,
            processedChunks: b.processedChunkIds.length,
            startedAt: b.startedAt,
            lastUpdatedAt: b.lastUpdatedAt,
            errorMessage: b.errorMessage,
          })),
          totalBooks: sorted.length,
          totalChunks: sorted.reduce((s, b) => s + b.processedChunkIds.length, 0),
        });
      }
      return result.sort((a, b) => b.totalBooks - a.totalBooks);
    }
  );

  /**
   * Удалить все точки книги из Qdrant-коллекции (по filter `bookSourcePath`),
   * и убрать книгу из scanner-state, чтобы при следующем ingest она прошла заново.
   */
  ipcMain.handle(
    "scanner:delete-from-collection",
    async (
      _e,
      args: { bookSourcePath: string; collection: string }
    ): Promise<{ deleted: boolean; pointsDeleted: number }> => {
      if (
        !args ||
        typeof args.bookSourcePath !== "string" ||
        typeof args.collection !== "string" ||
        args.bookSourcePath.length === 0 ||
        args.collection.length === 0
      ) {
        throw new Error("invalid args");
      }
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (QDRANT_API_KEY) headers["api-key"] = QDRANT_API_KEY;
      const resp = await fetch(
        `${QDRANT_URL}/collections/${encodeURIComponent(args.collection)}/points/delete?wait=true`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            filter: {
              must: [{ key: "bookSourcePath", match: { value: args.bookSourcePath } }],
            },
          }),
        }
      );
      const text = await resp.text().catch(() => "");
      if (!resp.ok) {
        throw new Error(`qdrant delete ${resp.status}: ${text.slice(0, 240)}`);
      }
      let pointsDeleted = 0;
      try {
        const parsed = JSON.parse(text) as { result?: { operation_id?: number; status?: string } };
        const status = parsed?.result?.status ?? "unknown";
        if (status !== "completed" && status !== "acknowledged") {
          console.warn("[scanner:delete-from-collection]", `qdrant status=${status}`);
        }
      } catch {
        /* qdrant возвращает ok без числа удалённых; принимаем как success */
      }

      const store = stateStore();
      const cur = await store.read();
      if (cur.books[args.bookSourcePath] && cur.books[args.bookSourcePath].collection === args.collection) {
        const removed = cur.books[args.bookSourcePath];
        pointsDeleted = removed.processedChunkIds.length;
        delete cur.books[args.bookSourcePath];
        await store.write(cur);
      }
      return { deleted: true, pointsDeleted };
    }
  );
}

export function abortAllIngests(reason: string): void {
  for (const [id, ctrl] of activeIngests.entries()) {
    ctrl.abort(reason);
    activeIngests.delete(id);
  }
}
