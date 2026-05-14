import { embedPassage } from "../embedder/index.js";
import { insertChunk, linkChunkSiblings } from "../vectordb/chunks.js";

import type { SectionAwareChunk } from "./chunker.js";

/**
 * Phase Δb — L1 section chunk persistence.
 *
 * Carved out of extractor-bridge.ts during the Round-3 god-object
 * split. Responsibility: embed every L1 chunk text and persist to
 * chunks_vec + chunks meta atomically (insertChunk runs the two-write
 * transaction internally), then wire prev/next sibling pointers
 * within each section.
 *
 * Pre-extraction position: chunks land BEFORE the LLM extractor sees
 * them. A mid-extraction crash leaves the chunk tree intact for
 * resume; the queue can rerun extractChapter without re-embedding.
 *
 * Failures degrade gracefully: a chunk whose embedding throws gets a
 * null rowid and a warning; extraction still proceeds because the
 * narrative pipeline doesn't depend on chunks being vectorized.
 */

export interface EmbedAndStoreChunksResult {
  /** Vec rowids parallel to input array; null for failed-to-embed slots. */
  rowIds: Array<number | null>;
}

export async function embedAndStoreChunks(
  userId: string,
  bookId: string,
  chunks: SectionAwareChunk[],
  onWarning: (msg: string) => void,
  signal?: AbortSignal,
): Promise<Array<number | null>> {
  const rowIds: Array<number | null> = [];
  for (const chunk of chunks) {
    /* Post-merge fix: check abort BETWEEN chunks. Without this an
     * extraction cancel only stops at the next extractChapter() boundary
     * — the embed loop keeps consuming CPU through to the end of the
     * current unit's chunks. For 100-chunk chapters that's seconds of
     * wasted work after cancel. */
    if (signal?.aborted) {
      onWarning("chunk embed loop aborted by signal");
      /* Pad the remaining slots so the caller's parallel arrays stay
       * aligned to chunks.length. */
      while (rowIds.length < chunks.length) rowIds.push(null);
      break;
    }
    try {
      const embedding = await embedPassage(chunk.text);
      const rowid = insertChunk({
        userId,
        bookId,
        level: 1,
        embedding,
        text: chunk.text,
        pathTitles: chunk.pathTitles,
        sectionLevel: chunk.sectionLevel,
        sectionOrder: chunk.sectionOrder,
        partN: chunk.partN,
        partOf: chunk.partOf,
      });
      rowIds.push(rowid);
    } catch (err) {
      onWarning(
        `chunk embed failed (${err instanceof Error ? err.message : String(err)})`,
      );
      rowIds.push(null);
    }
  }

  /* Link siblings within the same section. Cross-section sibling
   * links would distort tree-proximity scoring later (Δf), so we
   * group by sectionOrder first. */
  const bySection = new Map<number, number[]>();
  for (let i = 0; i < chunks.length; i++) {
    const rowid = rowIds[i];
    if (rowid === null) continue;
    const key = chunks[i].sectionOrder;
    const arr = bySection.get(key) ?? [];
    arr.push(rowid);
    bySection.set(key, arr);
  }
  for (const arr of bySection.values()) {
    if (arr.length > 1) linkChunkSiblings(arr);
  }
  return rowIds;
}
