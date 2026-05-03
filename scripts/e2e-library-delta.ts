/**
 * Live E2E for the current Delta-Knowledge extraction pipeline.
 *
 * Selects real books from the Library cache by tags, extracts a small number
 * of chapters, embeds accepted deltas, upserts them to dedicated Qdrant
 * collections, and writes the resulting status back to the Library cache.
 */
import * as path from "path";
import { existsSync } from "fs";
import { randomUUID } from "crypto";

interface TagRun {
  tag: string;
  collection: string;
}

interface CliArgs {
  dataDir: string;
  maxBooksPerTag: number;
  maxChapters: number;
  minQuality: number;
  model: string | null;
  qdrantUrl: string;
  lmStudioUrl: string;
  tags: TagRun[];
}

const DEFAULT_TAGS: TagRun[] = [
  { tag: "Python", collection: "test-python" },
  { tag: "data structures", collection: "test-algorithms" },
  { tag: "software architecture", collection: "test-architecture" },
];

function argValue(argv: string[], flag: string): string | null {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

function parseTags(raw: string | null): TagRun[] {
  if (!raw) return DEFAULT_TAGS;
  return raw.split(",").map((item) => {
    const [tagRaw, collRaw] = item.split(":");
    const tag = tagRaw.trim();
    const collection = (collRaw?.trim() || `test-${tag.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`).replace(/^-|-$/g, "");
    return { tag, collection };
  }).filter((t) => t.tag && t.collection);
}

function parseArgs(): CliArgs {
  const argv = process.argv.slice(2);
  const dataDir = path.resolve(argValue(argv, "--data-dir") ?? path.join(process.cwd(), "release", "data"));
  return {
    dataDir,
    maxBooksPerTag: Math.max(1, Number(argValue(argv, "--max-books-per-tag") ?? 1)),
    maxChapters: Math.max(1, Number(argValue(argv, "--max-chapters") ?? 1)),
    minQuality: Math.max(0, Number(argValue(argv, "--min-quality") ?? 50)),
    model: argValue(argv, "--model") ?? process.env.DV2_MODEL ?? null,
    qdrantUrl: (argValue(argv, "--qdrant-url") ?? process.env.QDRANT_URL ?? "http://localhost:6333").replace(/\/+$/, ""),
    lmStudioUrl: (argValue(argv, "--lm-studio-url") ?? process.env.LM_STUDIO_URL ?? "http://localhost:1234").replace(/\/+$/, ""),
    tags: parseTags(argValue(argv, "--tags")),
  };
}

function words(paragraphs: string[]): number {
  return paragraphs.reduce((sum, p) => sum + p.split(/\s+/).filter(Boolean).length, 0);
}

async function qdrantCount(collection: string, fetchQdrantJson: <T>(url: string, options?: RequestInit & { timeoutMs?: number }) => Promise<T>, qdrantUrl: string): Promise<number> {
  try {
    const data = await fetchQdrantJson<{ result: { points_count?: number } }>(`${qdrantUrl}/collections/${collection}`);
    return data.result.points_count ?? 0;
  } catch {
    return 0;
  }
}

async function pickModel(args: CliArgs): Promise<string> {
  if (args.model) return args.model;
  const resp = await fetch(`${args.lmStudioUrl}/v1/models`);
  if (!resp.ok) throw new Error(`LM Studio HTTP ${resp.status}`);
  const data = await resp.json() as { data: Array<{ id: string }> };
  const available = data.data.map((m) => m.id);
  const preferred = [
    "qwen/qwen3.6-35b-a3b",
    "qwen/qwen3.6-27b",
    "qwen/qwen3.5-9b",
    "qwen3-0.6b",
  ];
  return preferred.find((m) => available.includes(m)) ?? available[0] ?? "";
}

function printHeader(args: CliArgs, model: string): void {
  console.log("\n== Bibliary Delta Live E2E ==");
  console.log(`dataDir: ${args.dataDir}`);
  console.log(`qdrant: ${args.qdrantUrl}`);
  console.log(`lmStudio: ${args.lmStudioUrl}`);
  console.log(`model: ${model}`);
  console.log(`tags: ${args.tags.map((t) => `${t.tag}->${t.collection}`).join(", ")}`);
  console.log(`limits: ${args.maxBooksPerTag} book/tag, ${args.maxChapters} chapter/book\n`);
}

async function main(): Promise<void> {
  const args = parseArgs();
  if (!existsSync(args.dataDir)) throw new Error(`data dir not found: ${args.dataDir}`);
  process.env.BIBLIARY_DATA_DIR = args.dataDir;
  process.env.BIBLIARY_LIBRARY_DB = path.join(args.dataDir, "bibliary-cache.db");
  process.env.BIBLIARY_LIBRARY_ROOT = path.join(args.dataDir, "library");
  process.env.QDRANT_URL = args.qdrantUrl;
  process.env.LM_STUDIO_URL = args.lmStudioUrl;

  const model = await pickModel(args);
  if (!model) throw new Error("No LM Studio model available");
  printHeader(args, model);

  const { openCacheDb, getBookById, setBookStatus, closeCacheDb } = await import("../electron/lib/library/cache-db.js");
  const { resolveCatalogBookSourcePath } = await import("../electron/lib/library/storage-contract.js");
  const { parseBook } = await import("../electron/lib/scanner/parsers/index.js");
  const { chunkChapter, extractDeltaKnowledge, assertValidCollectionName, isNonContentSection } = await import("../electron/lib/dataset-v2/index.js");
  const { extractChapterThesis } = await import("../electron/lib/dataset-v2/delta-extractor.js");
  const { embedPassage } = await import("../electron/lib/embedder/shared.js");
  const { fetchQdrantJson } = await import("../electron/lib/qdrant/http-client.js");
  const { EMBEDDING_DIM } = await import("../electron/lib/scanner/embedding.js");
  const { chatWithPolicy } = await import("../electron/lmstudio-client.js");
  const { getModelProfile } = await import("../electron/lib/dataset-v2/model-profile.js");
  const { buildDeltaKnowledgeResponseFormat } = await import("../electron/lib/dataset-v2/json-schemas.js");
  const { ALLOWED_DOMAINS } = await import("../electron/lib/dataset-v2/crystallizer-constants.js");

  const profile = await getModelProfile(model);
  const allowedDomains = Array.from(ALLOWED_DOMAINS).sort();
  const llm = async ({ messages, temperature, maxTokens }: {
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
    temperature?: number;
    maxTokens?: number;
  }): Promise<{ content: string; reasoningContent?: string }> => {
    const response = await chatWithPolicy({
      model,
      messages,
      sampling: {
        temperature: temperature ?? 0.3,
        top_p: 0.9,
        top_k: 30,
        min_p: 0,
        presence_penalty: 0,
        max_tokens: Math.max(maxTokens ?? 4096, profile.maxTokens),
      },
      stop: profile.stop,
      responseFormat: profile.useResponseFormat ? buildDeltaKnowledgeResponseFormat(allowedDomains) : undefined,
      chatTemplateKwargs: profile.chatTemplateKwargs,
    });
    return { content: response.content, reasoningContent: response.reasoningContent };
  };

  const db = openCacheDb();
  let totalAccepted = 0;
  let totalFailed = 0;
  let tagsWithoutAccepted = 0;

  try {
    for (const tagRun of args.tags) {
      assertValidCollectionName(tagRun.collection);
      await fetchQdrantJson(`${args.qdrantUrl}/collections/${tagRun.collection}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vectors: { size: EMBEDDING_DIM, distance: "Cosine" } }),
        timeoutMs: 20_000,
      }).catch(() => undefined);

      const before = await qdrantCount(tagRun.collection, fetchQdrantJson, args.qdrantUrl);
      const rows = db.prepare(`
        SELECT b.id
          FROM books b
          JOIN book_tags bt ON bt.book_id = b.id
         WHERE bt.tag = ?
           AND b.status IN ('evaluated', 'failed', 'indexed')
           AND COALESCE(b.quality_score, 0) >= ?
           AND COALESCE(b.is_fiction_or_water, 0) = 0
         ORDER BY CASE b.status WHEN 'failed' THEN 0 WHEN 'evaluated' THEN 1 ELSE 2 END,
                  b.quality_score DESC,
                  b.title ASC
         LIMIT ?
      `).all(tagRun.tag, args.minQuality, args.maxBooksPerTag * 10) as Array<{ id: string }>;

      console.log(`\n[tag] ${tagRun.tag} -> ${tagRun.collection}: ${rows.length} book(s), points before=${before}`);
      let tagProcessed = 0;
      let tagAccepted = 0;

      for (const row of rows) {
        if (tagProcessed >= args.maxBooksPerTag) break;
        const meta = getBookById(row.id);
        if (!meta) continue;
        const sourcePath = resolveCatalogBookSourcePath(meta);
        console.log(`\n[book] ${meta.title} (${meta.id})`);
        console.log(`[book] source=${sourcePath}`);
        setBookStatus(meta.id, "crystallizing", { lastError: null });

        try {
          const parsed = await parseBook(sourcePath);
          const chapters = parsed.sections
            .map((section, index) => ({ section, index, words: words(section.paragraphs) }))
            .filter((c) => c.section.paragraphs.length > 0 && c.words >= 120 && !isNonContentSection(c.section))
            .slice(0, args.maxChapters);
          if (chapters.length === 0) throw new Error("no non-empty chapters with enough text");

          let bookChunks = 0;
          let bookAccepted = 0;
          const warnings: string[] = [];

          for (const chapter of chapters) {
            console.log(`[chapter] #${chapter.index} "${chapter.section.title}" ${chapter.words} words`);
            const chunks = await chunkChapter({
              section: chapter.section,
              chapterIndex: chapter.index,
              bookTitle: parsed.metadata.title || meta.title,
              bookSourcePath: sourcePath,
              maxParagraphsForDrift: 0,
            });
            bookChunks += chunks.length;
            if (chunks.length === 0) continue;

            const thesis = await extractChapterThesis(chapter.section.title, chapter.section.paragraphs.join("\n\n"), { llm }, null);
            const deltas = await extractDeltaKnowledge({
              chunks,
              chapterThesis: thesis,
              promptsDir: null,
              callbacks: {
                llm,
                onEvent: (event) => {
                  if (event.type === "delta.chunk.skip") console.log(`[delta] skip chunk ${event.chunkPart}: ${event.reason}`);
                  if (event.type === "delta.chunk.error") console.log(`[delta] error chunk ${event.chunkPart}: ${event.error}`);
                },
              },
            });
            warnings.push(...deltas.warnings);

            for (const delta of deltas.accepted) {
              const vector = await embedPassage(delta.essence);
              await fetchQdrantJson(`${args.qdrantUrl}/collections/${tagRun.collection}/points?wait=true`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  points: [{
                    id: delta.id || randomUUID(),
                    vector,
                    payload: {
                      domain: delta.domain,
                      chapterContext: delta.chapterContext,
                      essence: delta.essence,
                      cipher: delta.cipher,
                      proof: delta.proof,
                      applicability: delta.applicability,
                      auraFlags: delta.auraFlags,
                      tags: delta.tags,
                      relations: delta.relations,
                      bookSourcePath: delta.bookSourcePath,
                      acceptedAt: delta.acceptedAt,
                    },
                  }],
                }),
                timeoutMs: 20_000,
              });
              bookAccepted++;
              totalAccepted++;
              console.log(`[upsert] ${tagRun.collection} <- ${delta.id} ${delta.domain}`);
            }
          }

          if (bookAccepted > 0) {
            tagProcessed++;
            tagAccepted += bookAccepted;
            setBookStatus(meta.id, "indexed", {
              conceptsAccepted: bookAccepted,
              conceptsExtracted: bookChunks,
              lastError: null,
            });
            console.log(`[book] OK accepted=${bookAccepted} chunks=${bookChunks}`);
          } else {
            const reason = warnings.length > 0
              ? `no accepted deltas; ${warnings.slice(0, 3).join(" | ")}`
              : "no accepted deltas";
            setBookStatus(meta.id, "failed", {
              conceptsAccepted: 0,
              conceptsExtracted: bookChunks,
              lastError: reason,
            });
            totalFailed++;
            console.log(`[book] FAIL ${reason}`);
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          setBookStatus(meta.id, "failed", { lastError: msg });
          totalFailed++;
          console.error(`[book] ERROR ${msg}`);
        }
      }

      const after = await qdrantCount(tagRun.collection, fetchQdrantJson, args.qdrantUrl);
      console.log(`[collection] ${tagRun.collection}: before=${before} after=${after} delta=${after - before}`);
      if (tagAccepted === 0) {
        console.error(`[tag] ${tagRun.tag} produced 0 accepted deltas`);
        tagsWithoutAccepted++;
      }
    }
  } finally {
    closeCacheDb();
  }

  console.log(`\n== Summary == accepted=${totalAccepted} candidateFailures=${totalFailed} tagsWithoutAccepted=${tagsWithoutAccepted}`);
  if (totalAccepted === 0 || tagsWithoutAccepted > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
