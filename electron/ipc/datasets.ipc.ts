/**
 * datasets.ipc — обслуживает раздел «Датасеты» (просмотр локально созданных
 * jsonl-датасетов).
 *
 * Никаких БД здесь нет: история хранится в renderer (localStorage), а main
 * только умеет:
 *   - прочитать meta.json по пути папки,
 *   - прочитать первые N строк train.jsonl/val.jsonl (для preview),
 *   - открыть папку в проводнике (уже есть в dataset-v2.ipc.ts),
 *   - выбрать существующую папку датасета (для импорта в историю).
 */

import { ipcMain, dialog, type BrowserWindow } from "electron";
import { promises as fs, createReadStream } from "fs";
import * as path from "path";
import * as readline from "readline";

interface DatasetMetaSnapshot {
  ok: boolean;
  error?: string;
  meta?: Record<string, unknown>;
  files?: Array<{ name: string; sizeBytes: number; lines?: number }>;
  outputDir?: string;
}

async function safeStat(p: string): Promise<{ size: number } | null> {
  try {
    const st = await fs.stat(p);
    return { size: st.size };
  } catch {
    return null;
  }
}

async function countLines(filePath: string, cap = 200_000): Promise<number> {
  return new Promise((resolve) => {
    let count = 0;
    const stream = createReadStream(filePath, { encoding: "utf-8" });
    const rl = readline.createInterface({ input: stream });
    rl.on("line", () => {
      count++;
      if (count >= cap) {
        rl.close();
        stream.destroy();
      }
    });
    rl.on("close", () => resolve(count));
    rl.on("error", () => resolve(count));
  });
}

export function registerDatasetsIpc(getMainWindow: () => BrowserWindow | null): void {
  /**
   * datasets:read-meta — прочитать meta.json + размеры/строки jsonl-файлов
   * в папке датасета. UI использует это для отображения карточки.
   */
  ipcMain.handle(
    "datasets:read-meta",
    async (_e, dirPath: string): Promise<DatasetMetaSnapshot> => {
      if (typeof dirPath !== "string" || !dirPath) {
        return { ok: false, error: "dir-path required" };
      }
      try {
        const metaPath = path.join(dirPath, "meta.json");
        const raw = await fs.readFile(metaPath, "utf-8");
        const meta = JSON.parse(raw) as Record<string, unknown>;

        const files: Array<{ name: string; sizeBytes: number; lines?: number }> = [];
        for (const fname of ["train.jsonl", "val.jsonl"]) {
          const fp = path.join(dirPath, fname);
          const st = await safeStat(fp);
          if (!st) continue;
          const lines = await countLines(fp);
          files.push({ name: fname, sizeBytes: st.size, lines });
        }

        return { ok: true, meta, files, outputDir: dirPath };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  );

  /**
   * datasets:read-jsonl-head — прочитать первые N строк jsonl, распарсить.
   * Используется для preview: показать пользователю как выглядит датасет.
   */
  ipcMain.handle(
    "datasets:read-jsonl-head",
    async (
      _e,
      args: { filePath: string; limit?: number },
    ): Promise<{
      ok: boolean;
      error?: string;
      lines?: Array<{ raw: string; parsed: unknown | null }>;
    }> => {
      if (!args || typeof args.filePath !== "string" || !args.filePath) {
        return { ok: false, error: "filePath required" };
      }
      const limit = Math.max(1, Math.min(500, Number(args.limit) || 50));

      try {
        await fs.access(args.filePath);
      } catch {
        return { ok: false, error: "файл не найден" };
      }

      return new Promise((resolve) => {
        const out: Array<{ raw: string; parsed: unknown | null }> = [];
        const stream = createReadStream(args.filePath, { encoding: "utf-8" });
        const rl = readline.createInterface({ input: stream });
        rl.on("line", (raw) => {
          if (out.length >= limit) {
            rl.close();
            stream.destroy();
            return;
          }
          let parsed: unknown | null = null;
          try {
            parsed = JSON.parse(raw);
          } catch {
            parsed = null;
          }
          out.push({ raw, parsed });
        });
        rl.on("close", () => resolve({ ok: true, lines: out }));
        rl.on("error", (err) =>
          resolve({ ok: false, error: err instanceof Error ? err.message : String(err) }),
        );
      });
    },
  );

  /**
   * datasets:pick-folder — выбрать существующую папку датасета (для импорта
   * в историю просмотра, если запись потерялась/перенесли).
   */
  ipcMain.handle("datasets:pick-folder", async (): Promise<string | null> => {
    const win = getMainWindow();
    const sel = await dialog.showOpenDialog(win ?? undefined!, {
      title: "Выберите папку с датасетом (где лежит meta.json)",
      properties: ["openDirectory"],
    });
    if (sel.canceled || sel.filePaths.length === 0) return null;
    return sel.filePaths[0] ?? null;
  });
}
