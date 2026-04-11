import { qdrant, COLLECTION_NAME } from "./qdrant.client.js";
import { embedQuery } from "./embed.js";

async function search(query: string, limit = 10): Promise<void> {
  console.log(`Searching: "${query}"`);

  const vector = await embedQuery(query);

  const results = await qdrant.search(COLLECTION_NAME, {
    vector,
    limit,
    with_payload: true,
    score_threshold: 0.15,
  });

  if (results.length === 0) {
    console.log("No results found.");
    return;
  }

  console.log(`\nFound ${results.length} results:\n`);

  for (const result of results) {
    const p = result.payload as Record<string, unknown>;
    const score = (result.score * 100).toFixed(1);
    console.log(`[${score}%] ${p.principle}`);
    console.log(`  ${p.explanation}`);
    console.log(`  domain: ${p.domain} | tags: ${(p.tags as string[]).join(", ")}`);
    console.log();
  }
}

const query = process.argv[2];
if (!query) {
  console.error('Usage: npm run search -- "your query"');
  process.exit(1);
}

search(query).catch((e: unknown) => {
  console.error("Search failed:", e);
  process.exit(1);
});
