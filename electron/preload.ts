import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("api", {
  getCollections: (): Promise<string[]> =>
    ipcRenderer.invoke("qdrant:collections"),

  getPoints: (collection: string): Promise<Array<{ id: string; principle: string; explanation: string; domain: string; tags: string[] }>> =>
    ipcRenderer.invoke("qdrant:points", collection),

  getModels: (): Promise<Array<{ id: string }>> =>
    ipcRenderer.invoke("lmstudio:models"),

  sendChat: (
    messages: Array<{ role: string; content: string }>,
    model: string,
    collection: string
  ): Promise<string> =>
    ipcRenderer.invoke("lmstudio:chat", messages, model, collection),
});
