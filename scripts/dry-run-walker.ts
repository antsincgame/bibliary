/**
 * Dry-run walker validation script.
 *
 * Scans D:\Bibliarifull (or any path provided as first CLI arg) and reports:
 *   - accepted files (would be imported)
 *   - rejected files (filtered out)
 *   - cross-format dedup decisions
 *   - composite HTML book candidates
 *
 * Usage:
 *   npx tsx scripts/dry-run-walker.ts [folder]
 *   npx tsx scripts/dry-run-walker.ts D:\Bibliarifull
 */

import * as path from "path";
import { walkSupportedFiles, COMPOSITE_HTML_SENTINEL } from "../electron/lib/library/file-walker.js";
import { SUPPORTED_BOOK_EXTS } from "../electron/lib/library/types.js";
import { CrossFormatPreDedup } from "../electron/lib/library/cross-format-prededup.js";
import { detectCompositeHtmlDir } from "../electron/lib/library/composite-html-detector.js";

const folderArg = process.argv[2] ?? "D:\\Bibliarifull";
const folder = path.resolve(folderArg);

console.log(`\n=== DRY-RUN WALKER ===`);
console.log(`Scanning: ${folder}`);
console.log(`Timestamp: ${new Date().toISOString()}\n`);

const accepted: string[] = [];
const crossFormatSkipped: Array<{ file: string; keptBy: string }> = [];
const compositeHtmlBooks: Array<{ dir: string; fileCount: number; title: string }> = [];

const dedup = new CrossFormatPreDedup();
let total = 0;

const walker = walkSupportedFiles(folder, SUPPORTED_BOOK_EXTS, {
  detectCompositeHtml: true,
  maxDepth: 16,
});

for await (const filePath of walker) {
  total++;

  // Composite HTML sentinel
  if (filePath.startsWith(COMPOSITE_HTML_SENTINEL)) {
    const dirPath = filePath.slice(COMPOSITE_HTML_SENTINEL.length);
    const composite = await detectCompositeHtmlDir(dirPath);
    if (composite) {
      compositeHtmlBooks.push({
        dir: dirPath,
        fileCount: composite.files.length,
        title: composite.inferredTitle,
      });
      console.log(`[COMPOSITE] "${composite.inferredTitle}" — ${composite.files.length} HTML files`);
      console.log(`            ${path.relative(folder, dirPath)}`);
    }
    continue;
  }

  const decision = dedup.check(filePath);
  const rel = path.relative(folder, filePath);

  if (!decision.include) {
    const keptRel = decision.supersededBy ? path.relative(folder, decision.supersededBy) : "?";
    crossFormatSkipped.push({ file: rel, keptBy: keptRel });
    console.log(`[CROSS-DUP] SKIP: ${rel}`);
    console.log(`            → KEEP: ${keptRel}`);
  } else {
    accepted.push(rel);
  }
}

// Summary
console.log("\n" + "=".repeat(60));
console.log("SUMMARY");
console.log("=".repeat(60));
console.log(`Total files scanned:           ${total}`);
console.log(`Accepted (would import):       ${accepted.length}`);
console.log(`Cross-format dedup skipped:    ${crossFormatSkipped.length}`);
console.log(`Composite HTML books found:    ${compositeHtmlBooks.length}`);

console.log("\n--- Format breakdown of accepted files ---");
const byExt = new Map<string, number>();
for (const f of accepted) {
  const ext = path.extname(f).slice(1).toLowerCase();
  byExt.set(ext, (byExt.get(ext) ?? 0) + 1);
}
const sorted = [...byExt.entries()].sort((a, b) => b[1] - a[1]);
for (const [ext, count] of sorted) {
  console.log(`  .${ext.padEnd(6)} ${count}`);
}

if (compositeHtmlBooks.length > 0) {
  console.log("\n--- Composite HTML Books ---");
  for (const c of compositeHtmlBooks) {
    console.log(`  "${c.title}" (${c.fileCount} files)`);
    console.log(`    ${path.relative(folder, c.dir)}`);
  }
}

if (crossFormatSkipped.length > 0) {
  console.log("\n--- Cross-Format Dedup decisions ---");
  for (const { file, keptBy } of crossFormatSkipped) {
    console.log(`  SKIP: ${file}`);
    console.log(`  KEEP: ${keptBy}`);
  }
}

console.log("\n=== DRY-RUN COMPLETE ===");
