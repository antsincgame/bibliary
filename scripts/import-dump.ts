import { QdrantClient } from "@qdrant/js-client-rest";
import { readFileSync } from "fs";

const QDRANT_URL = process.env.QDRANT_URL ?? "http://localhost:6333";
const COLLECTION = process.env.QDRANT_COLLECTION ?? "apps";
const VECTOR_SIZE = 384;

const dumpPath = process.argv[2];
if (!dumpPath) {
  console.error("Usage: npm run import-dump -- <path-to-dump.json>");
  process.exit(1);
}

const client = new QdrantClient({ url: QDRANT_URL, checkCompatibility: false });

const points: Array<{ id: string; vector: number[]; payload: Record<string, unknown> }> =
  JSON.parse(readFileSync(dumpPath, "utf-8"));

async function run() {
  const collections = await client.getCollections();
  const exists = collections.collections.some((c) => c.name === COLLECTION);

  if (!exists) {
    await client.createCollection(COLLECTION, {
      vectors: { size: VECTOR_SIZE, distance: "Cosine" },
    });
    await client.createPayloadIndex(COLLECTION, { field_name: "domain", field_schema: "keyword" });
    await client.createPayloadIndex(COLLECTION, { field_name: "tags", field_schema: "keyword" });
    console.log(`Collection "${COLLECTION}" created.`);
  } else {
    console.log(`Collection "${COLLECTION}" already exists — upserting.`);
  }

  const BATCH = 50;
  for (let i = 0; i < points.length; i += BATCH) {
    const batch = points.slice(i, i + BATCH);
    await client.upsert(COLLECTION, { wait: true, points: batch });
    console.log(`Upserted ${Math.min(i + BATCH, points.length)}/${points.length}`);
  }
  console.log("Done.");
}

run().catch((e) => { console.error(e); process.exit(1); });
