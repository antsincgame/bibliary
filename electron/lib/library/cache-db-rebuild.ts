import { promises as fs } from "fs";
import * as path from "path";
import { parseFrontmatter } from "./md-converter.js";
import { getLibraryRoot } from "./paths.js";
import type { BookCatalogMeta, BookStatus } from "./types.js";
import { openCacheDb } from "./cache-db-connection.js";
import { upsertBook, deleteBook } from "./cache-db-mutations.js";

/**
 * Пересобирает кэш из всех .md файлов в library/ (рекурсивный обход).
 *
 * Структура v2: data/library/{Sphere}/{Author_Title}/{Title}.md
 * Пропускает .blobs/ (скрытый CAS).
 */
export async function rebuildFromFs(): Promise<{ scanned: number; ingested: number; skipped: number; errors: string[] }> {
  const errors: string[] = [];
  let scanned = 0;
  let ingested = 0;
  let skipped = 0;

  const root = await getLibraryRoot();

  async function walkDir(dir: string): Promise<void> {
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch (err) {
      errors.push(`rebuildFromFs: cannot read ${dir}: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    for (const entry of entries) {
      if (entry === ".blobs") continue;
      const full = path.join(dir, entry);
      let stat;
      try {
        stat = await fs.stat(full);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        await walkDir(full);
        continue;
      }

      if (!entry.endsWith(".md")) continue;
      if (entry === "README.md") continue;

      try {
        const md = await fs.readFile(full, "utf-8");
        scanned += 1;
        const meta = parseFrontmatter(md);
        if (!meta || !meta.id || !meta.sha256) {
          skipped += 1;
          continue;
        }
        const fullMeta: BookCatalogMeta = {
          id: meta.id,
          sha256: meta.sha256,
          title: meta.title ?? entry.replace(/\.md$/, ""),
          author: meta.author,
          titleEn: meta.titleEn,
          authorEn: meta.authorEn,
          year: meta.year,
          isbn: meta.isbn,
          publisher: meta.publisher,
          originalFile: meta.originalFile ?? "",
          originalFormat: (meta.originalFormat ?? "txt") as BookCatalogMeta["originalFormat"],
          sourceArchive: meta.sourceArchive,
          sphere: meta.sphere as string | undefined,
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
        upsertBook(fullMeta, full);
        ingested += 1;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("ENOENT")) errors.push(`${full}: ${msg}`);
        skipped += 1;
      }
    }
  }

  await walkDir(root);
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
