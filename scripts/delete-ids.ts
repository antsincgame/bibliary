import { qdrant, COLLECTION_NAME } from "../src/qdrant.client.js";

// IDs replaced by merged chunks or confirmed as subsets
const IDS_TO_DELETE = [
  // Pair 1: home hero 4q vs 3q → merged
  "14678a10-97dc-5fb0-994f-cdea0775be45",
  "7ec1038e-5bf4-513d-81ea-51ae44ee8dec",
  // Pair 2: icons+labels ×2 → merged
  "71b12c33-689c-56c0-8517-2af7f20b4b32",
  "c551ad89-4b33-5818-9d3e-3c17c0d13ef9",
  // Pair 4: scannable formatting ×2 → merged
  "3ea632e0-d5b9-5ab6-b8ec-1193b9634739",
  "bb7b5ef1-7734-5de7-b8db-bad7d96bcc68",
  // Pair 6: keyword cannibalization ×2 → merged
  "2e8cba5a-e639-53d7-a9fc-cb3d8c5fe337",
  "44d61cd3-5b63-5f85-ae0d-125cc5db8a7a",
  // Pair 7: pricing plan emphasis ×2 → merged
  "6c308ea3-6749-51dd-9352-5ccbee988ae6",
  "fca18109-8122-5b95-bb92-20c3de367479",
  // Pair 8: FAQ+Speakable vs Speakable-only → delete Speakable-only subset
  "adad07e8-f933-58f9-beb3-570dbf635e40",
  // Pair 13: color alone contrast ×2 → merged
  "c812327f-bea4-54c6-9e9d-d4a573340c8b",
  "d493d425-e3e8-5b13-92c9-f0a42d8a9069",
  // Pair 14: shareable milestones ×2 → merged
  "5819e63d-e371-5e03-abb8-d697eaefc16a",
  "ef8f3320-a777-555a-8a66-b5e9b9bfd12a",
  // Pair 18: canonical ×2 → merged
  "15120108-4772-5d76-9315-30541a516ffd",
  "5435d046-efea-5e79-b47e-24e9aa5f114c",
  // Pair 29: visual emphasis sparingly ×2 → merged
  "0d0ed3e1-217e-50f4-aa72-777bda967931",
  "32b44696-ff9b-5caf-a9bb-0aaa83574386",
  // Pair 37: tagline not motto ×2 → merged
  "1a4a3bda-12c1-5ecf-ae02-23852411f289",
  "9e21e704-2e8e-50d0-ae0c-100c7c790fd0",
];

async function deleteOldPoints(): Promise<void> {
  console.log(`Deleting ${IDS_TO_DELETE.length} old points from ${COLLECTION_NAME}...`);

  await qdrant.delete(COLLECTION_NAME, {
    points: IDS_TO_DELETE,
  });

  console.log("Deleted successfully.");

  const info = await qdrant.getCollection(COLLECTION_NAME);
  console.log(`Collection now has ${info.points_count} points.`);
}

deleteOldPoints().catch((e: unknown) => {
  console.error("Failed:", e);
  process.exit(1);
});
