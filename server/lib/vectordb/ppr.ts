import { getVectorDb } from "./db.js";
import { canonicalizeEntityName } from "./graph.js";

/**
 * Phase Δf — Personalized PageRank over the per-user knowledge graph.
 *
 * The graph is small (typically <10k entities per user) and lives in
 * the same sqlite file as everything else, so we pull it into memory
 * once per query, run sparse power iteration, and discard. No graph DB
 * required; PPR latency stays ≪ embedder cold-start.
 *
 * Adjacency is built from the `relations` table treating edges as
 * UNDIRECTED — the LightRAG / HippoRAG findings show bidirectional
 * propagation matches book-scale knowledge structure better than
 * directed (e.g. "Saturn V designed_by von Braun" should reachable
 * from a query about "Saturn V" or about "von Braun").
 *
 * Damping α = 0.15 (i.e. teleport prob): standard PPR convention from
 * Haveliwala 2002 onward.
 */

export interface PPRSeed {
  entityId: number;
  weight: number;
}

export interface PPRResult {
  /** entityId → score in [0,1], sums to 1 across all reachable nodes. */
  scores: Map<number, number>;
  iterations: number;
}

const DEFAULT_DAMPING = 0.15;
const DEFAULT_ITERATIONS = 25;
const CONVERGENCE_EPS = 1e-6;

/**
 * Load adjacency for the (user_id) scoped graph. Returns Map<entityId,
 * Set<neighborId>>. Edges are mirrored — for each (s, p, o) we store
 * o ∈ N(s) AND s ∈ N(o).
 */
function loadAdjacency(userId: string): Map<number, Set<number>> {
  const { db } = getVectorDb();
  const adj = new Map<number, Set<number>>();
  const rows = db
    .prepare(`SELECT subject_id, object_id FROM relations WHERE user_id = ?`)
    .all(userId) as Array<{ subject_id: number; object_id: number }>;
  for (const r of rows) {
    if (r.subject_id === r.object_id) continue; // ignore self-loops
    let s = adj.get(r.subject_id);
    if (!s) {
      s = new Set();
      adj.set(r.subject_id, s);
    }
    s.add(r.object_id);
    let o = adj.get(r.object_id);
    if (!o) {
      o = new Set();
      adj.set(r.object_id, o);
    }
    o.add(r.subject_id);
  }
  return adj;
}

export function personalizedPageRank(input: {
  userId: string;
  seeds: PPRSeed[];
  damping?: number;
  iterations?: number;
  /** Override for tests — inject pre-loaded adjacency. */
  adjacencyOverride?: Map<number, Set<number>>;
}): PPRResult {
  const damping = input.damping ?? DEFAULT_DAMPING;
  const maxIter = input.iterations ?? DEFAULT_ITERATIONS;
  const adj = input.adjacencyOverride ?? loadAdjacency(input.userId);
  if (adj.size === 0 || input.seeds.length === 0) {
    return { scores: new Map(), iterations: 0 };
  }
  /* Build teleport vector from seeds. Normalize to sum 1. */
  const seedTotal = input.seeds.reduce((acc, s) => acc + Math.max(0, s.weight), 0);
  if (seedTotal === 0) return { scores: new Map(), iterations: 0 };
  const teleport = new Map<number, number>();
  for (const s of input.seeds) {
    if (s.weight <= 0) continue;
    if (!adj.has(s.entityId)) continue; // seed not in graph
    teleport.set(s.entityId, (teleport.get(s.entityId) ?? 0) + s.weight / seedTotal);
  }
  if (teleport.size === 0) return { scores: new Map(), iterations: 0 };

  /* Initialize scores = teleport. */
  let scores = new Map(teleport);

  /* Power iteration. New score per node:
   *   s'[v] = damping * teleport[v] + (1 - damping) * Σ s[u]/deg(u)  for u ∈ N(v)
   * Walking from sources (u) to destinations (v) is the natural way to
   * implement sparsely. We iterate over all known nodes (adj keys plus
   * any seed). */
  let iter = 0;
  for (iter = 0; iter < maxIter; iter++) {
    const next = new Map<number, number>();
    /* Pre-fill with teleport contribution. */
    for (const [v, t] of teleport) {
      next.set(v, damping * t);
    }
    /* Distribute (1-damping) * s[u] / deg(u) to neighbors. */
    for (const [u, s] of scores) {
      const neighbors = adj.get(u);
      if (!neighbors || neighbors.size === 0) continue;
      const share = ((1 - damping) * s) / neighbors.size;
      if (share === 0) continue;
      for (const v of neighbors) {
        next.set(v, (next.get(v) ?? 0) + share);
      }
    }
    /* L1 convergence check. */
    let delta = 0;
    for (const [v, vNext] of next) {
      delta += Math.abs(vNext - (scores.get(v) ?? 0));
    }
    for (const [v, vPrev] of scores) {
      if (!next.has(v)) delta += vPrev;
    }
    scores = next;
    if (delta < CONVERGENCE_EPS) {
      iter += 1;
      break;
    }
  }
  return { scores, iterations: iter };
}

/**
 * Token-level entity seeding: tokenize a free-text query into words
 * ≥3 chars, canonicalize, lookup against entities.canonical + aliases.
 * Returns matched entity IDs (deduped). Weights are 1.0 each — caller
 * can re-weight before passing to personalizedPageRank.
 *
 * This is intentionally simple (no LLM, no fuzzy match) — covers the
 * "user types entity name" case which is the dominant pattern. Future
 * work: embed the query, find nearest entity centroid.
 */
export function findEntityIdsForQuery(userId: string, queryText: string): number[] {
  const { db } = getVectorDb();
  const tokens = queryText
    .split(/\s+/u)
    .map((t) => canonicalizeEntityName(t))
    .filter((t) => t.length >= 3);
  if (tokens.length === 0) return [];
  /* Try whole-query first (caught canonical match); then each token. */
  const candidates = new Set<string>();
  candidates.add(canonicalizeEntityName(queryText));
  for (const t of tokens) candidates.add(t);

  const ids = new Set<number>();
  for (const cand of candidates) {
    /* Canonical exact match. */
    const exact = db
      .prepare(`SELECT id FROM entities WHERE user_id = ? AND canonical = ?`)
      .get(userId, cand) as { id: number } | undefined;
    if (exact) ids.add(exact.id);
    /* Alias hit — alias is stored verbatim. */
    const alias = db
      .prepare(
        `SELECT entity_id FROM entity_aliases
         WHERE alias = ? AND entity_id IN (SELECT id FROM entities WHERE user_id = ?)`,
      )
      .get(cand, userId) as { entity_id: number } | undefined;
    if (alias) ids.add(alias.entity_id);
    /* Substring fallback — useful for "Saturn V rocket" → "saturn v"
     * canonical. Limit to 20 hits to bound cost. */
    const substr = db
      .prepare(
        `SELECT id FROM entities
         WHERE user_id = ? AND (canonical LIKE ? OR display LIKE ?)
         LIMIT 20`,
      )
      .all(userId, `%${cand}%`, `%${cand}%`) as Array<{ id: number }>;
    for (const r of substr) ids.add(r.id);
  }
  return Array.from(ids);
}

/**
 * For a set of chunks, compute a graph score = sum of PPR scores of
 * entities that appear in any relation sourced from that chunk. This
 * is the "narrative origin" boost: a chunk that produced relations
 * touching highly-ranked entities is more relevant to the query than
 * a chunk that just happens to be cosine-close.
 */
export function scoreChunksByGraph(input: {
  userId: string;
  chunkRowIds: number[];
  pprScores: Map<number, number>;
}): Map<number, number> {
  const result = new Map<number, number>();
  if (input.chunkRowIds.length === 0 || input.pprScores.size === 0) {
    for (const id of input.chunkRowIds) result.set(id, 0);
    return result;
  }
  const { db } = getVectorDb();
  const placeholders = input.chunkRowIds.map(() => "?").join(",");
  /* Per chunk, sum PPR of subject + object entity ids of relations
   * whose source is that chunk. Map -> Map for in-memory aggregation. */
  const rows = db
    .prepare(
      `SELECT source_chunk_vec_rowid AS rid, subject_id, object_id
       FROM relations
       WHERE user_id = ? AND source_chunk_vec_rowid IN (${placeholders})`,
    )
    .all(input.userId, ...input.chunkRowIds) as Array<{
    rid: number;
    subject_id: number;
    object_id: number;
  }>;
  for (const id of input.chunkRowIds) result.set(id, 0);
  for (const r of rows) {
    const subj = input.pprScores.get(r.subject_id) ?? 0;
    const obj = input.pprScores.get(r.object_id) ?? 0;
    result.set(r.rid, (result.get(r.rid) ?? 0) + subj + obj);
  }
  return result;
}
