import { promises as fs } from "fs";
import * as path from "path";
import { withFileLock } from "../resilience/file-lock.js";

/**
 * Persistent scanner-progress storage. One JSON file
 * `scanner-progress.json` in the user data dir.
 *
 * Format: { version, books: Record<bookSourcePath, ScannerBookState> }.
 * Designed so an ingest can resume after crash via processedChunkIds.
 *
 * Phase 2.5R-bis: every mutation goes through `withFileLock` to make
 * parallel ingests safe. Without the lock the read-modify-write pattern
 * would lose progress when `ingestParallelism > 1` (default 3) -- two
 * books finishing a flush at the same time would last-write-wins on the
 * single shared file.
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
    await this.mutate((cur) => {
      cur.books[book.bookSourcePath] = book;
    });
  }

  async markProgress(bookPath: string, addedChunkIds: string[]): Promise<void> {
    await this.mutate((cur) => {
      const b = cur.books[bookPath];
      if (!b) return;
      const seen = new Set(b.processedChunkIds);
      for (const id of addedChunkIds) seen.add(id);
      b.processedChunkIds = Array.from(seen);
      b.lastUpdatedAt = new Date().toISOString();
    });
  }

  async markStatus(
    bookPath: string,
    status: ScannerBookState["status"],
    errorMessage?: string
  ): Promise<void> {
    await this.mutate((cur) => {
      const b = cur.books[bookPath];
      if (!b) return;
      b.status = status;
      if (errorMessage !== undefined) b.errorMessage = errorMessage;
      b.lastUpdatedAt = new Date().toISOString();
    });
  }

  /**
   * Atomic read-modify-write under a cross-process file lock. This is
   * the only safe way to mutate when several ingests share the same
   * progress file (queueParallelism > 1).
   *
   * `withFileLock` ensures the file exists, so we can read straight away.
   */
  private async mutate(modify: (state: ScannerState) => void | Promise<void>): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await withFileLock(this.filePath, async () => {
      const cur = await this.read();
      await modify(cur);
      await this.write(cur);
    });
  }
}
