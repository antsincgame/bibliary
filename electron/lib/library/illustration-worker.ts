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
import { modelRoleResolver } from "../llm/model-role-resolver.js";
import { getPreferencesStore } from "../preferences/store.js";
import { getModelPool } from "../llm/model-pool.js";
import { getImportScheduler } from "./import-task-scheduler.js";

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
 * Step B prompt builder: score 0-10 + description.
 *
 * Принимает КОНТЕКСТ книги (title, chapter) — без него описание получается
 * generic: "a red rectangle". С контекстом модель привязывает иллюстрацию
 * к теме главы: "a red rectangular block — likely a memory page diagram".
 *
 * Это ключ для тематического vector search в Qdrant: описание без контекста
 * не даёт результатов на запрос «найди диаграмму memory hierarchy».
 */
function buildSemanticTriagePrompt(ctx: { bookTitle?: string; chapterTitle?: string } = {}): string {
  const title = ctx.bookTitle?.trim();
  const chapter = ctx.chapterTitle?.trim();
  const contextBlock = (title || chapter)
    ? `Book context (use this to interpret the image — anchor your description to the topic):\n` +
      (title   ? `- Book: "${title}"\n` : "") +
      (chapter ? `- Chapter: "${chapter}"\n` : "") + "\n"
    : "";

  return `${contextBlock}Rate the informational value of this image from a technical or non-fiction book.
Return JSON only (no extra text):
{
  "score": <integer 0-10>,
  "description": "<1-2 sentences. If the chapter context is provided above, anchor the description to the chapter topic when plausible.>"
}

Scoring guide:
0 — decoration, ornament, watermark, page number, blank, 1-pixel divider
1-2 — cover, back cover, publisher logo, author portrait
3-4 — photo, generic illustration, map, layout diagram without technical content
5-6 — UI screenshot, interface mockup, simple table
7-8 — code listing, data table with values, numbered list of items
9-10 — technical architecture diagram, flowchart, UML, graph, chart, mathematical formula

Respond with valid JSON only. No markdown.`;
}

/**
 * Step B: Send one image to Vision LLM for Semantic Triage.
 * Returns { score, description } or null on failure.
 *
 * Если передан `fallbackModelKeys` — при ошибке/timeout первой модели
 * пробует следующие из списка. Возвращает первый успешный результат.
 */
async function analyzeImageWithVision(
  imageBuffer: Buffer,
  mimeType: string,
  modelKey: string,
  ctx: { bookTitle?: string; chapterTitle?: string } = {},
  signal?: AbortSignal,
  fallbackModelKeys: string[] = [],
  perModelTimeoutMs: number = 30_000,
): Promise<SemanticTriageResult | null> {
  const candidates = [modelKey, ...fallbackModelKeys].filter(Boolean);
  const prompt = buildSemanticTriagePrompt(ctx);

  for (const candidate of candidates) {
    try {
      const { getLmStudioUrl: getUrl } = await import("../endpoints/index.js");
      const baseUrl = await getUrl();
      const body = {
        model: candidate,
        temperature: 0,
        max_tokens: 400,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
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

      /* Combine external abort signal with our per-model timeout. */
      const timeoutCtl = new AbortController();
      const timer = setTimeout(() => timeoutCtl.abort(), perModelTimeoutMs);
      const onExternalAbort = () => timeoutCtl.abort();
      signal?.addEventListener("abort", onExternalAbort);

      let resp: Response;
      try {
        resp = await fetch(`${baseUrl}/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: timeoutCtl.signal,
        });
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onExternalAbort);
      }

      if (!resp.ok) continue; /* try next model */

      const json = (await resp.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const raw = json.choices?.[0]?.message?.content ?? "";
      const parsed = extractJsonFromResponse(raw);
      if (!parsed) continue;

      const score = typeof parsed.score === "number"
        ? Math.round(Math.max(0, Math.min(10, parsed.score)))
        : null;
      if (score === null) continue;

      return {
        score,
        description: typeof parsed.description === "string" ? parsed.description.trim() : "",
      };
    } catch {
      /* timeout / network — try next model */
      if (signal?.aborted) return null; /* but stop if user aborted */
    }
  }
  return null;
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
  exactPaths?: { mdPath?: string; illustrationsPath?: string; bookTitle?: string },
): Promise<{ processed: number; skipped: number; errors: number }> {
  const illustrationsPath = exactPaths?.illustrationsPath ?? path.join(bookDir, "illustrations.json");
  const mdPath = exactPaths?.mdPath ?? await findBookMdFile(bookDir);
  let entries: IllustrationEntry[];

  try {
    const raw = await fs.readFile(illustrationsPath, "utf-8");
    entries = JSON.parse(raw);
  } catch {
    return { processed: 0, skipped: 0, errors: 0 };
  }

  if (entries.length === 0) return { processed: 0, skipped: 0, errors: 0 };

  /* Resolve vision_illustration role (с фолбэком на legacy visionModelKey
   * через model-role-resolver). Если ничего не нашлось — fallback на
   * pickVisionModels() для backward-compat. */
  let modelKey: string | null = null;
  let fallbackModelKeys: string[] = [];
  try {
    const resolved = await modelRoleResolver.resolve("vision_illustration");
    if (resolved) modelKey = resolved.modelKey;
    /* Дополнительные кандидаты из CSV-fallback prefs (для retry в worker). */
    const prefs = await getPreferencesStore().getAll();
    const fbCsv = prefs.visionModelFallbacks?.trim() || "";
    if (fbCsv) {
      fallbackModelKeys = fbCsv.split(",").map((s: string) => s.trim()).filter((k: string) => k && k !== modelKey);
    }
  } catch {
    /* resolver упал — попробуем legacy путь */
  }
  if (!modelKey) {
    const models = await pickVisionModels();
    if (models.length === 0) {
      /* Lazy-load через pool. Раньше прямой client.llm.load обходил все
       * сериализаторы, и при импорте 2+ книг параллельные illustration-worker'ы
       * могли дёрнуть load одной vision-модели одновременно → OOM на тяжёлых
       * Qwen-VL. Pool.acquire дедуплицирует через runOnChain. Immediate release
       * безопасен — withModel ниже снова возьмёт refCount. */
      const prefs2 = await getPreferencesStore().getAll();
      const prefVision = prefs2.visionModelKey?.trim() || "";
      if (prefVision) {
        try {
          onProgress?.(`Loading vision model "${prefVision}" from prefs...`);
          const handle = await getModelPool().acquire(prefVision, {
            role: "vision_illustration",
            ttlSec: 1800,
            gpuOffload: "max",
          });
          handle.release();
          modelKey = prefVision;
        } catch (loadErr) {
          onProgress?.(`Failed to auto-load vision model "${prefVision}": ${loadErr instanceof Error ? loadErr.message : String(loadErr)}`);
        }
      }
      if (!modelKey) {
        onProgress?.("No vision models loaded — skipping illustration analysis");
        return { processed: 0, skipped: 0, errors: 0 };
      }
    } else {
      modelKey = models[0]!.modelKey;
      fallbackModelKeys = models.slice(1).map((m) => m.modelKey);
    }
  }

  /* Контекст книги для тематических описаний. В новом storage layout папка
   * bookDir — это author folder, поэтому title берём из exactPaths/book meta,
   * а basename(bookDir) используем только для legacy layout. */
  const bookTitle = exactPaths?.bookTitle ?? inferBookTitleFromDir(bookDir);

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

  /* Параллельный pool — vision-LLM запросы к LM Studio могут идти 3-5
   * одновременно (ограничено GPU/CPU memory pressure, но не CPU-bound).
   * Без pool: 100 картинок × 6 сек = 10 минут. С pool=4: ≈2.5 мин.
   *
   * Защита: locking bookMd / mdModified / counters через async ticks
   * (single-threaded JS — race-free для счётчиков, но enrichMarkdownAltText
   * читает и пишет одну переменную bookMd, поэтому делаем этот шаг
   * последовательно через mdQueue). */
  const VISION_PARALLELISM = 4;

  /* Сериализуем только md-патчинг — остальные шаги (vision call, qdrant index)
   * полностью независимые по entries. */
  let mdSerial: Promise<void> = Promise.resolve();
  const serializeMd = (op: () => void): Promise<void> => {
    const next = mdSerial.then(() => { op(); });
    mdSerial = next.catch(() => {}); /* не залипаем на ошибке */
    return next;
  };

  async function processOneEntry(entry: typeof entries[number]): Promise<void> {
    if (signal?.aborted) return;
    // Skip already-analysed entries
    if (entry.score !== null && entry.score !== undefined) {
      processed++;
      return;
    }

    // sha256 must be present (blob must exist) unless entry is already skipped
    if (!entry.sha256) {
      entry.skipped = true;
      skipped++;
      return;
    }

    const blobPath = await findBlobFile(blobsRoot, entry.sha256);
    if (!blobPath) {
      errors++;
      return;
    }

    try {
      onProgress?.(`[Semantic Triage] ${entry.id} (${entry.bytes} bytes) via ${modelKey}`);

      const triage = await analyzeImageWithVision(
        await fs.readFile(blobPath),
        entry.mimeType,
        modelKey!,
        { bookTitle: bookTitle ?? undefined, chapterTitle: entry.caption ?? undefined },
        signal,
        fallbackModelKeys,
      );

      if (!triage) {
        errors++;
        return;
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
          await serializeMd(() => {
            bookMd = enrichMarkdownAltText(bookMd!, entry.id, triage.description);
            mdModified = true;
          });
        }

        // Step D: E5 text-vector indexing — ВСЕГДА (default-on).
        //
      }
    } catch {
      errors++;
    }
  }

  /* Простой in-process pool без новых зависимостей. */
  async function runPool(items: typeof entries, parallelism: number): Promise<void> {
    let cursor = 0;
    async function worker(): Promise<void> {
      while (cursor < items.length) {
        if (signal?.aborted) return;
        const idx = cursor++;
        const item = items[idx];
        if (!item) return;
        await processOneEntry(item);
      }
    }
    const workers = Array.from({ length: Math.min(parallelism, items.length) }, () => worker());
    await Promise.all(workers);
  }

  /* Pool: один acquire primary vision-модели на весь батч иллюстраций.
     Без этого pool увидел бы N независимых chat-вызовов на ту же модель.
     Здесь — один pin на всё время обработки, fallback модели грузятся
     отдельно по мере необходимости в analyzeImageWithVision.

     Iter 7: оборачиваем в scheduler.enqueue("heavy") для observability —
     UI widget видит что vision-illustration активен. heavy concurrency=1
     гарантирует что vision_illustration НЕ конкурирует с vision_ocr/vision_meta
     за GPU (они тоже идут через heavy lane). */
  await getImportScheduler().enqueue("heavy", () =>
    getModelPool().withModel(
      modelKey,
      { role: "vision_illustration", ttlSec: 3600, gpuOffload: "max" },
      () => runPool(entries, VISION_PARALLELISM),
    ),
  );
  /* Финальная синхронизация md-очереди — гарантирует что bookMd зафиксирован
   * до записи на диск. */
  await mdSerial;

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

/**
 * Извлечь читаемый title книги из имени её каталога. Имя — sanitised title
 * (см. library-store), напр. "Cormen-Algorithms_3rd_Edition_2009". Превращаем
 * подчёркивания/тире в пробелы и обрезаем суффикс года/edition heuristically.
 */
function inferBookTitleFromDir(bookDir: string): string | null {
  const base = path.basename(bookDir).replace(/[_\-]+/g, " ").trim();
  if (!base) return null;
  /* Strip trailing 4-digit year. */
  return base.replace(/\s+\d{4}\s*$/, "").trim() || base;
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
