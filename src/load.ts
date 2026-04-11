import { readFileSync } from "node:fs";
import { v5 as uuidv5 } from "uuid";
import { qdrant, COLLECTION_NAME } from "./qdrant.client.js";
import { ConceptArraySchema } from "./schema.js";
import { embedPassage } from "./embed.js";

const NAMESPACE = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

function conceptId(principle: string): string {
  return uuidv5(principle.toLowerCase().trim(), NAMESPACE);
}

async function loadConcepts(filePath: string): Promise<void> {
  const raw = readFileSync(filePath, "utf-8");
  const parsed: unknown = JSON.parse(raw);

  const result = ConceptArraySchema.safeParse(parsed);
  if (!result.success) {
    console.error("Validation failed:");
    for (const issue of result.error.issues) {
      console.error(`  [${issue.path.join(".")}] ${issue.message}`);
    }
    process.exit(1);
  }

  const concepts = result.data;
  console.log(`Validated ${concepts.length} concepts from ${filePath}`);

  for (let i = 0; i < concepts.length; i++) {
    const concept = concepts[i];
    const textToEmbed = `${concept.principle}. ${concept.explanation}`;
    const id = conceptId(concept.principle);

    console.log(`[${i + 1}/${concepts.length}] ${concept.principle}`);
    const vector = await embedPassage(textToEmbed);

    await qdrant.upsert(COLLECTION_NAME, {
      wait: true,
      points: [{
        id,
        vector,
        payload: {
          principle: concept.principle,
          explanation: concept.explanation,
          domain: concept.domain,
          tags: concept.tags,
        },
      }],
    });
  }

  console.log(`Done. ${concepts.length} concepts loaded.`);
}

const filePath = process.argv[2];
if (!filePath) {
  console.error("Usage: npm run load -- <path-to-concepts.json>");
  process.exit(1);
}

loadConcepts(filePath).catch((e: unknown) => {
  console.error("Load failed:", e);
  process.exit(1);
});
