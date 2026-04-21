/**
 * Internet Archive (archive.org).
 * advancedsearch.php — JSON-search; metadata API — список файлов на item.
 * License whitelist: ограничиваем до items, у которых rights/possible-copyright-status
 * содержит "public domain" или "creative commons".
 */

import {
  USER_AGENT,
  type BookCandidate,
  type BookFileVariant,
  type BookSource,
  type LicenseTag,
  type SearchOptions,
} from "../types.js";

const SEARCH_ENDPOINT = "https://archive.org/advancedsearch.php";
const META_ENDPOINT = "https://archive.org/metadata";
const DOWNLOAD_ENDPOINT = "https://archive.org/download";

interface AdvSearchDoc {
  identifier: string;
  title?: string | string[];
  creator?: string | string[];
  language?: string | string[];
  year?: number;
  /** Поля cookies; archive не возвращает score в advancedsearch */
  publicdate?: string;
  licenseurl?: string;
  rights?: string | string[];
  possible_copyright_status?: string;
}

interface MetadataResponse {
  files?: Array<{ name: string; format?: string; size?: string }>;
  metadata?: {
    licenseurl?: string;
    rights?: string;
    possible_copyright_status?: string;
  };
}

function detectLicense(doc: AdvSearchDoc): LicenseTag {
  const licenseurl = (doc.licenseurl ?? "").toLowerCase();
  if (licenseurl.includes("publicdomain") || licenseurl.includes("cc0")) return "cc0";
  if (licenseurl.includes("/by-sa/")) return "cc-by-sa";
  if (licenseurl.includes("/by/")) return "cc-by";
  const rights = String(Array.isArray(doc.rights) ? doc.rights.join(" ") : doc.rights ?? "").toLowerCase();
  if (rights.includes("public domain")) return "public-domain";
  const status = (doc.possible_copyright_status ?? "").toLowerCase();
  if (status.includes("not in copyright") || status.includes("no known")) return "public-domain";
  return "unknown";
}

function strFirst(v: string | string[] | undefined): string | undefined {
  if (!v) return undefined;
  return Array.isArray(v) ? v[0] : v;
}

async function fetchFiles(identifier: string, signal?: AbortSignal): Promise<BookFileVariant[]> {
  try {
    const resp = await fetch(`${META_ENDPOINT}/${encodeURIComponent(identifier)}`, {
      headers: { "User-Agent": USER_AGENT },
      signal,
    });
    if (!resp.ok) return [];
    const data = (await resp.json()) as MetadataResponse;
    const files = data.files ?? [];
    const variants: BookFileVariant[] = [];
    for (const f of files) {
      const name = f.name.toLowerCase();
      const sizeBytes = f.size ? Number(f.size) : undefined;
      if (name.endsWith(".epub")) {
        variants.push({ format: "epub", url: `${DOWNLOAD_ENDPOINT}/${identifier}/${f.name}`, sizeBytes });
      } else if (name.endsWith(".pdf")) {
        variants.push({ format: "pdf", url: `${DOWNLOAD_ENDPOINT}/${identifier}/${f.name}`, sizeBytes });
      } else if (name.endsWith(".txt") && !name.includes("_djvu")) {
        variants.push({ format: "txt", url: `${DOWNLOAD_ENDPOINT}/${identifier}/${f.name}`, sizeBytes });
      }
    }
    return variants;
  } catch {
    return [];
  }
}

async function search(opts: SearchOptions): Promise<BookCandidate[]> {
  const limit = opts.perSourceLimit ?? 10;
  const langClause = opts.language ? ` AND language:${opts.language}` : "";
  const q = `(${opts.query}) AND mediatype:texts${langClause}`;
  const params = new URLSearchParams();
  params.set("q", q);
  for (const f of [
    "identifier",
    "title",
    "creator",
    "language",
    "year",
    "licenseurl",
    "rights",
    "possible_copyright_status",
  ]) {
    params.append("fl[]", f);
  }
  params.set("rows", String(Math.min(limit * 3, 30)));
  params.set("page", "1");
  params.set("output", "json");

  const resp = await fetch(`${SEARCH_ENDPOINT}?${params.toString()}`, {
    headers: { "User-Agent": USER_AGENT },
    signal: opts.signal,
  });
  if (!resp.ok) throw new Error(`archive ${resp.status}`);
  const data = (await resp.json()) as { response?: { docs?: AdvSearchDoc[] } };
  const docs = data.response?.docs ?? [];

  const candidates: BookCandidate[] = [];
  for (const doc of docs) {
    const license = detectLicense(doc);
    /* License whitelist — отбрасываем unknown сразу */
    if (license === "unknown") continue;
    const formats = await fetchFiles(doc.identifier, opts.signal);
    if (formats.length === 0) continue;
    candidates.push({
      id: doc.identifier,
      sourceTag: "archive",
      title: strFirst(doc.title) ?? doc.identifier,
      authors: Array.isArray(doc.creator) ? doc.creator : doc.creator ? [doc.creator] : [],
      language: strFirst(doc.language)?.slice(0, 2),
      year: typeof doc.year === "number" ? doc.year : undefined,
      formats,
      license,
      webPageUrl: `https://archive.org/details/${doc.identifier}`,
    });
    if (candidates.length >= limit) break;
  }
  return candidates;
}

export const archiveSource: BookSource = { tag: "archive", search };
