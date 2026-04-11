import { qdrant, COLLECTION_NAME } from "./qdrant.client.js";
import { VECTOR_SIZE } from "./embed.js";

async function initCollection(): Promise<void> {
  const collections = await qdrant.getCollections();
  const exists = collections.collections.some((c) => c.name === COLLECTION_NAME);

  if (exists) {
    console.log(`Collection "${COLLECTION_NAME}" already exists.`);
    return;
  }

  await qdrant.createCollection(COLLECTION_NAME, {
    vectors: { size: VECTOR_SIZE, distance: "Cosine" },
  });

  await qdrant.createPayloadIndex(COLLECTION_NAME, {
    field_name: "domain",
    field_schema: "keyword",
  });

  await qdrant.createPayloadIndex(COLLECTION_NAME, {
    field_name: "tags",
    field_schema: "keyword",
  });

  console.log(`Collection "${COLLECTION_NAME}" created.`);
}

initCollection().catch((e: unknown) => {
  console.error("Failed:", e);
  process.exit(1);
});
