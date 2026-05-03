/**
 * Vision OCR — распознавание текста из отсканированных страниц книги
 * через локальную vision-модель LM Studio.
 *
 * АРХИТЕКТУРНЫЙ КОНТРАКТ:
 *   1. ИСКЛЮЧИТЕЛЬНО локальный LM Studio (никаких облачных API).
 *   2. Источник модели:
 *      - явный override (opts.modelKey) — приоритет;
 *      - иначе modelRoleResolver.resolve("vision_ocr") — берёт настройку
 *        из карточки "Модели" (preference + fallback chain);
 *      - иначе авто-детект через pickVisionModels (вся загруженная vision-модель).
 *   3. Никогда не throw — на любых ошибках возвращает пустой текст с confidence=0.
 *
 * Иt 8Б (Settings-driven, Perplexity research): HTTP fetch обёрнут в
 * `getModelPool().withModel()` для **lifecycle tracking** — пока vision-OCR
 * страница в полёте, refCount > 0 и модель не будет evicted другим caller'ом
 * (LRU eviction в pool работает только с refCount=0). HTTP-путь сохранён
 * потому что @lmstudio/sdk multimodal API ограничен (см. plan: Б6 решение).
 * HeavyLaneRateLimiter остаётся ВНУТРИ withModel scope — RPM лимит per-model.
 */

import { getLmStudioUrl } from "../endpoints/index.js";
import { pickVisionModels } from "./vision-meta.js";
import { modelRoleResolver } from "./model-role-resolver.js";
import { getHeavyLaneRateLimiter } from "./heavy-lane-rate-limiter.js";
import { getModelPool } from "./model-pool.js";
import { getImportScheduler } from "../library/import-task-scheduler.js";

const VISION_OCR_INFERENCE = {
  temperature: 0,
  maxTokens: 8192,
} as const;

export interface VisionOcrResult {
  text: string;
  confidence: number;
  model?: string;
  error?: string;
}

export async function recognizeWithVisionLlm(
  imageBuffer: Buffer,
  opts: {
    languages?: string[];
    signal?: AbortSignal;
    mimeType?: string;
    modelKey?: string;
  } = {},
): Promise<VisionOcrResult> {
  /* 1. Явный override модели от caller (preferences.visionModelKey). */
  let preferred = opts.modelKey?.trim() || undefined;
  /* 2. Если override не задан — спросить role resolver (vision_ocr роль). */
  if (!preferred) {
    try {
      const resolved = await modelRoleResolver.resolve("vision_ocr");
      if (resolved?.modelKey) preferred = resolved.modelKey;
    } catch {
      /* graceful: упадём на pickVisionModels ниже */
    }
  }
  /* 3. Финальный pick (с fallback на любую загруженную vision-модель). */
  const models = await pickVisionModels({ preferredModelKey: preferred });

  if (models.length === 0) {
    return {
      text: "",
      confidence: 0,
      error: "No vision models loaded in LM Studio. Load a vision model (qwen-vl, llava, pixtral, gemma-3, etc.) and assign it to role 'vision_ocr' in Models page.",
    };
  }

  const mimeType = opts.mimeType || "image/png";
  const languages = (opts.languages || []).filter(Boolean).join(", ");
  const prompt = [
    "Extract plain text from the scanned book page image.",
    "Return only text, no explanations, no markdown.",
    languages ? `Preferred languages: ${languages}.` : "Detect language automatically.",
  ].join(" ");

  let lastError: string | undefined;

  const rateLimiter = getHeavyLaneRateLimiter();
  const pool = getModelPool();

  /* Иt 8В.MAIN.1.1: scheduler observability — vision-OCR обёрнут в
     `enqueue("heavy")`, чтобы pipeline-status-widget видел running/queued
     счётчик в реальном времени. heavy concurrency=1 уже гарантирует
     сериализацию vision-OCR с другими heavy задачами (vision-meta,
     vision-illustration, calibre/cbz/multi-tiff) — сходится с тем что
     ModelPool через runOnChain дедуплицирует acquire тех же моделей. */
  const scheduler = getImportScheduler();
  for (const { modelKey } of models) {
    try {
      /* Иt 8Б: lifecycle tracking через ModelPool.withModel — refCount++
         пока OCR страницы в полёте, поэтому LRU eviction в pool НЕ выгрузит
         модель пока мы её используем. role: "vision_ocr" → ROLE_LOAD_CONFIG
         автоматически применит правильные contextLength/gpuOffload.
         HTTP fetch остаётся ВНУТРИ — @lmstudio/sdk multimodal ограничен. */
      const result = await scheduler.enqueue("heavy", () => pool.withModel(
        modelKey,
        { role: "vision_ocr", ttlSec: 3600, gpuOffload: "max" },
        async () => {
          /* DDoS-защита heavy lane: книга в 1000 страниц без текстового слоя
             не должна забить vision-LLM очередь. Лимит per-modelKey, default
             60 запросов в минуту, конфигурируется через prefs.visionOcrRpm
             (Иt 8В.CRITICAL.2: env удалён). Sliding window — не throttling:
             простаивающие минуты «возвращают кредит». При aborted signal
             limiter throws — try/catch ниже handle. */
          await rateLimiter.acquire(modelKey, opts.signal);

          const baseUrl = await getLmStudioUrl();
          const body = {
            model: modelKey,
            temperature: VISION_OCR_INFERENCE.temperature,
            max_tokens: VISION_OCR_INFERENCE.maxTokens,
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

          const resp = await fetch(`${baseUrl}/v1/chat/completions`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            signal: opts.signal,
          });

          if (!resp.ok) {
            const errText = await resp.text().catch(() => "");
            return { ok: false as const, error: `LM Studio ${resp.status}: ${errText.slice(0, 200)}` };
          }

          const json = (await resp.json()) as {
            choices?: Array<{ message?: { content?: string } }>;
          };
          const text = (json.choices?.[0]?.message?.content || "").trim();
          return { ok: true as const, text };
        },
      ));

      if (result.ok) {
        return {
          text: result.text,
          confidence: result.text.length > 20 ? 0.9 : result.text.length > 0 ? 0.5 : 0,
          model: modelKey,
        };
      }
      lastError = result.error;
      continue;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (opts.signal?.aborted) break;
      continue;
    }
  }

  return {
    text: "",
    confidence: 0,
    error: lastError ?? "All vision models failed",
  };
}
