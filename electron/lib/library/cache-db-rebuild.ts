import { promises as fs } from "fs";
import * as path from "path";
import { parseFrontmatter } from "./md-converter.js";
import { getLibraryRoot } from "./paths.js";
import type { BookCatalogMeta, BookStatus } from "./types.js";
import { openCacheDb } from "./cache-db-connection.js";
import { upsertBook, deleteBook } from "./cache-db-mutations.js";

/**
 * Пересобирает кэш из всех `book.md` в library/.
 *
 * Идемпотентно: каждая книга через UPSERT, теги переписываются.
 * Не удаляет книги которых нет на диске -- caller вызывает `pruneMissing()`.
 */
export async function rebuildFromFs(): Promise<{ scanned: number; ingested: number; skipped: number; errors: string[] }> {
  const errors: string[] = [];
  let scanned = 0;
  let ingested = 0;
  let skipped = 0;

  const root = await getLibraryRoot();
  let entries: string[] = [];
  try {
    entries = await fs.readdir(root);
  } catch (err) {
    errors.push(`rebuildFromFs: cannot read ${root}: ${err instanceof Error ? err.message : String(err)}`);
    return { scanned, ingested, skipped, errors };
  }

  for (const entry of entries) {
    const dir = path.join(root, entry);
    let stat;
    try {
      stat = await fs.stat(dir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    const mdPath = path.join(dir, "book.md");
    try {
      const md = await fs.readFile(mdPath, "utf-8");
      scanned += 1;
      const meta = parseFrontmatter(md);
      if (!meta || !meta.id || !meta.sha256) {
        skipped += 1;
        continue;
      }
      const fullMeta: BookCatalogMeta = {
        id: meta.id,
        sha256: meta.sha256,
        title: meta.title ?? entry,
        author: meta.author,
        titleEn: meta.titleEn,
        authorEn: meta.authorEn,
        year: meta.year,
        isbn: meta.isbn,
        publisher: meta.publisher,
        originalFile: meta.originalFile ?? "",
        originalFormat: (meta.originalFormat ?? "txt") as BookCatalogMeta["originalFormat"],
        sourceArchive: meta.sourceArchive,
        wordCount: meta.wordCount ?? 0,
        chapterCount: meta.chapterCount ?? 0,
        domain: meta.domain,
        tags: meta.tags,
        qualityScore: meta.qualityScore,
        conceptualDensity: meta.conceptualDensity,
        originality: meta.originality,
        isFictionOrWater: meta.isFictionOrWater,
        verdictReason: meta.verdictReason,
        evaluatorModel: meta.evaluatorModel,
        evaluatedAt: meta.evaluatedAt,
        evaluatorReasoning: undefined,
        conceptsExtracted: meta.conceptsExtracted,
        conceptsAccepted: meta.conceptsAccepted,
        status: (meta.status ?? "imported") as BookStatus,
        warnings: meta.warnings,
      };
      upsertBook(fullMeta, mdPath);
      ingested += 1;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("ENOENT")) errors.push(`${entry}: ${msg}`);
      skipped += 1;
    }
  }
  return { scanned, ingested, skipped, errors };
}

export async function pruneMissing(): Promise<number> {
  const db = openCacheDb();
  const rows = db.prepare("SELECT id, md_path FROM books").all() as Array<{ id: string; md_path: string }>;
  let removed = 0;
  for (const r of rows) {
    try {
      await fs.access(r.md_path);
    } catch {
      deleteBook(r.id);
      removed += 1;
    }
  }
  return removed;
}
