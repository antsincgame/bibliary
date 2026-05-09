import { promises as fs } from "fs";
import * as path from "path";
import { getLibraryRoot } from "./paths.js";
import { upsertBook, getBookById, findBookIdBySha256 } from "./cache-db.js";
import type { BookCatalogMeta, SupportedBookFormat } from "./types.js";
import { resolveHumanBookPaths } from "./storage-contract.js";
import { bookIdFromSha } from "./sha-stream.js";
import { extractSphereFromImportPath } from "./path-sanitizer.js";
import { registerForNearDup } from "./near-dup-detector.js";
import { registerForRevisionDedup } from "./revision-dedup.js";
import { detectCompositeHtmlDir, assembleCompositeHtmlBook } from "./composite-html-detector.js";
import type { ImportFolderOptions, ImportResult } from "./import-types.js";

/**
 * Import a Composite HTML Book (directory of HTML files assembled into one book).
 * Reuses the same storage/dedup logic as importBookFromFile but uses
 * assembleCompositeHtmlBook() instead of a file parser.
 */
export async function importCompositeHtmlBook(
  dirPath: string,
  opts: ImportFolderOptions,
  signal: AbortSignal,
): Promise<ImportResult> {
  const warnings: string[] = [];

  const compositeBook = await detectCompositeHtmlDir(dirPath);
  if (!compositeBook || compositeBook.files.length === 0) {
    return { outcome: "skipped", warnings: [`composite-html: empty or undetected dir ${path.basename(dirPath)}`] };
  }

  if (signal.aborted) {
    return { outcome: "skipped", warnings: ["composite-html: aborted"] };
  }

  let parsed;
  try {
    parsed = await assembleCompositeHtmlBook(compositeBook);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { outcome: "failed", warnings, error: `composite-html assemble failed: ${msg}` };
  }

  warnings.push(...(parsed.metadata.warnings ?? []));

  // Build a synthetic SHA from directory path (no single file SHA)
  const { createHash } = await import("crypto");
  const syntheticSha = createHash("sha256").update(`composite-html:${dirPath}`).digest("hex");
  const bookId = bookIdFromSha(syntheticSha);

  // Check SHA dedup
  const dupId = findBookIdBySha256(syntheticSha);
  if (dupId) {
    const existing = getBookById(dupId);
    return {
      outcome: "duplicate",
      bookId: dupId,
      meta: existing ?? undefined,
      duplicateReason: "duplicate_sha",
      existingBookId: dupId,
      existingBookTitle: existing?.title,
      warnings,
    };
  }

  const root = await getLibraryRoot();
  const importRoot = opts.importRoot;
  const sphere = importRoot ? extractSphereFromImportPath(dirPath, importRoot) : "unsorted";

  const wordCount = parsed.sections.reduce(
    (sum, s) => sum + s.paragraphs.reduce((ps, p) => ps + p.split(/\s+/).filter(Boolean).length, 0),
    0,
  );

  const meta: BookCatalogMeta = {
    id: bookId,
    sha256: syntheticSha,
    originalFile: path.basename(dirPath),
    originalFormat: "html" as SupportedBookFormat,
    sphere,
    title: compositeBook.inferredTitle,
    wordCount,
    chapterCount: parsed.sections.length,
    status: parsed.sections.length > 0 ? "imported" : "unsupported",
    warnings: warnings.length > 0 ? [...warnings] : undefined,
  };

  if (meta.status === "unsupported") {
    return {
      outcome: "skipped",
      warnings: [
        ...warnings,
        "composite-html: no sections assembled — not added to library",
      ],
    };
  }

  // Build markdown
  let markdown = `---\n`;
  markdown += `id: "${bookId}"\n`;
  markdown += `sha256: "${syntheticSha}"\n`;
  markdown += `originalFile: "${path.basename(dirPath)}"\n`;
  markdown += `originalFormat: html\n`;
  markdown += `sphere: "${sphere}"\n`;
  markdown += `title: "${compositeBook.inferredTitle.replace(/"/g, '\\"')}"\n`;
  markdown += `wordCount: ${wordCount}\n`;
  markdown += `chapterCount: ${parsed.sections.length}\n`;
  markdown += `status: ${meta.status}\n`;
  markdown += `---\n\n`;
  markdown += `# ${compositeBook.inferredTitle}\n\n`;
  for (const section of parsed.sections) {
    const heading = "#".repeat(section.level + 1);
    markdown += `${heading} ${section.title}\n\n`;
    for (const p of section.paragraphs) {
      markdown += `${p}\n\n`;
    }
  }

  const stored = await resolveHumanBookPaths(root, meta, dirPath, importRoot);
  await fs.mkdir(stored.bookDir, { recursive: true });

  try {
    await fs.writeFile(stored.mdPath, markdown, "utf-8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { outcome: "failed", warnings, error: `composite-html: write book.md failed: ${msg}` };
  }

  try {
    await fs.writeFile(stored.metaPath, JSON.stringify(meta, null, 2), "utf-8");
  } catch {
    warnings.push("meta.json write failed (non-critical)");
  }

  upsertBook(meta, stored.mdPath);
  registerForNearDup(meta, bookId);
  registerForRevisionDedup(meta);

  warnings.push(`composite-html: assembled ${compositeBook.files.length} files from ${path.basename(dirPath)}`);

  if (opts.onBookImported) {
    opts.onBookImported(meta);
  }

  return { outcome: "added", bookId, meta, warnings };
}
