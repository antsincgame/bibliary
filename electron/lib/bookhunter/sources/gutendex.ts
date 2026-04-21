/**
 * Project Gutenberg via Gutendex (https://gutendex.com).
 * Gutendex — открытый сторонний REST API над PG. Без auth, без rate-limit.
 * License: всегда public-domain (это контракт PG).
 */

import { USER_AGENT, type BookCandidate, type BookFileVariant, type BookSource, type SearchOptions } from "../types.js";

const ENDPOINT = "https://gutendex.com/books";

interface GutendexBook {
  id: number;
  title: string;
  authors: Array<{ name: string; birth_year?: number; death_year?: number }>;
  languages: string[];
  download_count?: number;
  formats: Record<string, string>;
}

function pickFormats(formats: Record<string, string>): BookFileVariant[] {
  const out: BookFileVariant[] = [];
  for (const [mime, url] of Object.entries(formats)) {
    if (mime.startsWith("application/epub+zip") && !url.includes(".images")) {
      out.push({ format: "epub", url });
    } else if (mime.startsWith("text/plain") && url.endsWith(".txt") && !url.includes(".zip")) {
      out.push({ format: "txt", url });
    } else if (mime === "application/pdf") {
      out.push({ format: "pdf", url });
    }
  }
  return out;
}

async function search(opts: SearchOptions): Promise<BookCandidate[]> {
  const params = new URLSearchParams();
  params.set("search", opts.query);
  if (opts.language) params.set("languages", opts.language);
  const url = `${ENDPOINT}?${params.toString()}`;
  const resp = await fetch(url, {
    signal: opts.signal,
    headers: { "User-Agent": USER_AGENT },
  });
  if (!resp.ok) throw new Error(`gutendex ${resp.status}`);
  const data = (await resp.json()) as { results?: GutendexBook[] };
  const list = data.results ?? [];
  const limit = opts.perSourceLimit ?? 10;
  return list.slice(0, limit).map((b) => ({
    id: String(b.id),
    sourceTag: "gutendex" as const,
    title: b.title,
    authors: b.authors.map((a) => a.name),
    language: b.languages?.[0],
    year: b.authors[0]?.death_year,
    formats: pickFormats(b.formats),
    searchScore: b.download_count,
    license: "public-domain" as const,
    webPageUrl: `https://www.gutenberg.org/ebooks/${b.id}`,
  }));
}

export const gutendexSource: BookSource = { tag: "gutendex", search };
