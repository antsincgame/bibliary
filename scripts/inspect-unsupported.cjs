const Database = require("better-sqlite3");
const db = new Database("release/dist-portable/data/bibliary-cache.db", { readonly: true });

const rows = db.prepare("SELECT title, original_format, word_count, md_path FROM books WHERE status = 'unsupported' ORDER BY original_format, title").all();
const total = db.prepare("SELECT COUNT(*) AS n FROM books").get();
const byStatus = db.prepare("SELECT status, COUNT(*) AS n FROM books GROUP BY status").all();

console.log("=== Status breakdown ===");
byStatus.forEach(r => console.log(r.status.padEnd(15), r.n));

console.log("\n=== UNSUPPORTED by format ===");
const byFmt = {};
rows.forEach(r => { byFmt[r.original_format] = (byFmt[r.original_format]||0)+1; });
Object.entries(byFmt).sort().forEach(([k,v]) => console.log(k.padEnd(8), v));

console.log("\n=== PDF/EPUB unsupported ===");
rows.filter(r => ["pdf","epub"].includes(r.original_format))
    .forEach(r => console.log(r.original_format.padEnd(6), r.title.substring(0,70)));

db.close();
