/**
 * concepts-export — выгрузить концепты из ChromaDB в JSONL для forward-compat
 * backup'а перед миграцией на LanceDB (см. docs/concepts-backup.md).
 *
 * Формат каждой строки: `{"id": "...", "document": "...", "embedding": [...],
 * "metadata": {...}}`. Совместим с миграционным sink'ом v2.0 (см.
 * `electron/lib/migration/lance-sink.ts` — Phase 3).
 *
 * Стратегия записи: **stream-only**. `fs.createWriteStream` + per-row
 * `stream.write(JSON.stringify(row) + "\n")` с back-pressure handling. На
 * корпусе с 50K+ концептов и 384-dim эмбеддингами полный массив строк в
 * памяти даёт несколько сотен МБ RSS — недопустимо.
 *
 * Идемпотентность: пишем в `${out}.tmp`, по успеху — atomic rename. На abort
 * / crash временный файл остаётся на диске для inspection, итоговый out —
 * нетронутый.
 *
 * Пример:
 *   npm run concepts:export -- \
 *     --collection bibliary_concepts \
 *     --out data/concepts/bibliary_concepts.jsonl
 *
 *   npm run concepts:export -- \
 *     --collection bibliary_books \
 *     --out data/concepts/bibliary_books.jsonl \
 *     --no-embedding
 */

import * as fs from "fs";
import * as path from "path";

import { resolveCollectionId } from "../electron/lib/chroma/collection-cache.js";
import { scrollChroma, type ChromaInclude } from "../electron/lib/chroma/scroll.js";
import { setChromaUrl } from "../electron/lib/chroma/http-client.js";

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
};

interface Args {
  collection: string;
  out: string;
  includeEmbedding: boolean;
  pageSize: number;
  maxItems: number;
  chromaUrl?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Partial<Args> = {
    includeEmbedding: true,
    pageSize: 256,
    maxItems: 1_000_000,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) {
        console.error(`${C.red}error${C.reset}: ${a} requires a value`);
        process.exit(2);
      }
      return v;
    };
    switch (a) {
      case "--collection": args.collection = next(); break;
      case "--out":        args.out = next(); break;
      case "--page-size":  args.pageSize = Number.parseInt(next(), 10); break;
      case "--max-items":  args.maxItems = Number.parseInt(next(), 10); break;
      case "--chroma-url": args.chromaUrl = next(); break;
      case "--include-embedding": args.includeEmbedding = true; break;
      case "--no-embedding":      args.includeEmbedding = false; break;
      case "-h":
      case "--help":
        printUsage();
        process.exit(0);
        break;
      default:
        console.error(`${C.red}error${C.reset}: unknown arg "${a}"`);
        printUsage();
        process.exit(2);
    }
  }
  if (!args.collection) {
    console.error(`${C.red}error${C.reset}: --collection is required`);
    printUsage();
    process.exit(2);
  }
  if (!args.out) {
    console.error(`${C.red}error${C.reset}: --out is required`);
    printUsage();
    process.exit(2);
  }
  if (!Number.isFinite(args.pageSize!) || args.pageSize! < 1) {
    console.error(`${C.red}error${C.reset}: --page-size must be a positive integer`);
    process.exit(2);
  }
  return args as Args;
}

function printUsage(): void {
  process.stdout.write(
    `Usage: concepts-export --collection <name> --out <path.jsonl> [options]\n` +
    `\nOptions:\n` +
    `  --collection <name>      Chroma collection name (required)\n` +
    `  --out <path>             Output JSONL path (required)\n` +
    `  --no-embedding           Skip embedding column (smaller file, no vector restore)\n` +
    `  --include-embedding      Include 384-dim embedding (default)\n` +
    `  --page-size <N>          Chroma scroll page size (default 256)\n` +
    `  --max-items <N>          Hard cap on total rows (default 1_000_000)\n` +
    `  --chroma-url <url>       Override Chroma URL (otherwise CHROMA_URL env or default)\n` +
    `\nFormat (one JSON per line):\n` +
    `  {"id":"...","document":"...","embedding":[...],"metadata":{...}}\n`,
  );
}

interface ExportResult {
  rowsWritten: number;
  bytesWritten: number;
  pagesFetched: number;
}

/**
 * Промисифицированный `stream.write` с back-pressure: если буфер переполнен
 * (write вернул false) — ждём `drain` event перед следующим write. Без этого
 * на больших коллекциях RSS быстро уползает за гигабайт.
 */
function writeWithBackpressure(stream: fs.WriteStream, data: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error): void => {
      stream.off("error", onError);
      reject(err);
    };
    stream.once("error", onError);
    const ok = stream.write(data, (err) => {
      if (err) { reject(err); return; }
      if (ok) {
        stream.off("error", onError);
        resolve();
      }
    });
    if (!ok) {
      stream.once("drain", () => {
        stream.off("error", onError);
        resolve();
      });
    }
  });
}

function endStream(stream: fs.WriteStream): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.once("error", reject);
    stream.end(() => resolve());
  });
}

export async function exportConcepts(args: Args): Promise<ExportResult> {
  if (args.chromaUrl) setChromaUrl(args.chromaUrl);

  const tmpPath = `${args.out}.tmp`;
  await fs.promises.mkdir(path.dirname(args.out), { recursive: true });

  /* Стерильно стартуем — если предыдущий запуск упал, .tmp может остаться. */
  try { await fs.promises.unlink(tmpPath); } catch { /* nothing to remove */ }

  const collectionId = await resolveCollectionId(args.collection);

  const include: ChromaInclude[] = args.includeEmbedding
    ? ["documents", "metadatas", "embeddings"]
    : ["documents", "metadatas"];

  const stream = fs.createWriteStream(tmpPath, { encoding: "utf8" });

  let rowsWritten = 0;
  let bytesWritten = 0;
  let pagesFetched = 0;

  try {
    for await (const page of scrollChroma({
      collectionId,
      include,
      pageSize: args.pageSize,
      maxItems: args.maxItems,
    })) {
      pagesFetched += 1;
      const ids = page.ids;
      const docs = page.documents ?? [];
      const metas = page.metadatas ?? [];
      const embs = page.embeddings ?? [];

      for (let i = 0; i < ids.length; i++) {
        const row: Record<string, unknown> = {
          id: ids[i],
          document: docs[i] ?? "",
          metadata: metas[i] ?? {},
        };
        if (args.includeEmbedding) {
          row.embedding = embs[i] ?? null;
        }
        const line = JSON.stringify(row) + "\n";
        await writeWithBackpressure(stream, line);
        rowsWritten += 1;
        bytesWritten += Buffer.byteLength(line, "utf8");
      }

      if (pagesFetched % 10 === 0) {
        process.stdout.write(
          `${C.dim}[concepts-export]${C.reset} pages=${pagesFetched} rows=${rowsWritten} bytes=${bytesWritten}\r`,
        );
      }
    }
    await endStream(stream);
    /* Atomic rename: out появляется только когда .tmp полностью записан. */
    await fs.promises.rename(tmpPath, args.out);
  } catch (err) {
    /* На любую ошибку — закрыть stream, оставить .tmp для inspection. */
    try { stream.destroy(); } catch { /* ignore */ }
    throw err;
  }

  return { rowsWritten, bytesWritten, pagesFetched };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  console.log(
    `${C.bold}concepts-export${C.reset} ${C.dim}collection=${args.collection} out=${args.out} ${
      args.includeEmbedding ? "with-embedding" : "no-embedding"
    }${C.reset}`,
  );

  const t0 = Date.now();
  try {
    const result = await exportConcepts(args);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    process.stdout.write("\n");
    console.log(
      `${C.green}✓${C.reset} wrote ${C.bold}${result.rowsWritten}${C.reset} rows ` +
      `(${(result.bytesWritten / 1024 / 1024).toFixed(1)} MB, ${result.pagesFetched} pages) ` +
      `in ${elapsed}s`,
    );
    console.log(`${C.dim}→ ${path.resolve(args.out)}${C.reset}`);
  } catch (err) {
    process.stdout.write("\n");
    console.error(`${C.red}✗ export failed${C.reset}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

/* Запускаем main только когда файл вызван как entrypoint, не при импорте
   из тестов (где нужны `exportConcepts` + `parseArgs` напрямую). */
const invokedDirectly =
  typeof require !== "undefined" && require.main === module;
if (invokedDirectly) {
  void main();
}

export { parseArgs, type Args, type ExportResult };
