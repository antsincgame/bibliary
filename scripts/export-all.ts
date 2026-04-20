import { qdrant, COLLECTION_NAME } from "../src/qdrant.client.js";
import { writeFileSync } from "node:fs";

type PointPayload = {
  principle: string;
  explanation: string;
  domain: string;
  tags: string[];
};

async function exportAll(): Promise<void> {
  const all: Array<{ id: string | number } & PointPayload> = [];
  let offset: string | number | undefined = undefined;

  while (true) {
    const result = await qdrant.scroll(COLLECTION_NAME, {
      limit: 200,
      offset,
      with_payload: true,
      with_vector: false,
    });

    for (const p of result.points) {
      const payload = p.payload as unknown as PointPayload;
      all.push({
        id: p.id,
        principle: payload.principle,
        explanation: payload.explanation,
        domain: payload.domain,
        tags: payload.tags,
      });
    }

    if (!result.next_page_offset) break;
    offset = result.next_page_offset as string | number;
  }

  all.sort((a, b) => {
    if (a.domain !== b.domain) return a.domain.localeCompare(b.domain);
    return a.principle.localeCompare(b.principle);
  });

  const outPath = "data/_export-all.json";
  writeFileSync(outPath, JSON.stringify(all, null, 2), "utf8");
  console.log(`Exported ${all.length} points to ${outPath}`);

  const byDomain: Record<string, number> = {};
  for (const p of all) byDomain[p.domain] = (byDomain[p.domain] ?? 0) + 1;
  console.log("\nBy domain:");
  for (const [d, n] of Object.entries(byDomain).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${d}: ${n}`);
  }
}

exportAll().catch((e: unknown) => {
  console.error("Failed:", e);
  process.exit(1);
});
