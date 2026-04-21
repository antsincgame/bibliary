import { ipcMain } from "electron";
import {
  chat,
  listOpenAiModels,
  listDownloaded,
  listLoaded,
  loadModel,
  unloadModel,
  switchProfile,
  getServerStatus,
  PROFILE,
  type ProfileName,
} from "../lmstudio-client.js";
import {
  searchRelevantChunks,
  formatChunksForPrompt,
  buildRagPrompt,
  extractUserQuery,
  CHAT_SAMPLING,
} from "../lib/rag/index.js";

export function registerLmstudioIpc(): void {
  ipcMain.handle("lmstudio:models", async (): Promise<Array<{ id: string }>> => {
    const ids = await listOpenAiModels();
    return ids.map((id) => ({ id }));
  });

  ipcMain.handle(
    "lmstudio:chat",
    async (
      _e,
      messages: Array<{ role: string; content: string }>,
      model: string,
      collection: string
    ): Promise<string> => {
      let systemPrompt = "You are Bibliary — an expert knowledge assistant. You help users explore their curated library of concepts extracted from books. Answer questions using your general knowledge. Respond in Russian unless the user writes in English.";
      if (collection) {
        try {
          const query = extractUserQuery(messages);
          if (query) {
            const results = await searchRelevantChunks(collection, query);
            if (results.length > 0) {
              systemPrompt = buildRagPrompt(formatChunksForPrompt(results));
              console.log(`[rag:chat] Found ${results.length} relevant chunks`);
            }
          }
        } catch (e) {
          console.error("[rag:chat]", e instanceof Error ? e.message : e);
        }
      }

      const response = await chat({
        model,
        messages: [{ role: "system", content: systemPrompt }, ...messages] as Array<{
          role: "system" | "user" | "assistant";
          content: string;
        }>,
        sampling: CHAT_SAMPLING,
      });
      return response.content;
    }
  );

  ipcMain.handle(
    "lmstudio:compare",
    async (
      _e,
      messages: Array<{ role: string; content: string }>,
      model: string,
      collection: string
    ): Promise<{
      withoutRag: string;
      withRag: string;
      usageBase?: { prompt: number; completion: number; total: number };
      usageRag?: { prompt: number; completion: number; total: number };
    }> => {
      const baseSystemPrompt = "You are Bibliary — an expert knowledge assistant. Answer questions using your general knowledge. Respond in Russian unless the user writes in English.";
      let ragSystemPrompt = baseSystemPrompt;
      if (collection) {
        try {
          const query = extractUserQuery(messages);
          if (query) {
            const results = await searchRelevantChunks(collection, query);
            if (results.length > 0) {
              ragSystemPrompt = buildRagPrompt(formatChunksForPrompt(results));
            }
          }
        } catch (e) {
          console.error("[rag:compare]", e instanceof Error ? e.message : e);
        }
      }

      const typed = messages as Array<{ role: "system" | "user" | "assistant"; content: string }>;

      const baseResp = await chat({
        model,
        messages: [{ role: "system", content: baseSystemPrompt }, ...typed],
        sampling: CHAT_SAMPLING,
      });
      const ragResp = await chat({
        model,
        messages: [{ role: "system", content: ragSystemPrompt }, ...typed],
        sampling: CHAT_SAMPLING,
      });

      return {
        withoutRag: baseResp.content,
        withRag: ragResp.content,
        usageBase: baseResp.usage,
        usageRag: ragResp.usage,
      };
    }
  );

  ipcMain.handle("lmstudio:status", async () => getServerStatus());
  ipcMain.handle("lmstudio:list-downloaded", async () => listDownloaded());
  ipcMain.handle("lmstudio:list-loaded", async () => listLoaded());
  ipcMain.handle("lmstudio:profiles", async () => PROFILE);

  ipcMain.handle(
    "lmstudio:load",
    async (_e, modelKey: string, opts: { contextLength?: number; ttlSec?: number; gpuOffload?: "max" | number } = {}) =>
      loadModel(modelKey, opts)
  );
  ipcMain.handle("lmstudio:unload", async (_e, identifier: string) => unloadModel(identifier));
  ipcMain.handle(
    "lmstudio:switch-profile",
    async (_e, profileName: ProfileName, contextLength?: number) => switchProfile(profileName, contextLength)
  );
}
