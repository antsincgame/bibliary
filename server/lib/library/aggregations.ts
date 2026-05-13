import { Query } from "node-appwrite";

import { COLLECTIONS, getAppwrite, type RawDoc } from "../appwrite.js";

export interface CollectionGroup {
  label: string;
  count: number;
  bookIds: string[];
}

export interface TagCount {
  tag: string;
  count: number;
}

type AggregateRow = RawDoc & {
  userId: string;
  domain?: string;
  author?: string;
  authorRu?: string;
  tags?: string[];
  tagsRu?: string[];
  year?: number;
};

const PAGE_SIZE = 100;
const MAX_BOOKS_PER_AGGREGATE = 5000;

/**
 * Stream user's books in pages, accumulating only the fields we need for
 * aggregation (server-side `Query.select` keeps payload tiny). Hard-capped
 * at MAX_BOOKS_PER_AGGREGATE so an exploding library can't OOM the route.
 */
async function fetchAllUserBooks<T extends AggregateRow = AggregateRow>(
  userId: string,
  selectFields: string[],
): Promise<T[]> {
  const { databases, databaseId } = getAppwrite();
  const out: T[] = [];
  let offset = 0;
  /* Always need $id for bookIds and `userId` for the per-user filter. */
  const selects = Array.from(new Set(["$id", "userId", ...selectFields]));

  while (out.length < MAX_BOOKS_PER_AGGREGATE) {
    const page = await databases.listDocuments<T>(databaseId, COLLECTIONS.books, [
      Query.equal("userId", userId),
      Query.select(selects),
      Query.limit(PAGE_SIZE),
      Query.offset(offset),
    ]);
    out.push(...page.documents);
    if (page.documents.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return out;
}

function pushTo(map: Map<string, string[]>, label: string, id: string): void {
  const list = map.get(label);
  if (list) list.push(id);
  else map.set(label, [id]);
}

function mapToGroups(map: Map<string, string[]>): CollectionGroup[] {
  return Array.from(map.entries())
    .map(([label, ids]) => ({ label, count: ids.length, bookIds: ids }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

export async function queryByDomain(userId: string): Promise<CollectionGroup[]> {
  const rows = await fetchAllUserBooks(userId, ["domain"]);
  const map = new Map<string, string[]>();
  for (const r of rows) {
    pushTo(map, r.domain && r.domain.trim() ? r.domain : "unclassified", r.$id);
  }
  return mapToGroups(map);
}

function pickAuthor(row: AggregateRow, locale: "ru" | "en"): string {
  const ru = row.authorRu?.trim();
  const en = row.author?.trim();
  if (locale === "ru") {
    return ru || en || "Unknown Author";
  }
  return en || ru || "Unknown Author";
}

export async function queryByAuthor(
  userId: string,
  locale: "ru" | "en" = "en",
): Promise<CollectionGroup[]> {
  const rows = await fetchAllUserBooks(userId, ["author", "authorRu"]);
  const map = new Map<string, string[]>();
  for (const r of rows) {
    pushTo(map, pickAuthor(r, locale), r.$id);
  }
  return mapToGroups(map);
}

export async function queryByYear(userId: string): Promise<CollectionGroup[]> {
  const rows = await fetchAllUserBooks(userId, ["year"]);
  const known = new Map<string, string[]>();
  const unknown: string[] = [];
  for (const r of rows) {
    if (typeof r.year === "number") {
      pushTo(known, String(r.year), r.$id);
    } else {
      unknown.push(r.$id);
    }
  }
  const groups = Array.from(known.entries())
    .map(([label, ids]) => ({ label, count: ids.length, bookIds: ids }))
    /* Year groups sort DESC by year (newest first), not by count. */
    .sort((a, b) => Number(b.label) - Number(a.label));
  if (unknown.length > 0) {
    groups.push({ label: "Unknown Year", count: unknown.length, bookIds: unknown });
  }
  return groups;
}

export async function queryByTag(
  userId: string,
  locale: "ru" | "en" = "en",
): Promise<CollectionGroup[]> {
  const rows = await fetchAllUserBooks(userId, ["tags", "tagsRu"]);
  const map = new Map<string, string[]>();
  for (const r of rows) {
    const src = locale === "ru" ? r.tagsRu ?? [] : r.tags ?? [];
    for (const tag of src) {
      if (typeof tag === "string" && tag.trim()) {
        pushTo(map, tag.trim(), r.$id);
      }
    }
  }
  return mapToGroups(map);
}

export async function queryTagStats(
  userId: string,
  locale: "ru" | "en" = "en",
): Promise<TagCount[]> {
  const rows = await fetchAllUserBooks(userId, ["tags", "tagsRu"]);
  const counts = new Map<string, number>();
  for (const r of rows) {
    const src = locale === "ru" ? r.tagsRu ?? [] : r.tags ?? [];
    for (const tag of src) {
      if (typeof tag === "string" && tag.trim()) {
        const key = tag.trim();
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
  }
  return Array.from(counts.entries())
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}
