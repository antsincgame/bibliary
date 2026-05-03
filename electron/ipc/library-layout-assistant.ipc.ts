/**
 * IPC-handler'ы для Layout Assistant (LLM пост-обработка book.md).
 *
 * Каналы:
 *   library:layout-assistant-run-book    — вручную прогнать одну книгу (кнопка в reader).
 *   library:layout-assistant-status      — prefs snapshot + queue status.
 *   library:layout-assistant-enqueue     — ставить книгу в очередь (batch UI).
 *   library:layout-assistant-pause       — пауза очереди.
 *   library:layout-assistant-resume      — возобновление очереди.
 *   library:layout-assistant-cancel-current — отмена текущей обработки.
 *
 * Bug 4 fix: withBookMdLock убран из `run-book` handler.
 * runLayoutAssistant теперь берёт lock только на write-фазу внутри себя.
 */

import { ipcMain } from "electron";
import { getBookById, upsertBook } from "../lib/library/cache-db.js";
import { runLayoutAssistant } from "../lib/library/layout-assistant.js";
import {
  enqueueLayoutBook,
  pauseLayoutAssistant,
  resumeLayoutAssistant,
  cancelCurrentLayoutAssistant,
  getLayoutAssistantStatus,
  type LayoutAssistantStatus,
} from "../lib/library/layout-assistant-queue.js";
import { getPreferencesStore } from "../lib/preferences/store.js";

interface RunBookResult {
  ok: boolean;
  applied: boolean;
  reason?: string;
  warnings?: string[];
  chunksOk?: number;
  chunksFailed?: number;
  model?: string;
}

export function registerLibraryLayoutAssistantIpc(): void {
  /**
   * Вручную прогнать конкретную книгу через layout-assistant.
   * Не зависит от `layoutAssistantEnabled` — пользователь нажал кнопку
   * в reader явно.
   * Bug 4 fix: withBookMdLock убран — runLayoutAssistant берёт lock только
   * для write-фазы и детектирует concurrent edits через hash-check.
   */
  ipcMain.handle(
    "library:layout-assistant-run-book",
    async (_e, args: { bookId: string; force?: boolean }): Promise<RunBookResult> => {
      if (!args || typeof args.bookId !== "string") {
        return { ok: false, applied: false, reason: "bookId required" };
      }
      const meta = getBookById(args.bookId);
      if (!meta) return { ok: false, applied: false, reason: "not-found" };
      try {
        const result = await runLayoutAssistant(meta.mdPath, { force: args.force === true });
        if (result.applied) {
          upsertBook(meta, meta.mdPath); /* touch updatedAt */
        }
        return {
          ok: true,
          applied: result.applied,
          reason: result.error,
          warnings: result.warnings,
          chunksOk: result.chunksOk,
          chunksFailed: result.chunksFailed,
          model: result.model,
        };
      } catch (e) {
        return {
          ok: false,
          applied: false,
          reason: e instanceof Error ? e.message : String(e),
        };
      }
    },
  );

  /**
   * Статус: включён ли layout-assistant в prefs + queue snapshot.
   */
  ipcMain.handle(
    "library:layout-assistant-status",
    async (): Promise<{
      enabled: boolean;
      modelKey: string;
      modelFallbacks: string;
      queue: LayoutAssistantStatus;
    }> => {
      const prefs = await getPreferencesStore().getAll();
      return {
        enabled: prefs.layoutAssistantEnabled === true,
        modelKey: prefs.layoutAssistantModel ?? "",
        modelFallbacks: prefs.layoutAssistantModelFallbacks ?? "",
        queue: getLayoutAssistantStatus(),
      };
    },
  );

  /** Поставить книгу в очередь вручную (batch UI / future automation). */
  ipcMain.handle(
    "library:layout-assistant-enqueue",
    async (_e, args: { bookId: string }): Promise<{ ok: boolean; reason?: string }> => {
      if (!args || typeof args.bookId !== "string") return { ok: false, reason: "bookId required" };
      enqueueLayoutBook(args.bookId);
      return { ok: true };
    },
  );

  ipcMain.handle("library:layout-assistant-pause", async (): Promise<boolean> => {
    pauseLayoutAssistant();
    return true;
  });

  ipcMain.handle("library:layout-assistant-resume", async (): Promise<boolean> => {
    resumeLayoutAssistant();
    return true;
  });

  ipcMain.handle("library:layout-assistant-cancel-current", async (): Promise<boolean> => {
    cancelCurrentLayoutAssistant("user-cancel");
    return true;
  });
}
