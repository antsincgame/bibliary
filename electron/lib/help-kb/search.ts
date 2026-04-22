/**
 * Help-KB search — semantic retrieval из bibliary_help (Phase 4.1).
 *
 * Используется агентом через tool `search_help` для ответов на вопросы
 * о САМОМ приложении (что такое YaRN, как запустить fine-tuning,
 * какие форматы файлов поддерживает Library и т.п.).
 *
 * Формат отличается от книжного RAG:
 *   - возвращаем не principle/explanation, а raw markdown text + heading
 *   - есть docTitle для атрибуции источника
 */

import { embedQuery } from "../embedder/shared.js";
import { fetchQdrantJson, QDRANT_URL } from "../qdrant/http-client.js";
import { DEFAULT_EMBED_MODEL } from "../scanner/embedding.js";
import { HELP_KB_COLLECTION } from "./ingest.js";

export interface HelpSearchHit {
  score: number;
  source: string;
  docTitle: string;
  heading: string;
  headingPath: string[];
  text: string;
}

interface QdrantSearchResponse {
  result: Array<{
    id: string;
    score: number;
    payload: Record<string, unknown>;
  }>;
}

const DEFAULT_LIMIT = 5;
const DEFAULT_SCORE_THRESHOLD = 0.55;

export interface SearchHelpOptions {
  limit?: number;
  scoreThreshold?: number;
  embedModel?: string;
  signal?: AbortSignal;
}

export async function searchHelp(query: string, opts: SearchHelpOptions = {}): Promise<HelpSearchHit[]> {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const scoreThreshold = opts.scoreThreshold ?? DEFAULT_SCORE_THRESHOLD;
  const embedModel = opts.embedModel ?? DEFAULT_EMBED_MODEL;

  const vector = await embedQuery(query, embedModel);
  const data = await fetchQdrantJson<QdrantSearchResponse>(
    `${QDRANT_URL}/collections/${HELP_KB_COLLECTION}/points/search`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        vector,
        limit,
        with_payload: true,
        score_threshold: scoreThreshold,
      }),
      signal: opts.signal,
    }
  );

  return data.result.map((r) => ({
    score: r.score,
    source: String(r.payload.source ?? ""),
    docTitle: String(r.payload.docTitle ?? ""),
    heading: String(r.payload.heading ?? ""),
    headingPath: Array.isArray(r.payload.headingPath) ? r.payload.headingPath.map(String) : [],
    text: String(r.payload.text ?? ""),
  }));
}
