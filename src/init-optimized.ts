import { qdrant } from "./qdrant.client.js";
import "dotenv/config";

const COLLECTION = process.argv[2] ?? process.env.QDRANT_COLLECTION ?? "concepts";

async function init(): Promise<void> {
  const cols = await qdrant.getCollections();
  const exists = cols.collections.some((c) => c.name === COLLECTION);

  if (exists) {
    await qdrant.deleteCollection(COLLECTION);
    console.log(`Deleted old "${COLLECTION}"`);
  }

  await qdrant.createCollection(COLLECTION, {
    vectors: {
      size: 384,
      distance: "Cosine",
      on_disk: false,
      datatype: "float32",
    },
    hnsw_config: { m: 24, ef_construct: 256 },
    optimizers_config: {
      indexing_threshold: 0,
    },
  });

  await qdrant.createPayloadIndex(COLLECTION, {
    field_name: "domain",
    field_schema: "keyword",
  });

  await qdrant.createPayloadIndex(COLLECTION, {
    field_name: "tags",
    field_schema: "keyword",
  });

  await qdrant.createPayloadIndex(COLLECTION, {
    field_name: "chapter",
    field_schema: "keyword",
  });

  const info = await qdrant.getCollection(COLLECTION);
  console.log(`Collection "${COLLECTION}" created`);
  console.log(`  vectors: ${info.config.params.vectors?.size} dims, Cosine`);
  console.log(`  hnsw: m=${info.config.hnsw_config.m}, ef_construct=${info.config.hnsw_config.ef_construct}`);
  console.log(`  indexes: domain, tags, chapter`);
}

init().catch((e: unknown) => {
  console.error("Failed:", e);
  process.exit(1);
});
