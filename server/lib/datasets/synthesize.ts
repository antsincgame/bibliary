import { Query } from "../store/query.js";

import { COLLECTIONS, getDatastore, type RawDoc } from "../datastore.js";
import type { DeltaKnowledge } from "../../../shared/llm/extractor-schema.js";

/**
 * Pure synthesizer logic для concepts collection → output format.
 *
 * MVP: JSONL only — one DeltaKnowledge per line, plus origin metadata
 * (bookId, conceptId, collectionName, createdAt) для traceability в
 * downstream pipeline.
 *
 * Будущие форматы (отдельные коммиты):
 *   - sharegpt: turn-pair conversations через synthesizer LLM role
 *     ("explain concept X" → DeltaKnowledge.essence/proof)
 *   - chatml:   `<|im_start|>system\n...<|im_end|>` formatted strings
 *   - openai-fine-tune: {messages: [{role, content}, ...]}
 *
 * Schema здесь stable: добавление полей в JSONL line — backwards
 * compatible (downstream может ignore). Удаление/переименование — нет.
 */

export type DatasetFormat = "jsonl" | "sharegpt" | "chatml";

export interface JsonlLine {
  conceptId: string;
  bookId: string;
  collectionName: string;
  createdAt: string;
  delta: DeltaKnowledge;
}

type RawConcept = RawDoc & {
  userId: string;
  bookId: string;
  collectionName: string;
  payload: string;
  accepted?: boolean;
  createdAt: string;
};

const PAGE_SIZE = 100;

/**
 * Async iterator over user's accepted concepts in a collection.
 * Streams pages — caller pulls JsonlLine until done, не загружая всё
 * в память. Парсит payload JSON; если parse fail — warning через
 * onWarning callback (НЕ throws, чтобы один битый concept не блокировал
 * остальные 999).
 */
export interface IterateOptions {
  userId: string;
  collectionName: string;
  onWarning?: (msg: string) => void;
  signal?: AbortSignal;
}

export async function* iterateAcceptedConcepts(
  opts: IterateOptions,
): AsyncGenerator<JsonlLine, void, void> {
  const { databases, databaseId } = getDatastore();
  let offset = 0;
  while (true) {
    if (opts.signal?.aborted) return;
    const page = await databases.listDocuments<RawConcept>(
      databaseId,
      COLLECTIONS.concepts,
      [
        Query.equal("userId", opts.userId),
        Query.equal("collectionName", opts.collectionName),
        Query.equal("accepted", true),
        Query.orderAsc("createdAt"),
        Query.limit(PAGE_SIZE),
        Query.offset(offset),
      ],
    );
    if (page.documents.length === 0) return;
    for (const doc of page.documents) {
      if (opts.signal?.aborted) return;
      let delta: DeltaKnowledge;
      try {
        delta = JSON.parse(doc.payload) as DeltaKnowledge;
      } catch (err) {
        opts.onWarning?.(
          `concept ${doc.$id}: payload JSON.parse failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }
      yield {
        conceptId: doc.$id,
        bookId: doc.bookId,
        collectionName: doc.collectionName,
        createdAt: doc.createdAt,
        delta,
      };
    }
    if (page.documents.length < PAGE_SIZE) return;
    offset += PAGE_SIZE;
  }
}

/**
 * Build a complete JSONL buffer in memory. For ≤10K concepts this is
 * fine; larger exports should use streaming variant.
 */
export async function buildJsonlBuffer(opts: IterateOptions): Promise<{
  jsonl: string;
  lineCount: number;
  warnings: string[];
}> {
  const warnings: string[] = [];
  const lines: string[] = [];
  for await (const line of iterateAcceptedConcepts({
    ...opts,
    onWarning: (w) => warnings.push(w),
  })) {
    lines.push(JSON.stringify(line));
  }
  return {
    jsonl: lines.join("\n") + (lines.length > 0 ? "\n" : ""),
    lineCount: lines.length,
    warnings,
  };
}
