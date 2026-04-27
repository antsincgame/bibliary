/**
 * Illustration Worker — Semantic Vision Pipeline, Steps B & C.
 *
 * Step B (Semantic Triage): each surviving image is sent to the local Vision
 * model (LM Studio) with a prompt that scores its informational value 0-10
 * and produces a description.
 *
 * Step C (Markdown Enrichment): images with score > 5 are kept in CAS.
 * Their description is recorded in illustrations.json AND inserted into
 * book.md as alt-text ![LLM_DESC: ...] so Qdrant can do text search on
 * illustration content.
 *
 * Images with score ≤ 5 are NOT stored in CAS (disk savings). Their CAS blob
 * (if already written during import) is NOT deleted — blobs are immutable and
 * may be referenced elsewhere. The illustrations.json entry is marked skipped.
 *
 * Not blocking import — called asynchronously from import.ts.
 * No external network — only local LM Studio.
 */

import { promises as fs } from "fs";
import * as path from "path";
import { pickVisionModels } from "../llm/vision-meta.js";

/** Minimum score (exclusive) for a semantic illustration to be kept in CAS. */
const SEMANTIC_SCORE_THRESHOLD = 5;

export interface IllustrationEntry {
  id: string;
  sha256: string | null;
  mimeType: string;
  bytes: number;
  /** Informational value 0-10 from Semantic Triage LLM. null = not analysed yet. */
  score: number | null;
  /** Human-readable description produced by Vision LLM. Used for vector search. */
  description: string | null;
  /** true = score ≤ threshold; blob NOT stored in CAS to save disk space. */
  skipped: boolean;
  caption: string | null;
  sourcePage?: number;
}

export interface SemanticTriageResult {
  score: number;
  description: string;
}

/**
 * Step B prompt: score 0-10 + description.
 * Covers are allowed to be score 1-2 — they are always kept (not skipped).
 */
const SEMANTIC_TRIAGE_PROMPT = `Rate the informational value of this image from a technical or non-fiction book.
Return JSON only (no extra text):
{
  "score": <integer 0-10>,
  "description": "<one or two sentences describing exactly what the image shows>"
}

Scoring guide:
0 — decoration, ornament, watermark, page number, blank, 1-pixel divider
1-2 — cover, back cover, publisher logo, author portrait
3-4 — photo, generic illustration, map, layout diagram without technical content
5-6 — UI screenshot, interface mockup, simple table
7-8 — code listing, data table with values, numbered list of items
9-10 — technical architecture diagram, flowchart, UML, graph, chart, mathematical formula

Respond with valid JSON only. No markdown.`;

/**
 * Step B: Send one image to Vision LLM for Semantic Triage.
 * Returns { score, description } or null on failure.
 */
async function analyzeImageWithVision(
  imageBuffer: Buffer,
  mimeType: string,
  modelKey: string,
  signal?: AbortSignal,
): Promise<SemanticTriageResult | null> {
  try {
    const { getLmStudioUrl: getUrl } = await import("../endpoints/index.js");
    const baseUrl = await getUrl();
    const body = {
      model: modelKey,
      temperature: 0,
      max_tokens: 400,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: SEMANTIC_TRIAGE_PROMPT },
            {
              type: "image_url",
              image_url: {
                url: `data:${mimeType};base64,${imageBuffer.toString("base64")}`,
              },
            },
          ],
        },
      ],
    };

    const resp = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });

    if (!resp.ok) return null;

    const json = (await resp.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const raw = json.choices?.[0]?.message?.content ?? "";
    const parsed = extractJsonFromResponse(raw);
    if (!parsed) return null;

    const score = typeof parsed.score === "number" ? Math.round(Math.max(0, Math.min(10, parsed.score))) : null;
    if (score === null) return null;

    return {
      score,
      description: typeof parsed.description === "string" ? parsed.description.trim() : "",
    };
  } catch {
    return null;
  }
}

function extractJsonFromResponse(raw: string): Record<string, unknown> | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  try {
    if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  } catch { /* continue */ }
  const codeBlock = trimmed.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
  if (codeBlock) {
    try { return JSON.parse(codeBlock[1].trim()); } catch { /* continue */ }
  }
  const start = trimmed.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < trimmed.length; i++) {
    if (trimmed[i] === "{") depth++;
    else if (trimmed[i] === "}") {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(trimmed.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

/**
 * Steps B + C: Фоновая обработка иллюстраций книги.
 *
 * B: Semantic Triage — каждое изображение оценивается Vision LLM (score 0-10).
 * C: Markdown Enrichment — description вставляется в book.md как alt-текст
 *    ![LLM_DESC: ...] для Qdrant текстового поиска по иллюстрациям.
 *
 * Не блокирует импорт — вызывается асинхронно из import.ts.
 */
export async function processIllustrations(
  bookDir: string,
  blobsRoot: string,
  signal?: AbortSignal,
  onProgress?: (msg: string) => void,
): Promise<{ processed: number; skipped: number; errors: number }> {
  const illustrationsPath = path.join(bookDir, "illustrations.json");
  const mdPath = await findBookMdFile(bookDir);
  let entries: IllustrationEntry[];

  try {
    const raw = await fs.readFile(illustrationsPath, "utf-8");
    entries = JSON.parse(raw);
  } catch {
    return { processed: 0, skipped: 0, errors: 0 };
  }

  if (entries.length === 0) return { processed: 0, skipped: 0, errors: 0 };

  const models = await pickVisionModels();
  if (models.length === 0) {
    onProgress?.("No vision models loaded — skipping illustration analysis");
    return { processed: 0, skipped: 0, errors: 0 };
  }
  const modelKey = models[0].modelKey;

  let processed = 0;
  let skipped = 0;
  let errors = 0;

  // Read existing .md for Step C enrichment
  let bookMd: string | null = null;
  if (mdPath) {
    try {
      bookMd = await fs.readFile(mdPath, "utf-8");
    } catch {
      // .md may not exist yet — enrichment will be skipped
    }
  }

  let mdModified = false;

  for (const entry of entries) {
    if (signal?.aborted) break;
    // Skip already-analysed entries
    if (entry.score !== null && entry.score !== undefined) {
      processed++;
      continue;
    }

    // sha256 must be present (blob must exist) unless entry is already skipped
    if (!entry.sha256) {
      entry.skipped = true;
      skipped++;
      continue;
    }

    const blobPath = await findBlobFile(blobsRoot, entry.sha256);
    if (!blobPath) {
      errors++;
      continue;
    }

    try {
      const buffer = await fs.readFile(blobPath);
      onProgress?.(`[Semantic Triage] ${entry.id} (${entry.bytes} bytes) via ${modelKey}`);

      const triage = await analyzeImageWithVision(buffer, entry.mimeType, modelKey, signal);

      if (!triage) {
        errors++;
        continue;
      }

      entry.score = triage.score;
      entry.description = triage.description;

      // Covers (img-cover) are always kept regardless of score
      const isCover = entry.id === "img-cover";

      if (!isCover && triage.score <= SEMANTIC_SCORE_THRESHOLD) {
        // Step C: score too low — mark as skipped, don't update markdown
        entry.skipped = true;
        skipped++;
        onProgress?.(`[Semantic Triage] ${entry.id} score=${triage.score} ≤ ${SEMANTIC_SCORE_THRESHOLD} — skipped`);
      } else {
        // Step C: Markdown Enrichment — inject LLM_DESC alt-text into book.md
        entry.skipped = false;
        processed++;
        onProgress?.(`[Semantic Triage] ${entry.id} score=${triage.score} — enriching markdown`);

        if (bookMd && triage.description) {
          bookMd = enrichMarkdownAltText(bookMd, entry.id, triage.description);
          mdModified = true;
        }
      }
    } catch {
      errors++;
    }
  }

  // Persist illustrations.json with scores and descriptions
  try {
    await fs.writeFile(illustrationsPath, JSON.stringify(entries, null, 2), "utf-8");
  } catch {
    errors++;
  }

  // Step C: write enriched .md
  if (mdModified && bookMd && mdPath) {
    try {
      await fs.writeFile(mdPath, bookMd, "utf-8");
    } catch {
      errors++;
    }
  }

  return { processed, skipped, errors };
}

/**
 * Step C helper: replace the alt-text of an image reference in book.md.
 *
 * Replaces ![Cover][img-cover] → ![LLM_DESC: ...][img-cover]
 * or  ![Illustration 1][img-001] → ![LLM_DESC: ...][img-001]
 */
function enrichMarkdownAltText(markdown: string, imgId: string, description: string): string {
  // Sanitise description for markdown alt: no brackets, max 200 chars
  const safeDesc = description.replace(/[\[\]]/g, "").slice(0, 200).trim();
  const newAlt = `LLM_DESC: ${safeDesc}`;
  // Replace any existing alt for this image id: ![anything][imgId]
  const re = new RegExp(`!\\[[^\\]]*\\]\\[${escapeRegex(imgId)}\\]`, "g");
  return markdown.replace(re, `![${newAlt}][${imgId}]`);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Find the .md book file inside bookDir. Human-readable layout names it {Title}.md, not book.md. */
async function findBookMdFile(bookDir: string): Promise<string | null> {
  try {
    const entries = await fs.readdir(bookDir);
    const md = entries.find((e) => e.endsWith(".md") && !e.startsWith("."));
    return md ? path.join(bookDir, md) : null;
  } catch {
    return null;
  }
}

async function findBlobFile(blobsRoot: string, sha256: string): Promise<string | null> {
  const sub = sha256.slice(0, 2);
  const dir = path.join(blobsRoot, sub);
  try {
    const entries = await fs.readdir(dir);
    const match = entries.find((e) => e.startsWith(sha256));
    if (match) return path.join(dir, match);
  } catch {
    // dir doesn't exist
  }
  return null;
}
