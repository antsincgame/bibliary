/**
 * Phase 3.0 — Streaming downloader.
 * fetch + ReadableStream → file. Поддержка resume через Range header,
 * retry на 5xx с экспоненциальным backoff (3 попытки макс).
 */

import { promises as fs } from "fs";
import * as fsSync from "fs";
import * as path from "path";
import { USER_AGENT, type BookFileVariant } from "./types.js";

export interface DownloadOptions {
  variant: BookFileVariant;
  destPath: string;
  signal?: AbortSignal;
  onProgress?: (downloadedBytes: number, totalBytes: number | null) => void;
  /** Максимум попыток на 5xx. Default 3. */
  maxRetries?: number;
}

export interface DownloadResult {
  destPath: string;
  bytesWritten: number;
  format: BookFileVariant["format"];
}

async function statSize(p: string): Promise<number | null> {
  try {
    const st = await fs.stat(p);
    return st.size;
  } catch {
    return null;
  }
}

async function backoff(attempt: number): Promise<void> {
  const ms = Math.min(2 ** attempt * 500, 10_000);
  await new Promise((r) => setTimeout(r, ms));
}

export async function downloadBook(opts: DownloadOptions): Promise<DownloadResult> {
  await fs.mkdir(path.dirname(opts.destPath), { recursive: true });
  const maxRetries = opts.maxRetries ?? 3;

  let lastError: Error | null = null;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const resumeFrom = await statSize(opts.destPath);
      const headers: Record<string, string> = { "User-Agent": USER_AGENT };
      if (resumeFrom && resumeFrom > 0) headers["Range"] = `bytes=${resumeFrom}-`;
      const resp = await fetch(opts.variant.url, { headers, signal: opts.signal });

      if (resp.status === 416) {
        /* Уже полностью скачан */
        const finalSize = await statSize(opts.destPath);
        return { destPath: opts.destPath, bytesWritten: finalSize ?? 0, format: opts.variant.format };
      }
      if (resp.status >= 500 && resp.status < 600) {
        lastError = new Error(`HTTP ${resp.status} ${resp.statusText}`);
        await backoff(attempt);
        continue;
      }
      if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
      if (!resp.body) throw new Error("response has no body");

      const isResumed = resumeFrom !== null && resumeFrom > 0 && resp.status === 206;
      const contentLength = resp.headers.get("content-length");
      /* total = content-length + resumeFrom только при настоящем 206; иначе сервер
         отдал полный поток заново и content-length уже = размер целиком. */
      const totalBytes = contentLength
        ? Number(contentLength) + (isResumed ? (resumeFrom as number) : 0)
        : null;

      const flags: fsSync.OpenMode = isResumed ? "a" : "w";
      const handle = await fs.open(opts.destPath, flags);
      let written = isResumed ? (resumeFrom as number) : 0;

      try {
        const reader = resp.body.getReader();
        while (true) {
          if (opts.signal?.aborted) throw new Error("download aborted");
          const { value, done } = await reader.read();
          if (done) break;
          if (value) {
            await handle.write(value);
            written += value.byteLength;
            opts.onProgress?.(written, totalBytes);
          }
        }
      } finally {
        await handle.close();
      }
      return { destPath: opts.destPath, bytesWritten: written, format: opts.variant.format };
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
      if (opts.signal?.aborted) throw lastError;
      if (attempt < maxRetries - 1) {
        await backoff(attempt);
        continue;
      }
    }
  }
  throw lastError ?? new Error("download failed");
}
