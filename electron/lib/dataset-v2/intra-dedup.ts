/**
 * Stage 3 — Intra-Chapter Vector Dedup.
 *
 * Дешёвая (без LLM) очистка повторов ВНУТРИ ОДНОЙ ГЛАВЫ.
 * Автор часто повторяет ту же мысль разными словами в начале и конце.
 *
 * Алгоритм:
 *   1. Embed principle каждого концепта (e5-small)
 *   2. Pairwise cosine similarity (для N≤30 это N*(N-1)/2 пар, моментально)
 *   3. Если sim > THRESHOLD = 0.88 → мердж (по уникальному representative-id)
 *   4. На выходе — DedupedConcept[] со списком mergedFromIds для аудита
 *
 * Threshold 0.88 — точка калибровки на e5-small: 0.85+ считается
 * «семантически идентичными формулировками».
 */

import { createHash } from "crypto";
import { embedQuery } from "../rag/index.js";
import type { DedupedConcept, ExtractedConcept } from "./types.js";

const SIMILARITY_THRESHOLD = 0.88;

function makeId(c: ExtractedConcept, bookSourcePath: string, chapterIndex: number): string {
  const h = createHash("sha1")
    .update(`${bookSourcePath}|${chapterIndex}|${c.principle}`)
    .digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function mergeTwo(a: DedupedConcept, b: DedupedConcept): DedupedConcept {
  /* Кто длиннее — тот основной (более развёрнутый explanation = больше контекста) */
  const primary = a.explanation.length >= b.explanation.length ? a : b;
  const secondary = primary === a ? b : a;
  const mergedExplanationParts = [primary.explanation];
  /* Не дублируем предложения из secondary, если они уже в primary */
  for (const sentence of secondary.explanation.split(/(?<=[.!?…])\s+/)) {
    const norm = sentence.trim().toLowerCase();
    if (norm.length < 8) continue;
    if (!primary.explanation.toLowerCase().includes(norm)) {
      mergedExplanationParts.push(sentence.trim());
    }
  }
  const mergedExplanation = mergedExplanationParts.join(" ").slice(0, 1500);
  return {
    ...primary,
    explanation: mergedExplanation,
    tags: Array.from(new Set([...primary.tags, ...secondary.tags])).slice(0, 10),
    noveltyHint: primary.noveltyHint.length >= secondary.noveltyHint.length ? primary.noveltyHint : secondary.noveltyHint,
    mergedFromIds: Array.from(new Set([...primary.mergedFromIds, ...secondary.mergedFromIds, primary.id, secondary.id])),
  };
}

export interface IntraDedupArgs {
  concepts: ExtractedConcept[];
  bookSourcePath: string;
  bookTitle: string;
  chapterIndex: number;
  chapterTitle: string;
  threshold?: number;
  onEvent?: (e: IntraDedupEvent) => void;
}

export type IntraDedupEvent =
  | { type: "intra-dedup.start"; total: number }
  | { type: "intra-dedup.merge"; sim: number; principleA: string; principleB: string }
  | { type: "intra-dedup.done"; before: number; after: number; mergedPairs: number };

export interface IntraDedupResult {
  concepts: DedupedConcept[];
  mergedPairs: number;
}

export async function dedupChapterConcepts(args: IntraDedupArgs): Promise<IntraDedupResult> {
  const threshold = args.threshold ?? SIMILARITY_THRESHOLD;
  const items: DedupedConcept[] = args.concepts.map((c) => ({
    ...c,
    id: makeId(c, args.bookSourcePath, args.chapterIndex),
    bookSourcePath: args.bookSourcePath,
    bookTitle: args.bookTitle,
    chapterIndex: args.chapterIndex,
    chapterTitle: args.chapterTitle,
    mergedFromIds: [],
  }));

  args.onEvent?.({ type: "intra-dedup.start", total: items.length });

  if (items.length <= 1) {
    args.onEvent?.({ type: "intra-dedup.done", before: items.length, after: items.length, mergedPairs: 0 });
    return { concepts: items, mergedPairs: 0 };
  }

  /* Embed все principles одним проходом */
  const vectors: number[][] = [];
  for (const c of items) {
    const v = await embedQuery(c.principle);
    vectors.push(v);
  }

  /* Union-find по similarity */
  const parent = items.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (i: number, j: number): void => {
    const a = find(i);
    const b = find(j);
    if (a !== b) parent[a] = b;
  };

  let mergedPairs = 0;
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const sim = cosine(vectors[i], vectors[j]);
      if (sim > threshold) {
        args.onEvent?.({
          type: "intra-dedup.merge",
          sim,
          principleA: items[i].principle.slice(0, 60),
          principleB: items[j].principle.slice(0, 60),
        });
        union(i, j);
        mergedPairs++;
      }
    }
  }

  /* Группируем по root и сливаем */
  const groups = new Map<number, DedupedConcept[]>();
  for (let i = 0; i < items.length; i++) {
    const root = find(i);
    const list = groups.get(root) ?? [];
    list.push(items[i]);
    groups.set(root, list);
  }

  const merged: DedupedConcept[] = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      merged.push(group[0]);
    } else {
      let acc = group[0];
      for (let k = 1; k < group.length; k++) acc = mergeTwo(acc, group[k]);
      merged.push(acc);
    }
  }

  args.onEvent?.({ type: "intra-dedup.done", before: items.length, after: merged.length, mergedPairs });
  return { concepts: merged, mergedPairs };
}
