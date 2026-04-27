/**
 * Google Books API — bibliographic lookup by ISBN-13.
 *
 * Used exclusively for metadata enrichment during book import.
 * Free tier: 1 000 requests/day per IP without an API key.
 * With BIBLIARY_GOOGLE_BOOKS_API_KEY env var the limit is 40 000/day.
 *
 * API docs: https://developers.google.com/books/docs/v1/using
 */

import { USER_AGENT } from "../types.js";
import type { IsbnMeta } from "./openlibrary.js";

const VOLUMES_ENDPOINT = "https://www.googleapis.com/books/v1/volumes";

interface GbVolumeInfo {
  title?: string;
  subtitle?: string;
  authors?: string[];
  publishedDate?: string;
  publisher?: string;
  language?: string;
  industryIdentifiers?: Array<{ type: string; identifier: string }>;
}

interface GbVolume {
  id?: string;
  volumeInfo?: GbVolumeInfo;
}

interface GbSearchResult {
  totalItems?: number;
  items?: GbVolume[];
}

/**
 * Look up a book by ISBN-13 via Google Books Volumes API.
 * Returns null on network failure or no results — never throws.
 */
export async function lookupIsbnGoogleBooks(
  isbn13: string,
  signal?: AbortSignal,
): Promise<IsbnMeta | null> {
  const apiKey = process.env.BIBLIARY_GOOGLE_BOOKS_API_KEY?.trim();
  const params = new URLSearchParams({
    q: `isbn:${isbn13}`,
    maxResults: "1",
    fields: "items(id,volumeInfo(title,subtitle,authors,publishedDate,publisher,language,industryIdentifiers))",
  });
  if (apiKey) params.set("key", apiKey);

  let resp: Response;
  try {
    resp = await fetch(`${VOLUMES_ENDPOINT}?${params.toString()}`, {
      headers: { "User-Agent": USER_AGENT },
      signal,
    });
  } catch {
    return null;
  }
  if (!resp.ok) return null;

  let data: GbSearchResult;
  try {
    data = (await resp.json()) as GbSearchResult;
  } catch {
    return null;
  }

  const item = data.items?.[0];
  if (!item) return null;

  /* If the first result is a general match, fetch the volume directly to get
     the more complete metadata (Google sometimes returns better data from /volumes/:id). */
  const vi = item.volumeInfo;
  if (!vi) return null;

  const title = vi.title?.trim() || undefined;
  const authors = (vi.authors ?? []).map((a) => a.trim()).filter(Boolean);

  const rawDate = vi.publishedDate ?? "";
  const yearMatch = rawDate.match(/(\d{4})/);
  const year = yearMatch ? Number(yearMatch[1]) : undefined;

  const publisher = vi.publisher?.trim() || undefined;
  const language = vi.language?.trim() || undefined;

  /* Prefer ISBN-13 from the result identifiers for verification. */
  const identifiers = vi.industryIdentifiers ?? [];
  const isbn13fromResult = identifiers.find((id) => id.type === "ISBN_13")?.identifier;
  const verifiedIsbn = isbn13fromResult ?? isbn13;

  return {
    title,
    authors: authors.length > 0 ? authors : undefined,
    year: year && year >= 1400 && year <= 2100 ? year : undefined,
    publisher,
    language,
    isbn13: verifiedIsbn,
  };
}
