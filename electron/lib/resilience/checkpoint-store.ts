import { promises as fs } from "fs";
import * as path from "path";
import type { ZodSchema } from "zod";
import { writeJsonAtomic } from "./atomic-write";
import { withFileLock } from "./file-lock";

export interface CheckpointStore<T> {
  save(id: string, snapshot: T): Promise<void>;
  load(id: string): Promise<T | null>;
  list(): Promise<Array<{ id: string; lastSavedAt: string }>>;
  remove(id: string): Promise<void>;
  scan(): Promise<Array<{ id: string; snapshot: T }>>;
  getPath(id: string): string;
}

export interface CheckpointStoreOptions<T> {
  dir: string;
  schema: ZodSchema<T>;
}

export function createCheckpointStore<T>(opts: CheckpointStoreOptions<T>): CheckpointStore<T> {
  const dir = path.resolve(opts.dir);

  function fileFor(id: string): string {
    if (!/^[A-Za-z0-9._-]+$/.test(id)) {
      throw new Error(`checkpoint id contains unsafe chars: ${id}`);
    }
    return path.join(dir, `${id}.json`);
  }

  async function ensureDir(): Promise<void> {
    await fs.mkdir(dir, { recursive: true });
  }

  return {
    getPath: fileFor,

    async save(id, snapshot) {
      await ensureDir();
      const file = fileFor(id);
      await withFileLock(file, async () => {
        await writeJsonAtomic(file, snapshot);
      });
    },

    async load(id) {
      const file = fileFor(id);
      let raw: string;
      try {
        raw = await fs.readFile(file, "utf8");
      } catch {
        return null;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        throw new Error(
          `checkpoint ${id}: invalid JSON (${err instanceof Error ? err.message : String(err)})`
        );
      }
      const result = opts.schema.safeParse(parsed);
      if (!result.success) {
        throw new Error(`checkpoint ${id}: schema mismatch (${result.error.message})`);
      }
      return result.data;
    },

    async list() {
      await ensureDir();
      let entries: string[];
      try {
        entries = await fs.readdir(dir);
      } catch {
        return [];
      }
      const out: Array<{ id: string; lastSavedAt: string }> = [];
      for (const entry of entries) {
        if (!entry.endsWith(".json")) continue;
        const id = entry.slice(0, -".json".length);
        try {
          const stat = await fs.stat(path.join(dir, entry));
          out.push({ id, lastSavedAt: stat.mtime.toISOString() });
        } catch {
          // skip
        }
      }
      out.sort((a, b) => a.lastSavedAt.localeCompare(b.lastSavedAt));
      return out;
    },

    async remove(id) {
      const file = fileFor(id);
      await fs.unlink(file).catch((err) => console.error("[checkpoint-store/remove] unlink Error:", err));
    },

    async scan() {
      const items = await this.list();
      const out: Array<{ id: string; snapshot: T }> = [];
      for (const { id } of items) {
        try {
          const snapshot = await this.load(id);
          if (snapshot !== null) {
            out.push({ id, snapshot });
          }
        } catch (err) {
          console.error(
            `[checkpoint-store] skip invalid checkpoint ${id}:`,
            err instanceof Error ? err.message : err
          );
        }
      }
      return out;
    },
  };
}
