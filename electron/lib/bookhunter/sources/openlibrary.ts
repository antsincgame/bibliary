/**
 * Open Library (openlibrary.org) — search.json. В основном даёт метаданные;
 * прямые ссылки на файлы только когда есть IA-связь (`ia` поле). Для
 * читаемых работ собираем IA-link в формат-урлы.
 */

import { USER_AGENT, type BookCandidate, type BookFileVariant, type BookSource, type SearchOptions } from "../types.js";

const SEARCH_ENDPOINT = "https://openlibrary.org/search.json";
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

export const openLibrarySource: BookSource = { tag: "openlibrary", search };
