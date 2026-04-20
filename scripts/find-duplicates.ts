import { qdrant, COLLECTION_NAME } from "../src/qdrant.client.js";

const SIMILARITY_THRESHOLD = 0.88;
const BATCH_SIZE = 100;

type PointPayload = {
  principle: string;
  explanation: string;
  domain: string;
  tags: string[];
};

type ScoredPair = {
  a: { id: string | number; payload: PointPayload };
  b: { id: string | number; payload: PointPayload };
  score: number;
};

async function fetchAllPoints(): Promise<
  Array<{ id: string | number; vector: number[]; payload: PointPayload }>
> {
  const all: Array<{ id: string | number; vector: number[]; payload: PointPayload }> = [];
  let offset: string | number | undefined = undefined;

  while (true) {
    const result = await qdrant.scroll(COLLECTION_NAME, {
      limit: BATCH_SIZE,
      offset,
      with_payload: true,
      with_vector: true,
    });

    for (const p of result.points) {
      if (!p.vector || !Array.isArray(p.vector)) continue;
      all.push({
        id: p.id,
        vector: p.vector as number[],
        payload: p.payload as unknown as PointPayload,
      });
    }

    if (!result.next_page_offset) break;
    offset = result.next_page_offset as string | number;
  }

  return all;
}

async function findDuplicates(): Promise<void> {
  console.log(`Fetching all points from ${COLLECTION_NAME}...`);
  const points = await fetchAllPoints();
  console.log(`Loaded ${points.length} points.`);

  const seenPairs = new Set<string>();
  const duplicates: ScoredPair[] = [];

  for (const point of points) {
    const results = await qdrant.search(COLLECTION_NAME, {
      vector: point.vector,
      limit: 5,
      with_payload: true,
      score_threshold: SIMILARITY_THRESHOLD,
    });

    for (const r of results) {
      if (r.id === point.id) continue;
      const pairKey = [String(point.id), String(r.id)].sort().join("::");
      if (seenPairs.has(pairKey)) continue;
      seenPairs.add(pairKey);

      duplicates.push({
        a: { id: point.id, payload: point.payload },
        b: { id: r.id, payload: r.payload as unknown as PointPayload },
        score: r.score,
      });
    }
  }

  duplicates.sort((x, y) => y.score - x.score);

  console.log(`\nFound ${duplicates.length} candidate pairs above ${SIMILARITY_THRESHOLD} similarity:\n`);

  for (const [i, pair] of duplicates.entries()) {
    const pct = (pair.score * 100).toFixed(1);
    console.log(`--- Pair ${i + 1} [${pct}%] ---`);
    console.log(`A [${pair.a.id}] (${pair.a.payload.domain})`);
    console.log(`   principle: ${pair.a.payload.principle}`);
    console.log(`   tags: ${pair.a.payload.tags.join(", ")}`);
    console.log(`B [${pair.b.id}] (${pair.b.payload.domain})`);
    console.log(`   principle: ${pair.b.payload.principle}`);
    console.log(`   tags: ${pair.b.payload.tags.join(", ")}`);
    console.log();
  }
}

findDuplicates().catch((e: unknown) => {
  console.error("Failed:", e);
  process.exit(1);
});
