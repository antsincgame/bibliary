import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Phase 8d — streaming JSONL writer через Node fs.WriteStream + temp file.
 *
 * Зачем нужен:
 *   - In-memory buffer (Phase 8a/8b initial impl) держит весь JSONL в
 *     RAM до upload. Для 10K concepts × ~200 байт/line = 2MB — OK.
 *     Для 100K concepts × ~5000 байт/line (ShareGPT с full answer)
 *     = 500MB — heap pressure.
 *   - Streaming в temp file даёт O(1) RAM regardless of dataset size.
 *
 * Pattern:
 *   const writer = await openTempJsonlWriter("training-v1.jsonl");
 *   for (...) await writer.writeLine(JSON.stringify(record));
 *   const { path, bytes } = await writer.finish();
 *   // → InputFile.fromPath(path, filename) → Storage upload
 *   await writer.cleanup();
 */

export interface JsonlStreamWriter {
  writeLine: (json: string) => Promise<void>;
  finish: () => Promise<{ path: string; bytes: number }>;
  cleanup: () => Promise<void>;
}

export async function openTempJsonlWriter(filename: string): Promise<JsonlStreamWriter> {
  const dir = await mkdtemp(join(tmpdir(), "bibliary-build-"));
  const path = join(dir, filename);
  const stream = createWriteStream(path, { flags: "w", encoding: "utf-8" });
  let bytes = 0;
  let finished = false;
  let closeResolvers: { resolve: () => void; reject: (err: Error) => void } | null = null;
  stream.on("close", () => {
    finished = true;
    closeResolvers?.resolve();
  });
  stream.on("error", (err) => {
    closeResolvers?.reject(err);
  });

  const writeLine = (json: string): Promise<void> =>
    new Promise((resolve, reject) => {
      const line = json + "\n";
      const ok = stream.write(line, "utf-8", (err) => {
        if (err) reject(err);
        else resolve();
      });
      if (ok) {
        /* No backpressure — resolve cb уже отрабатывает. */
        bytes += Buffer.byteLength(line, "utf-8");
      } else {
        bytes += Buffer.byteLength(line, "utf-8");
        /* Backpressure — ждём drain. cb выше уже вызовется. */
      }
    });

  const finish = async (): Promise<{ path: string; bytes: number }> => {
    if (finished) return { path, bytes };
    await new Promise<void>((resolve, reject) => {
      closeResolvers = { resolve, reject };
      stream.end((err: Error | null | undefined) => {
        if (err) reject(err);
      });
    });
    return { path, bytes };
  };

  const cleanup = async (): Promise<void> => {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  };

  return { writeLine, finish, cleanup };
}
