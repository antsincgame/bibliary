/**
 * Illustration Worker — фоновая обработка картинок книги через Vision LLM.
 *
 * После успешного парсинга книги этот воркер:
 *   1. Прогоняет каждую картинку через локальную vision-модель LM Studio.
 *   2. Определяет role: cover | back-cover | illustration | unrelated.
 *   3. Извлекает OCR-текст из каждой иллюстрации (если видимый).
 *   4. Записывает результат в illustrations.json рядом с книгой.
 *
 * Не блокирует импорт — вызывается асинхронно.
 * Сеть наружу не идёт (никакого OpenRouter).
 */

import { promises as fs } from "fs";
import * as path from "path";
import { pickVisionModels } from "../llm/vision-meta.js";

export interface IllustrationEntry {
  id: string;
  sha256: string;
  mimeType: string;
  bytes: number;
  role: "cover" | "back-cover" | "illustration" | "unrelated";
  caption: string | null;
  sourcePage?: number;
  ocrText?: string;
  language?: string;
  confidence?: number;
}

export interface IllustrationAnalysis {
  role: "cover" | "back-cover" | "illustration" | "unrelated";
  ocrText: string;
  language: string | null;
  confidence: number;
}

const COVER_DETECTION_PROMPT = `Analyze this book image. Determine:
1. ROLE: Is this a "cover" (front cover/title page), "back-cover", "illustration" (diagram, figure, chart), or "unrelated" (blank, noise, decorative)?
2. OCR_TEXT: Extract any visible text exactly as printed.
3. LANGUAGE: ISO-639-1 code of the text (en, ru, uk, de, etc.) or null.
4. CONFIDENCE: Your self-assessment 0..1.

Return strict JSON only:
{"role":"cover","ocrText":"...","language":"en","confidence":0.9}`;

async function analyzeImageWithVision(
  imageBuffer: Buffer,
  mimeType: string,
  modelKey: string,
  signal?: AbortSignal,
): Promise<IllustrationAnalysis | null> {
  try {
    const { getLmStudioUrl: getUrl } = await import("../endpoints/index.js");
    const baseUrl = await getUrl();
    const body = {
      model: modelKey,
      temperature: 0,
      max_tokens: 2048,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: COVER_DETECTION_PROMPT },
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

    return {
      role: validateRole(parsed.role),
      ocrText: typeof parsed.ocrText === "string" ? parsed.ocrText : "",
      language: typeof parsed.language === "string" ? parsed.language : null,
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
    };
  } catch {
    return null;
  }
}

function validateRole(r: unknown): IllustrationAnalysis["role"] {
  const valid = ["cover", "back-cover", "illustration", "unrelated"];
  if (typeof r === "string" && valid.includes(r)) return r as IllustrationAnalysis["role"];
  return "illustration";
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
 * Фоновая обработка иллюстраций книги.
 * Читает текущий illustrations.json, обогащает каждую запись Vision LLM данными.
 * Не блокирует импорт.
 */
export async function processIllustrations(
  bookDir: string,
  blobsRoot: string,
  signal?: AbortSignal,
  onProgress?: (msg: string) => void,
): Promise<{ processed: number; errors: number }> {
  const illustrationsPath = path.join(bookDir, "illustrations.json");
  let entries: IllustrationEntry[];

  try {
    const raw = await fs.readFile(illustrationsPath, "utf-8");
    entries = JSON.parse(raw);
  } catch {
    return { processed: 0, errors: 0 };
  }

  if (entries.length === 0) return { processed: 0, errors: 0 };

  const models = await pickVisionModels();
  if (models.length === 0) {
    onProgress?.("No vision models loaded — skipping illustration analysis");
    return { processed: 0, errors: 0 };
  }
  const modelKey = models[0].modelKey;

  let processed = 0;
  let errors = 0;

  for (const entry of entries) {
    if (signal?.aborted) break;
    if (entry.ocrText !== undefined && entry.ocrText !== null) {
      processed++;
      continue;
    }

    const blobPath = await findBlobFile(blobsRoot, entry.sha256);
    if (!blobPath) {
      errors++;
      continue;
    }

    try {
      const buffer = await fs.readFile(blobPath);
      onProgress?.(`Analyzing ${entry.id} (${entry.bytes} bytes) with ${modelKey}`);
      const analysis = await analyzeImageWithVision(buffer, entry.mimeType, modelKey, signal);
      if (analysis) {
        entry.role = analysis.role;
        entry.ocrText = analysis.ocrText;
        entry.language = analysis.language ?? undefined;
        entry.confidence = analysis.confidence;
        processed++;
      } else {
        errors++;
      }
    } catch {
      errors++;
    }
  }

  try {
    await fs.writeFile(illustrationsPath, JSON.stringify(entries, null, 2), "utf-8");
  } catch {
    errors++;
  }

  return { processed, errors };
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

/**
 * LLM cover detection: из всех image-кандидатов книги выбирает лучшую обложку.
 * Может также проверить соседние image-файлы рядом с исходником.
 */
export async function detectCoverFromCandidates(
  candidates: Array<{ sha256: string; buffer: Buffer; mimeType: string; source: string }>,
  signal?: AbortSignal,
): Promise<{ coverSha256: string; confidence: number } | null> {
  const models = await pickVisionModels();
  if (models.length === 0 || candidates.length === 0) return null;
  const modelKey = models[0].modelKey;

  let bestCover: { coverSha256: string; confidence: number } | null = null;

  for (const candidate of candidates) {
    if (signal?.aborted) break;
    const analysis = await analyzeImageWithVision(
      candidate.buffer,
      candidate.mimeType,
      modelKey,
      signal,
    );
    if (analysis && analysis.role === "cover" && analysis.confidence > (bestCover?.confidence ?? 0)) {
      bestCover = { coverSha256: candidate.sha256, confidence: analysis.confidence };
    }
  }

  return bestCover;
}
