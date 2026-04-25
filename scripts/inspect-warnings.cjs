const Database = require("better-sqlite3");
const fs = require("fs");

const db = new Database("release/dist-portable/data/bibliary-cache.db", { readonly: true });
const rows = db.prepare("SELECT title, original_format, md_path FROM books WHERE status = 'unsupported' AND original_format IN ('pdf','epub') ORDER BY original_format, title").all();

for (const row of rows) {
  try {
    const md = fs.readFileSync(row.md_path, "utf-8");
    const fmEnd = md.indexOf("\n---\n", 4);
    const fm = fmEnd > 0 ? md.slice(4, fmEnd) : "";
    const warningMatch = fm.match(/warnings:([\s\S]*?)(?=\n\w|\n---)/);
    const warnings = warningMatch ? warningMatch[1].trim() : "(none)";
    console.log(`\n[${row.original_format.toUpperCase()}] ${row.title.substring(0,60)}`);
    console.log(`  warnings: ${warnings}`);
  } catch (e) {
    console.log(`\n[${row.original_format.toUpperCase()}] ${row.title.substring(0,60)}`);
    console.log(`  ERROR reading file: ${e.message}`);
  }
}

db.close();
