#!/usr/bin/env node
const path = require("path");
const fs = require("fs");

const dbPath = path.resolve(process.cwd(), "data", "bibliary-cache.db");
if (!fs.existsSync(dbPath)) {
  console.error("[diagnose] cache-db not found at:", dbPath);
  process.exit(1);
}

let DatabaseSync;
try {
  ({ DatabaseSync } = require("node:sqlite"));
} catch (err) {
  console.error("[diagnose] node:sqlite not available — needs Node >= 22.5 with --experimental-sqlite");
  console.error("  hint: rerun with `node --experimental-sqlite scripts/diagnose-import-state.cjs`");
  process.exit(2);
}

const db = new DatabaseSync(dbPath, { readOnly: true });
db.prepare = ((orig) => orig)(db.prepare.bind(db));
function run(sql) { return db.prepare(sql).all(); }
function one(sql) { return db.prepare(sql).get(); }

console.log("=== bibliary-cache.db ===");
console.log("path:", dbPath);
console.log("size:", fs.statSync(dbPath).size, "bytes");

const tables = run("SELECT name FROM sqlite_master WHERE type='table'");
console.log("\n=== Tables ===");
console.log(tables.map((t) => t.name).join(", "));

if (tables.find((t) => t.name === "books")) {
  const totalBooks = one("SELECT COUNT(*) AS n FROM books").n;
  console.log("\n=== books total ===", totalBooks);

  const byStatus = run("SELECT status, COUNT(*) AS n FROM books GROUP BY status ORDER BY n DESC");
  console.log("\n=== by status ===");
  for (const row of byStatus) console.log(`  ${row.status}: ${row.n}`);

  const cols = run("PRAGMA table_info(books)").map((c) => c.name);
  console.log("\n=== columns ===");
  console.log(cols.join(", "));

  if (cols.includes("original_format")) {
    const byFormat = run("SELECT original_format AS format, COUNT(*) AS n FROM books GROUP BY original_format ORDER BY n DESC");
    console.log("\n=== by format ===");
    for (const row of byFormat) console.log(`  ${row.format}: ${row.n}`);
  }

  const lastError = run("SELECT id, title, status, original_format, last_error FROM books WHERE last_error IS NOT NULL AND last_error != '' ORDER BY id LIMIT 30");
  if (lastError.length > 0) {
    console.log("\n=== books with last_error (top 30) ===");
    for (const row of lastError) {
      console.log(`  [${row.status}] [${row.original_format}] ${(row.title || "").slice(0, 50)}`);
      console.log(`     :: ${(row.last_error || "").slice(0, 300)}`);
    }
  } else {
    console.log("\n=== no last_error rows ===");
  }

  console.log("\n=== ALL books (status / format / words / chapters / title) ===");
  const all = run("SELECT id, title, status, original_format, word_count, chapter_count, md_path FROM books ORDER BY status, ROWID");
  for (const r of all) {
    console.log(`  [${r.status}] [${r.original_format}] ${r.word_count}w/${r.chapter_count}c  ${(r.title || "").slice(0, 70)}`);
    console.log(`     md: ${r.md_path}`);
  }

  console.log("\n=== Warnings from book_tags? ===");
  const tagsTbl = run("PRAGMA table_info(book_tags)").map((c) => c.name);
  console.log(`book_tags cols: ${tagsTbl.join(", ")}`);

  console.log("\n=== DjVu books — md content sample ===");
  const djvuBooks = run("SELECT id, title, status, word_count, chapter_count, md_path FROM books WHERE original_format = 'djvu'");
  for (const b of djvuBooks) {
    console.log(`\n--- [${b.status}] ${(b.title || "").slice(0, 60)} (${b.word_count}w/${b.chapter_count}c) ---`);
    console.log(`md: ${b.md_path}`);
    if (b.md_path && fs.existsSync(b.md_path)) {
      try {
        const content = fs.readFileSync(b.md_path, "utf-8");
        const lines = content.split("\n").slice(0, 30);
        console.log(lines.join("\n"));
      } catch (err) {
        console.log(`  read failed: ${err.message}`);
      }
    } else {
      console.log("  md_path missing or file does not exist");
    }
  }
}

db.close();
