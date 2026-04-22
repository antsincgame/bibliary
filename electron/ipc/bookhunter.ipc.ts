/**
 * Phase 3.0 — BookHunter IPC.
 *
 * search → return aggregated candidates
 * download → streaming с прогрессом, возвращает destPath
 * download+ingest → handoff в scanner.ipc через ingestBook
 */

import { ipcMain, app, type BrowserWindow } from "electron";
import * as path from "path";
import * as crypto from "crypto";
import { aggregateSearch, downloadBook, ALLOWED_LICENSES, type BookCandidate, type BookFileVariant } from "../lib/bookhunter/index.js";
import { ingestBook, ScannerStateStore, isOcrSupported } from "../lib/scanner/index.js";
import { QDRANT_URL, QDRANT_API_KEY } from "../lib/qdrant/http-client.js";
import { getPreferencesStore } from "../lib/preferences/store.js";

const activeDownloads = new Map<string, AbortController>();

export function abortAllBookhunter(reason: string): void {
  for (const [id, ctrl] of activeDownloads.entries()) {
    ctrl.abort(reason);
    activeDownloads.delete(id);
  }
}

function safeFileName(s: string): string {
  return s.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").slice(0, 80);
}

function downloadId(): string {
  return crypto.randomUUID();
}

function defaultDownloadDir(sourceTag: BookCandidate["sourceTag"]): string {
  return path.join(app.getPath("userData"), "bookhunter", sourceTag);
}

function pickFormat(c: BookCandidate, preferred?: BookFileVariant["format"]): BookFileVariant {
  if (preferred) {
    const exact = c.formats.find((f) => f.format === preferred);
    if (exact) return exact;
  }
  /* Приоритет: epub → txt → fb2 → pdf → docx (легче парсятся, меньше OCR-проблем) */
  const order: BookFileVariant["format"][] = ["epub", "txt", "fb2", "pdf", "docx"];
  for (const fmt of order) {
    const f = c.formats.find((x) => x.format === fmt);
    if (f) return f;
  }
  if (c.formats.length === 0) throw new Error("no formats available");
  return c.formats[0];
}

export function registerBookhunterIpc(getMainWindow: () => BrowserWindow | null): void {
  ipcMain.handle(
    "bookhunter:search",
    async (
      _e,
      args: { query: string; sources?: BookCandidate["sourceTag"][]; language?: string; perSourceLimit?: number }
    ): Promise<BookCandidate[]> => {
      if (!args || typeof args.query !== "string" || args.query.trim().length === 0) return [];
      try {
        const prefs = await getPreferencesStore().getAll();
        return await aggregateSearch({
          query: args.query.trim(),
          sources: args.sources,
          language: args.language,
          perSourceLimit: args.perSourceLimit ?? prefs.searchPerSourceLimit,
        });
      } catch (e) {
        console.error("[bookhunter:search]", e instanceof Error ? e.message : e);
        return [];
      }
    }
  );

  ipcMain.handle("bookhunter:cancel-download", async (_e, id: string): Promise<boolean> => {
    const ctrl = activeDownloads.get(id);
    if (!ctrl) return false;
    ctrl.abort("user-cancel");
    activeDownloads.delete(id);
    return true;
  });

  ipcMain.handle(
    "bookhunter:download-and-ingest",
    async (
      _e,
      args: {
        candidate: BookCandidate;
        collection: string;
        preferredFormat?: BookFileVariant["format"];
        /**
         * Optional caller-provided id. Lets the renderer correlate progress
         * events with its UI card without waiting for the final return.
         */
        downloadId?: string;
      }
    ): Promise<{ downloadId: string; destPath: string; bookTitle: string; embedded: number; upserted: number }> => {
      if (!args || !args.candidate || !args.collection) throw new Error("candidate and collection required");
      const c = args.candidate;
      if (!ALLOWED_LICENSES.has(c.license)) throw new Error(`license '${c.license}' not in whitelist`);

      const variant = pickFormat(c, args.preferredFormat);
      const dir = defaultDownloadDir(c.sourceTag);
      const fileName = `${safeFileName(c.title)}__${c.id}.${variant.format}`;
      const destPath = path.join(dir, fileName);

      /* One AbortController for the whole pipeline: cancel-download stops
         both download and ingest. */
      const ctrl = new AbortController();
      const dlId =
        typeof args.downloadId === "string" && args.downloadId.length > 0
          ? args.downloadId
          : downloadId();
      activeDownloads.set(dlId, ctrl);
      const win = getMainWindow();
      try {
        const prefs = await getPreferencesStore().getAll();
        await downloadBook({
          variant,
          destPath,
          signal: ctrl.signal,
          maxRetries: prefs.downloadMaxRetries,
          onProgress: (downloaded, total) => {
            if (win && !win.isDestroyed()) {
              win.webContents.send("bookhunter:download-progress", {
                downloadId: dlId,
                downloaded,
                total,
              });
            }
          },
        });
        if (ctrl.signal.aborted) throw new Error("download aborted");

        const stateStore = new ScannerStateStore(path.join(app.getPath("userData"), "scanner", "scanner-progress.json"));
        const ingestRes = await ingestBook(destPath, {
          collection: args.collection,
          qdrantUrl: QDRANT_URL,
          qdrantApiKey: QDRANT_API_KEY,
          state: stateStore,
          signal: ctrl.signal,
          upsertBatch: prefs.ingestUpsertBatch,
          maxBookChars: prefs.maxBookChars,
          parseOptions: {
            ocrEnabled: prefs.ocrEnabled && isOcrSupported(),
            ocrLanguages: prefs.ocrLanguages,
            ocrAccuracy: prefs.ocrAccuracy,
            ocrPdfDpi: prefs.ocrPdfDpi,
            signal: ctrl.signal,
          },
          onProgress: (p) => {
            if (win && !win.isDestroyed()) {
              win.webContents.send("scanner:ingest-progress", { ingestId: `bh-${dlId}`, ...p });
            }
          },
        });
        return {
          downloadId: dlId,
          destPath,
          bookTitle: ingestRes.bookTitle,
          embedded: ingestRes.embedded,
          upserted: ingestRes.upserted,
        };
      } finally {
        activeDownloads.delete(dlId);
      }
    }
  );
}
