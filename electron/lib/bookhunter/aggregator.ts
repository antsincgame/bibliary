/**
 * Phase 3.0 — BookHunter aggregator.
 * Параллельный fan-out по 4 источникам, дедупликация по (title|firstAuthor),
 * ранжирование с приоритетом по license + наличию EPUB/TXT (легче парсятся).
 */

import { ALLOWED_LICENSES, type BookCandidate, type BookSource, type SearchOptions } from "./types.js";
import { gutendexSource } from "./sources/gutendex.js";
import { archiveSource } from "./sources/archive.js";
import { openLibrarySource } from "./sources/openlibrary.js";
import { arxivSource } from "./sources/arxiv.js";

const ALL_SOURCES: Record<BookCandidate["sourceTag"], BookSource> = {
  gutendex: gutendexSource,
  archive: archiveSource,
  openlibrary: openLibrarySource,
  arxiv: arxivSource,
};

function dedupKey(c: BookCandidate): string {
  const title = c.title.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 80);
  const author = (c.authors[0] ?? "").trim().toLowerCase().replace(/\s+/g, " ").slice(0, 60);
  return `${title}|${author}`;
}

const LICENSE_RANK: Record<string, number> = {
  "public-domain": 5,
  "cc0": 5,
  "cc-by": 4,
  "cc-by-sa": 4,
  "open-access": 3,
  "unknown": 0,
};

const FORMAT_RANK: Record<string, number> = {
  txt: 5,
  epub: 4,
  fb2: 3,
  docx: 2,
  pdf: 1,
};

function rank(c: BookCandidate): number {
  const license = LICENSE_RANK[c.license] ?? 0;
  const fmtRank = c.formats.reduce((m, f) => Math.max(m, FORMAT_RANK[f.format] ?? 0), 0);
  const search = Math.log10((c.searchScore ?? 0) + 1);
  const yearBonus = c.year && c.year > 1900 ? 1 : 0;
  return license * 10 + fmtRank * 3 + search + yearBonus;
}

export async function aggregateSearch(opts: SearchOptions): Promise<BookCandidate[]> {
  const enabled = (opts.sources ?? ["gutendex", "archive", "openlibrary", "arxiv"])
    .map((tag) => ALL_SOURCES[tag])
    .filter(Boolean);

  const results = await Promise.allSettled(enabled.map((src) => src.search(opts)));
  const merged: BookCandidate[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") merged.push(...r.value);
    else console.warn("[bookhunter] source failed:", r.reason);
  }

  /* License whitelist */
  const allowed = merged.filter((c) => ALLOWED_LICENSES.has(c.license));

  /* Dedup */
  const seen = new Map<string, BookCandidate>();
  for (const c of allowed) {
    const k = dedupKey(c);
    const cur = seen.get(k);
    if (!cur) {
      seen.set(k, c);
      continue;
    }
    /* Если ранг новый выше — заменяем */
    if (rank(c) > rank(cur)) seen.set(k, c);
  }

  return Array.from(seen.values()).sort((a, b) => rank(b) - rank(a));
}
