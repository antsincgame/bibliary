import * as os from "os";
import * as path from "path";
import { probeBooks, parseBook, chunkBook, type BookFileSummary } from "../electron/lib/scanner/index.js";

export function argValues(argv: string[], flag: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === flag && i + 1 < argv.length) values.push(argv[i + 1]);
  }
  return values;
}

function envRoots(): string[] {
  const multi = process.env.BIBLIARY_E2E_SOURCE_DIRS ?? "";
  const single = process.env.BIBLIARY_E2E_SOURCE_DIR ?? "";
  const out: string[] = [];
  if (multi) {
    for (const part of multi.split(path.delimiter)) {
      const trimmed = part.trim();
      if (trimmed) out.push(trimmed);
    }
  }
  if (single.trim()) out.push(single.trim());
  return out;
}

export function getSourceRootsFromArgv(argv: string[], fallbackLibraryDir?: string): string[] {
  const explicitRoots = [...argValues(argv, "--source-dir"), ...envRoots()];
  const raw = explicitRoots.length
    ? explicitRoots
    : [
        path.join(os.homedir(), "Downloads"),
        fallbackLibraryDir ?? path.join(process.cwd(), "data", "library"),
      ];

  const seen = new Set<string>();
  const roots: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string" || item.trim().length === 0) continue;
    const resolved = path.resolve(item.trim());
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    roots.push(resolved);
  }
  return roots;
}

export async function collectProbeBooksFromRoots(
  roots: string[],
  maxDepth = 4,
  includeImages = false,
): Promise<BookFileSummary[]> {
  const merged = new Map<string, BookFileSummary>();
  for (const dir of roots) {
    try {
      const books = await probeBooks(dir, maxDepth, includeImages);
      for (const book of books) {
        if (!merged.has(book.absPath)) merged.set(book.absPath, book);
      }
    } catch {
      /* ignore missing roots; callers validate the final result */
    }
  }
  return [...merged.values()];
}

const DEFAULT_MIN_BYTES = 8 * 1024;
const DEFAULT_MAX_VALIDATION_CANDIDATES = 16;

type ChunkableOptions = {
  maxBytes?: number;
  minBytes?: number;
  maxValidationCandidates?: number;
};

export async function pickChunkableBooksByExt(
  books: BookFileSummary[],
  preferredExts: string[],
  opts: ChunkableOptions = {},
): Promise<BookFileSummary[]> {
  const minBytes = opts.minBytes ?? DEFAULT_MIN_BYTES;
  const maxBytes = opts.maxBytes ?? Number.POSITIVE_INFINITY;
  const maxValidationCandidates = opts.maxValidationCandidates ?? DEFAULT_MAX_VALIDATION_CANDIDATES;
  const chunkCountCache = new Map<string, number>();

  const getChunkCount = async (book: BookFileSummary): Promise<number> => {
    const cached = chunkCountCache.get(book.absPath);
    if (cached !== undefined) return cached;
    try {
      const parsed = await parseBook(book.absPath);
      const count = chunkBook(parsed, book.absPath).length;
      chunkCountCache.set(book.absPath, count);
      return count;
    } catch {
      chunkCountCache.set(book.absPath, 0);
      return 0;
    }
  };

  const chosen: BookFileSummary[] = [];
  const seen = new Set<string>();

  for (const ext of preferredExts) {
    const pool = books
      .filter((book) => book.ext === ext)
      .filter((book) => book.sizeBytes >= minBytes && book.sizeBytes <= maxBytes)
      .slice(0, maxValidationCandidates);
    for (const candidate of pool) {
      if (seen.has(candidate.absPath)) continue;
      if (await getChunkCount(candidate)) {
        chosen.push(candidate);
        seen.add(candidate.absPath);
        break;
      }
    }
  }

  return chosen;
}
