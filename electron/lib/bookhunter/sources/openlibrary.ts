/**
 * Open Library (openlibrary.org) — search.json + bibkeys ISBN lookup.
 *
 * Two modes:
 *   1. `search()` — full-text search for public ebooks (BookHunter flow).
 *   2. `lookupByIsbn()` — deterministic bibliographic lookup by ISBN-13
 *      (metadata enrichment during import; no license restrictions).
 */

import { USER_AGENT, type BookCandidate, type BookFileVariant, type BookSource, type SearchOptions } from "../types.js";

export interface IsbnMeta {
  title?: string;
  authors?: string[];
  year?: number;
  publisher?: string;
  language?: string;
  /** Normalised ISBN-13 (digits only). */
  isbn13?: string;
}

const SEARCH_ENDPOINT = "https://openlibrary.org/search.json";
const BIBKEYS_ENDPOINT = "https://openlibrary.org/api/books";
const IA_DOWNLOAD = "https://archive.org/download";

interface OlDoc {
  key: string;
  title: string;
  author_name?: string[];
  language?: string[];
  first_publish_year?: number;
  ia?: string[];
  has_fulltext?: boolean;
  public_scan_b?: boolean;
  ebook_access?: "no_ebook" | "borrowable" | "public" | "printdisabled" | "open";
}

async function search(opts: SearchOptions): Promise<BookCandidate[]> {
  const params = new URLSearchParams();
  params.set("q", opts.query);
  params.set("limit", String(opts.perSourceLimit ?? 10));
  if (opts.language) params.set("language", opts.language);
  /* Просим только записи с публично доступным ebook */
  params.set("has_fulltext", "true");

  const resp = await fetch(`${SEARCH_ENDPOINT}?${params.toString()}`, {
    headers: { "User-Agent": USER_AGENT },
    signal: opts.signal,
  });
  if (!resp.ok) throw new Error(`openlibrary ${resp.status}`);
  const data = (await resp.json()) as { docs?: OlDoc[] };
  const docs = data.docs ?? [];

  const out: BookCandidate[] = [];
  for (const doc of docs) {
    /* Только public/open ebooks — исключаем borrowable/printdisabled */
    if (doc.ebook_access && doc.ebook_access !== "public" && doc.ebook_access !== "open") continue;
    const iaIds = doc.ia ?? [];
    if (iaIds.length === 0) continue;
    const formats: BookFileVariant[] = [];
    /* Pattern с IA: <id>.epub, <id>.pdf, <id>_djvu.txt */
    for (const id of iaIds.slice(0, 1)) {
      formats.push(
        { format: "epub", url: `${IA_DOWNLOAD}/${id}/${id}.epub` },
        { format: "pdf", url: `${IA_DOWNLOAD}/${id}/${id}.pdf` },
        { format: "txt", url: `${IA_DOWNLOAD}/${id}/${id}_djvu.txt` }
      );
    }
    out.push({
      id: doc.key,
      sourceTag: "openlibrary",
      title: doc.title,
      authors: doc.author_name ?? [],
      language: doc.language?.[0],
      year: doc.first_publish_year,
      formats,
      license: doc.public_scan_b ? "public-domain" : "open-access",
      webPageUrl: `https://openlibrary.org${doc.key}`,
    });
  }
  return out;
}

/**
 * Look up bibliographic metadata from Open Library by ISBN-13.
 * Uses the Books API (bibkeys / jscmd=details / format=json).
 * Returns null on network error or unknown ISBN — caller handles gracefully.
 */
export async function lookupIsbnOpenLibrary(
  isbn13: string,
  signal?: AbortSignal,
): Promise<IsbnMeta | null> {
  const params = new URLSearchParams({
    bibkeys: `ISBN:${isbn13}`,
    jscmd: "details",
    format: "json",
  });
  let resp: Response;
  try {
    resp = await fetch(`${BIBKEYS_ENDPOINT}?${params.toString()}`, {
      headers: { "User-Agent": USER_AGENT },
      signal,
    });
  } catch {
    return null;
  }
  if (!resp.ok) return null;

  let raw: unknown;
  try {
    raw = await resp.json();
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;

  const entry = (raw as Record<string, unknown>)[`ISBN:${isbn13}`];
  if (!entry || typeof entry !== "object") return null;

  const details = ((entry as Record<string, unknown>).details ?? {}) as Record<string, unknown>;

  const title =
    typeof details.title === "string" && details.title.trim()
      ? details.title.trim()
      : undefined;

  const rawAuthors = (details.authors as Array<{ name?: string }> | undefined) ?? [];
  const authors = rawAuthors
    .map((a) => (typeof a.name === "string" ? a.name.trim() : ""))
    .filter(Boolean);

  const publishDate: string | undefined =
    typeof details.publish_date === "string" ? details.publish_date : undefined;
  const year = publishDate ? Number(publishDate.match(/\d{4}/)?.[0]) || undefined : undefined;

  const publishers = (details.publishers as string[] | undefined) ?? [];
  const publisher = publishers[0]?.trim() || undefined;

  const langs = ((details.languages as Array<{ key?: string }> | undefined) ?? [])
    .map((l) => l.key?.replace("/languages/", "").trim() ?? "")
    .filter(Boolean);
  const language = langs[0];

  return {
    title,
    authors: authors.length > 0 ? authors : undefined,
    year: year && year >= 1400 && year <= 2100 ? year : undefined,
    publisher,
    language,
    isbn13,
  };
}

export const openLibrarySource: BookSource = { tag: "openlibrary", search };
