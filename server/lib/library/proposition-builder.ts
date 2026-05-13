import { embedPassage } from "../embedder/index.js";
import { insertChunk } from "../vectordb/chunks.js";

import type {
  DeltaKnowledge,
  TopologyRelation,
} from "../../../shared/llm/extractor-schema.js";

/**
 * Phase Δe — L0 proposition builder.
 *
 * Carved out of extractor-bridge.ts during the Round-3 god-object
 * split. Responsibility: turn each topology triple from an accepted
 * DeltaKnowledge into a natural-language sentence, embed it
 * independently, and store as level=0 chunk parented at the source
 * L1.
 *
 * Lazy by design — only the high-quality books (gated upstream on
 * qualityScore + isFictionOrWater) hit this path. The pipeline is
 * tolerant of per-triple failures: one bad embed just gets a warning
 * and the loop continues.
 */

const TEXT_HARD_CAP = 400;
const MIN_USEFUL_LENGTH = 10;

export function buildPropositionText(rel: TopologyRelation): string {
  const subj = rel.subject.trim();
  /* Underscores in predicates ("launched_with") get spaced so the
   * embedder sees a real sentence. */
  const pred = rel.predicate.trim().replace(/_/g, " ");
  const obj = rel.object.trim();
  return `${subj} ${pred} ${obj}.`.slice(0, TEXT_HARD_CAP);
}

/**
 * Iterate delta.relations, dedup within the delta by lowercased text,
 * embed each survivor, insert as level=0 chunk linked to parentChunkRowId.
 *
 * Per-relation embed/insert failures only warn — extraction has
 * already succeeded by this point; L0 is supplementary signal.
 */
export async function embedAndStorePropositions(
  userId: string,
  bookId: string,
  parentChunkRowId: number | null,
  delta: DeltaKnowledge,
  onWarning: (msg: string) => void,
): Promise<number> {
  const seen = new Set<string>();
  let inserted = 0;
  for (let i = 0; i < delta.relations.length; i++) {
    const rel = delta.relations[i];
    const text = buildPropositionText(rel);
    if (text.length < MIN_USEFUL_LENGTH) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      const embedding = await embedPassage(text);
      insertChunk({
        userId,
        bookId,
        level: 0,
        embedding,
        text,
        pathTitles: [], // propositions aren't chapter-bound
        sectionLevel: 0,
        sectionOrder: 0,
        partN: i + 1,
        partOf: delta.relations.length,
        parentVecRowId: parentChunkRowId,
      });
      inserted += 1;
    } catch (err) {
      onWarning(
        `L0 proposition embed/insert failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return inserted;
}
