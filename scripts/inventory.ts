import { readFileSync, writeFileSync } from "node:fs";

type PointPayload = {
  id: string;
  principle: string;
  explanation: string;
  domain: string;
  tags: string[];
};

const data = JSON.parse(readFileSync("data/_export-all.json", "utf8")) as PointPayload[];

const lines: string[] = [];
lines.push(`# Inventory: ${data.length} points`);
lines.push("");

const byDomain = new Map<string, PointPayload[]>();
for (const p of data) {
  if (!byDomain.has(p.domain)) byDomain.set(p.domain, []);
  byDomain.get(p.domain)!.push(p);
}

for (const [domain, points] of [...byDomain.entries()].sort()) {
  lines.push(`## ${domain.toUpperCase()} (${points.length})`);
  lines.push("");
  for (const p of points) {
    const eLen = p.explanation.length;
    const pLen = p.principle.length;
    lines.push(`[${p.id.slice(0, 8)}] P${pLen} E${eLen} — ${p.principle}`);
    lines.push(`    tags: ${p.tags.join(", ")}`);
  }
  lines.push("");
}

writeFileSync("data/_inventory.md", lines.join("\n"), "utf8");
console.log(`Written data/_inventory.md (${lines.length} lines)`);
