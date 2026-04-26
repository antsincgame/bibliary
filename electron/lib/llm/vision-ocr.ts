/**
 * Vision OCR — распознавание текста из отсканированных страниц книги
 * через локальную vision-модель LM Studio.
 *
 * АРХИТЕКТУРНЫЙ КОНТРАКТ:
 *   1. ИСКЛЮЧИТЕЛЬНО локальный LM Studio (никаких облачных API, никакого OpenRouter).
 *   2. Никакого хардкода имён моделей: vision-модель выбирается динамически
 *      из загруженных в LM Studio через pickVisionModels() из vision-meta.ts.
 *   3. Никогда не throw — на любых ошибках возвращает пустой текст с confidence=0.
 */

import { getLmStudioUrl } from "../endpoints/index.js";
import { pickVisionModels } from "./vision-meta.js";

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
  const models = await pickVisionModels({
    preferredModelKey: opts.modelKey,
  });

  if (models.length === 0) {
    return {
      text: "",
      confidence: 0,
      error: "No vision models loaded in LM Studio. Load a vision model (qwen-vl, llava, pixtral, gemma-3, etc.) to enable OCR.",
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

  for (const { modelKey } of models) {
    try {
      const baseUrl = await getLmStudioUrl();
      const body = {
        model: modelKey,
        temperature: 0,
        max_tokens: 8192,
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
        lastError = `LM Studio ${resp.status}: ${errText.slice(0, 200)}`;
        continue;
      }

      const json = (await resp.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const text = (json.choices?.[0]?.message?.content || "").trim();

      return {
        text,
        confidence: text.length > 20 ? 0.9 : text.length > 0 ? 0.5 : 0,
        model: modelKey,
      };
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
