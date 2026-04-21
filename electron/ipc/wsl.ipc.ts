import { ipcMain } from "electron";
import { detectWSL } from "../lib/forge/index.js";

export function registerWslIpc(): void {
  ipcMain.handle("wsl:detect", async () => detectWSL());
}
