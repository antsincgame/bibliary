import { promises as fs } from "fs";
import * as path from "path";

/**
 * Stateless-friendly хранилище прогресса сканера.
 * Один JSON-файл `scanner-progress.json` в data-dir пользователя.
 *
 * Формат сделан так, чтобы можно было резюмировать ingest книги после краша:
 * по `bookSourcePath` и `processedChunkIds`.
 */

export interface ScannerBookState {
  bookSourcePath: string;
  collection: string;
  totalChunks: number;
  processedChunkIds: string[];
  startedAt: string;
  lastUpdatedAt: string;
  status: "running" | "done" | "error" | "paused";
  errorMessage?: string;
}

export interface ScannerState {
  version: 1;
  books: Record<string, ScannerBookState>;
}

export class ScannerStateStore {
  constructor(private filePath: string) {}

  async read(): Promise<ScannerState> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as ScannerState;
      if (parsed && parsed.version === 1 && parsed.books) return parsed;
    } catch {
      /* fresh */
    }
    return { version: 1, books: {} };
  }

  async write(state: ScannerState): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
    await fs.rename(tmp, this.filePath);
  }

  async upsertBook(book: ScannerBookState): Promise<void> {
    const cur = await this.read();
    cur.books[book.bookSourcePath] = book;
    await this.write(cur);
  }

  async markProgress(bookPath: string, addedChunkIds: string[]): Promise<void> {
    const cur = await this.read();
    const b = cur.books[bookPath];
    if (!b) return;
    const seen = new Set(b.processedChunkIds);
    for (const id of addedChunkIds) seen.add(id);
    b.processedChunkIds = Array.from(seen);
    b.lastUpdatedAt = new Date().toISOString();
    await this.write(cur);
  }

  async markStatus(
    bookPath: string,
    status: ScannerBookState["status"],
    errorMessage?: string
  ): Promise<void> {
    const cur = await this.read();
    const b = cur.books[bookPath];
    if (!b) return;
    b.status = status;
    if (errorMessage !== undefined) b.errorMessage = errorMessage;
    b.lastUpdatedAt = new Date().toISOString();
    await this.write(cur);
  }
}
