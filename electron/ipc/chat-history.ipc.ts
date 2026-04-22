/**
 * Persistent chat history (Phase 3 -- /omnissiah Medium finding).
 *
 * The chat module's `history` array previously lived only in renderer
 * memory: app reload (or accidental window close) lost the conversation.
 * It also grew without bound -- IPC payload sent on every send was
 * `[...history, newMessage]`, growing linearly with conversation length.
 *
 * This IPC adds two operations:
 *   - chat-history:load -> messages: ChatMessage[]   (last `cap`)
 *   - chat-history:save (messages) -> void           (writes to disk)
 *
 * Storage: data/chat-history.json, atomic write under file-lock.
 * FIFO eviction at `prefs.chatHistoryCap`.
 *
 * Disabled at runtime if `prefs.chatHistoryPersist === false`.
 */

import { ipcMain, app } from "electron";
import * as path from "path";
import { promises as fs } from "fs";
import { z } from "zod";
import { writeJsonAtomic, withFileLock } from "../lib/resilience/index.js";
import { getPreferencesStore } from "../lib/preferences/store.js";

const ChatMessageSchema = z.object({
  role: z.enum(["user", "assistant", "system"]),
  content: z.string().max(200_000), // 200kb per message hard cap
});

const ChatHistoryFileSchema = z.object({
  version: z.literal(1),
  updatedAt: z.string(),
  messages: z.array(ChatMessageSchema),
});

type ChatMessage = z.infer<typeof ChatMessageSchema>;
type ChatHistoryFile = z.infer<typeof ChatHistoryFileSchema>;

function historyPath(): string {
  return path.join(app.getPath("userData"), "chat-history.json");
}

export function registerChatHistoryIpc(): void {
  ipcMain.handle("chat-history:load", async (): Promise<ChatMessage[]> => {
    const prefs = await getPreferencesStore().getAll();
    if (!prefs.chatHistoryPersist) return [];
    try {
      const raw = await fs.readFile(historyPath(), "utf8");
      const parsed = ChatHistoryFileSchema.parse(JSON.parse(raw));
      const cap = prefs.chatHistoryCap;
      return parsed.messages.slice(-cap);
    } catch {
      /* No file yet, or corrupted. Return empty -- not an error. */
      return [];
    }
  });

  ipcMain.handle("chat-history:save", async (_e, raw: unknown): Promise<{ saved: number }> => {
    const prefs = await getPreferencesStore().getAll();
    if (!prefs.chatHistoryPersist) return { saved: 0 };
    /* Validate first to refuse oversized payloads (DoS guard). */
    const messages = z.array(ChatMessageSchema).max(prefs.chatHistoryCap).parse(raw);
    const file: ChatHistoryFile = {
      version: 1,
      updatedAt: new Date().toISOString(),
      messages,
    };
    const target = historyPath();
    await fs.mkdir(path.dirname(target), { recursive: true });
    await withFileLock(target, async () => {
      await writeJsonAtomic(target, file);
    });
    return { saved: messages.length };
  });

}
