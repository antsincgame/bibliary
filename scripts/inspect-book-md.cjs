const Database = require("better-sqlite3");
const fs = require("fs");

const db = new Database("release/dist-portable/data/bibliary-cache.db", { readonly: true });

// Check first 200 chars of each unsupported book's md
const rows = db.prepare("SELECT title, original_format, md_path FROM books WHERE status = 'unsupported' AND original_format IN ('pdf','epub') ORDER BY original_format, title").all();

for (const row of rows) {
  try {
    const md = fs.readFileSync(row.md_path, "utf-8");
    const first = md.substring(0, 500);
    console.log(`\n=== [${row.original_format}] ${row.title.substring(0,60)} ===`);
    console.log(first);
    console.log("...(total chars: " + md.length + ")");
  } catch (e) {
    console.log(`ERROR: ${row.title}: ${e.message}`);
  }
}

db.close();
