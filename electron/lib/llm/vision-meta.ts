/**
 * Vision-meta extractor — локальное извлечение метаданных книги из обложки
 * через мультимодальную модель LM Studio.
 *
 * АРХИТЕКТУРНЫЙ КОНТРАКТ:
 *   1. ИСКЛЮЧИТЕЛЬНО локальный LM Studio (никаких облачных API).
 *   2. Никакого хардкода имён моделей: vision-модель выбирается динамически
 *      из загруженных в LM Studio через эвристику маркеров vision-семейств
 *      (vl, vision, llava, pixtral, minicpm-v, gemma3, internvl, molmo, phi-vision...).
 *   3. Пользователь может зафиксировать конкретную модель через preferences.visionModelKey.
 *   4. Никогда не throw — на любых ошибках возвращает {ok:false,error} для UI/лога.
 *
 * Используем OpenAI-совместимый chat endpoint LM Studio (`/v1/chat/completions`),
 * который принимает `image_url` в контенте сообщения для vision-capable моделей.
 */

import { z } from "zod";
import { listLoaded } from "../../lmstudio-client.js";
import { getLmStudioUrl } from "../endpoints/index.js";
import { getModelPool } from "./model-pool.js";
import { getImportScheduler } from "../library/import-task-scheduler.js";
import {
  buildVisionMetaResponseFormat,
  pickResponseFormat,
} from "./schemas/index.js";
import { validateImageBuffer } from "./image-preflight.js";
import * as telemetry from "../resilience/telemetry.js";

/**
 * Маркеры vision-моделей в modelKey/architecture. Это эвристика стратегии,
 * а не хардкод конкретной модели — любая локально загруженная модель
 * с любым из этих маркеров считается vision-capable.
 *
 * Список маркеров — открытое множество, расширяемое без релиза кода через
 * env `BIBLIARY_VISION_MODEL_MARKERS` (CSV).
 */
const BUILTIN_VISION_MARKERS: ReadonlyArray<string> = [
  "qwen3.5",       /* Qwen3.5 has native vision fusion (no -VL suffix needed) */
  "-vl",           /* qwen3-vl, qwen2.5-vl, internvl (hyphen-bounded, avoids false matches like "eval") */
  "vision",        /* llama-3.2-vision, phi-3-vision */
  "llava",         /* llava-1.5/1.6/next */
  "pixtral",       /* mistral pixtral */
  "minicpm-v",     /* minicpm-llama3-v 2.5 / minicpm-v 2.6 */
  "molmo",         /* allenai molmo */
  "gemma-3",       /* gemma 3 image-capable варианты */
  "gemma3",        /* slug-варианты */
  "phi-3.5-vision",
  "phi-4-multimodal",
  "phi-vision",
  "idefics",       /* HF idefics3 */
  "cogvlm",
  "deepseek-vl",
  "olmocr",        /* AI2 OLMo-OCR (OCR-specialist, 2025+) */
];

/**
 * Priority prefixes for sorting vision model candidates.
 * Models whose modelKey starts with a higher-priority prefix are tried first.
 * Qwen3-VL leads: SOTA on OmniDocBench, OCRBench, DocVQA 2026.
 */
const VISION_FAMILY_PRIORITY: ReadonlyArray<string> = [
  "qwen3.5",       /* Apr 2026 — native vision fusion, outperforms Qwen3-VL on OCR/Doc benchmarks */
  "qwen3-vl",      /* 2025-2026 — strong OCR: 8B=896 OCRBench, 96.1% DocVQA */
  "qwen2.5-vl",
  "qwen2-vl",
  "internvl3",     /* InternVL3: strong multilingual & CJK */
  "internvl",      /* InternVL2 fallback */
  "pixtral",       /* mistral, strong layouts */
  "phi-4-multimodal",
  "gemma3",
  "gemma-3",
  "minicpm-v",
  "phi-3.5-vision",
  "llava",
  "molmo",
  "vision",
  "deepseek-vl",
  "olmocr",
  "cogvlm",
  "idefics",
  "-vl",           /* generic fallback for any *-vl model */
];

function visionFamilyPriority(modelKey: string): number {
  const lc = modelKey.toLowerCase();
  const idx = VISION_FAMILY_PRIORITY.findIndex((prefix) => lc.includes(prefix));
  return idx === -1 ? VISION_FAMILY_PRIORITY.length : idx;
}

function getVisionMarkers(): string[] {
  const env = process.env.BIBLIARY_VISION_MODEL_MARKERS?.trim();
  if (env && env.length > 0) {
    return env.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  }
  return [...BUILTIN_VISION_MARKERS];
}

/**
 * Совпадение модели с маркером vision-семейства. Регистро-нечувствительно,
 * проверка включения — `qwen3-vl-7b` матчит маркер `vl`.
 *
 * Экспортируется для lmstudio-client.ts (capability detection) и
 * model-role-resolver.ts (vision_meta/vision_ocr role resolution).
 */
export function looksLikeVisionModel(modelKey: string): boolean {
  if (!modelKey) return false;
  const lc = modelKey.toLowerCase();
  return getVisionMarkers().some((m) => lc.includes(m));
}

/**
 * Zod-схема структурированного ответа vision-модели.
 * Все поля nullable — модель честно говорит «не вижу», а не галлюцинирует.
 */
export const VisionMetaSchema = z.object({
  title: z.string().nullable(),
  /** Один автор или main author — не пустая строка ИЛИ null. Не "Unknown". */
  author: z.string().nullable(),
  /** Все авторы (включая соавторов), pretty-printed. Может быть пустым массивом. */
  authors: z.array(z.string()).default([]),
  year: z.number().int().min(1400).max(2100).nullable(),
  /** ISO-639-1 ("en", "ru", "uk", "de"). null если LLM не уверена. */
  language: z.string().min(2).max(10).nullable(),
  publisher: z.string().nullable(),
  /** 0..1 self-reported confidence: насколько LLM уверена в извлечённом. */
  confidence: z.number().min(0).max(1).default(0.5),
});

export type VisionMeta = z.infer<typeof VisionMetaSchema>;

export interface VisionMetaResult {
  ok: boolean;
  meta?: VisionMeta;
  error?: string;
  warnings?: string[];
  /** Сырой ответ модели для логов/дебага. */
  rawResponse?: string;
  /** Идентификатор использованной модели (modelKey LM Studio). */
  model?: string;
  /** Какие модели пробовали до финального результата. */
  attempts?: Array<{ model: string; ok: boolean; reason?: string }>;
}

const VISION_META_SYSTEM = `You are a forensic bibliographer analyzing a book cover or title page image.
Your task: extract bibliographic metadata as strict JSON. NO prose, NO markdown.

EXTRACTION RULES:
1. TITLE: the main title visible on the cover. Preserve original language script (Cyrillic, Latin, Hebrew, Greek). NEVER substitute filename or "Unknown".
2. AUTHOR: primary author exactly as printed on the cover. Preserve script. If multiple, return the first; list all in "authors".
3. YEAR: 4-digit publication year if visible (copyright line, edition note, "© 1995", etc.). null if absent.
4. LANGUAGE: ISO-639-1 code (en, ru, uk, de, fr, es, ja, zh, ar, he, pl, cs, bg, ...). Detect from script + words on cover. Distinguish Russian (ru) vs Ukrainian (uk) carefully — Ukrainian uses і, ї, є, ґ which Russian does not.
5. PUBLISHER: publisher name if printed (e.g. "O'Reilly", "Oxford University Press", "Видавництво Старого Лева", "Наука"). null if absent.
6. CONFIDENCE: your self-assessment (0..1). 0.9 = clear cover, all fields visible. 0.3 = blurry/partial. 0.1 = mostly guessing.

OUTPUT (no other text):
{"title":"...","author":"...","authors":["..."],"year":2020,"language":"en","publisher":"...","confidence":0.85}

If a field is invisible/illegible, return null (or [] for authors). NEVER hallucinate.`;

/**
 * Вытащить strict JSON из произвольного ответа модели. Vision-модели иногда
 * оборачивают ответ в ```json ... ```, иногда добавляют префиксы.
 */
function extractJson(raw: string): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
  const codeBlock = trimmed.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
  if (codeBlock) return codeBlock[1].trim();
  const start = trimmed.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return trimmed.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Динамически выбирает vision-модели из загруженных в LM Studio.
 *
 * Приоритеты:
 *   1. `preferredModelKey` ТОЧНО есть в loaded → возвращаем массив длины 1
 *      с этой моделью, других НЕ добавляем. Юзер выбрал — юзер знает.
 *   2. `preferredModelKey` задан, но НЕ загружен → пустой массив.
 *      Caller получит graceful "vision model not loaded" и не вызовет
 *      случайно другую vision-модель (раньше тут был partial-substring
 *      match, который молча подменял выбор пользователя).
 *   3. `preferredModelKey` пуст → авто-список всех vision-моделей,
 *      отсортированный по `VISION_FAMILY_PRIORITY`.
 */
export interface PickVisionModelOptions {
  preferredModelKey?: string;
  /** DI hook для тестов — подменить listLoaded(). */
  listLoadedImpl?: typeof listLoaded;
}

export async function pickVisionModels(opts: PickVisionModelOptions = {}): Promise<Array<{ modelKey: string }>> {
  const lister = opts.listLoadedImpl ?? listLoaded;
  let loaded: Awaited<ReturnType<typeof listLoaded>>;
  try {
    loaded = await lister();
  } catch {
    return [];
  }
  if (loaded.length === 0) return [];

  const preferred = opts.preferredModelKey?.trim();
  if (preferred && preferred.length > 0) {
    const exact = loaded.find((m) => m.modelKey === preferred);
    if (exact) return [{ modelKey: exact.modelKey }];
    /* Pref задан, но не загружен — отказываемся подменять. Caller получит
       пустой массив и graceful warning, а не «случайно похожая» модель. */
    return [];
  }

  /* Auto-detect: все loaded модели с vision-маркером, по приоритету семейств. */
  const detected = loaded
    .filter((m) => looksLikeVisionModel(m.modelKey))
    .sort((a, b) => visionFamilyPriority(a.modelKey) - visionFamilyPriority(b.modelKey));

  const out: Array<{ modelKey: string }> = [];
  const seen = new Set<string>();
  for (const model of detected) {
    if (seen.has(model.modelKey)) continue;
    seen.add(model.modelKey);
    out.push({ modelKey: model.modelKey });
  }
  return out;
}

export async function pickVisionModel(opts: PickVisionModelOptions = {}): Promise<{ modelKey: string } | null> {
  return (await pickVisionModels(opts))[0] ?? null;
}

/**
 * Подменяемый низкоуровневый fetcher (для unit-тестов без сети).
 * Возвращает сырой content от модели — caller сам парсит JSON.
 */
export type LmStudioVisionFetcher = (args: {
  baseUrl: string;
  modelKey: string;
  systemPrompt: string;
  userText: string;
  imageDataUrl: string;
  signal: AbortSignal;
}) => Promise<{ content: string }>;

const defaultLmStudioVisionFetcher: LmStudioVisionFetcher = async ({
  baseUrl, modelKey, systemPrompt, userText, imageDataUrl, signal,
}) => {
  const { strategy, payload: responseFormat } = pickResponseFormat({
    modelKey,
    schemaBuilder: buildVisionMetaResponseFormat,
  });
  telemetry.logEvent({
    type: "lmstudio.response_format_picked",
    role: "vision_meta",
    modelKey,
    strategy,
  });
  const payload = {
    model: modelKey,
    temperature: 0,
    max_tokens: 800,
    top_p: 0.9,
    response_format: responseFormat,
    chat_template_kwargs: { enable_thinking: false },
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: [
          { type: "text", text: userText },
          { type: "image_url", image_url: { url: imageDataUrl } },
        ],
      },
    ],
  };
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });
  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`LM Studio HTTP ${response.status}: ${errText.slice(0, 200)}`);
  }
  const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  const content = (data.choices?.[0]?.message?.content ?? "").trim();
  return { content };
};

export interface ExtractMetaFromCoverOptions {
  /** Override modelKey (из preferences.visionModelKey). Пусто = auto-detect. */
  modelKey?: string;
  /** MIME-тип переданного буфера. Default: image/png. */
  mimeType?: string;
  /** AbortSignal для отмены долгого запроса. */
  signal?: AbortSignal;
  /** Hard timeout (ms). По умолчанию 60s. */
  timeoutMs?: number;
  /** Сколько локальных vision-моделей максимум пробовать. Default 3. */
  maxModelAttempts?: number;
  /** DI hook для тестов: подменить fetcher и listLoaded(). */
  fetcherImpl?: LmStudioVisionFetcher;
  listLoadedImpl?: typeof listLoaded;
}

function getMaxModelAttempts(value: number | undefined): number {
  if (Number.isInteger(value) && value! > 0) return Math.min(value!, 16);
  const env = Number.parseInt(process.env.BIBLIARY_VISION_META_MODEL_ATTEMPTS ?? "", 10);
  if (Number.isInteger(env) && env > 0) return Math.min(env, 16);
  return 3;
}

function isMissingBibliographicCore(meta: VisionMeta): string | null {
  const missing: string[] = [];
  if (!meta.title) missing.push("title");
  if (!meta.author) missing.push("author");
  if (meta.year === null) missing.push("year");
  if (!meta.language) missing.push("language");
  if (missing.length === 0) return null;
  return `missing ${missing.join(", ")}`;
}

async function requestMetaFromModel(
  imageBuffer: Buffer,
  modelKey: string,
  opts: ExtractMetaFromCoverOptions,
): Promise<VisionMetaResult> {
  const mimeType = opts.mimeType || "image/png";
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const fetcher = opts.fetcherImpl ?? defaultLmStudioVisionFetcher;

  /* Объединяем внешний signal с локальным timeout. */
  const localCtl = new AbortController();
  const onExternal = () => localCtl.abort();
  if (opts.signal) {
    if (opts.signal.aborted) return { ok: false, error: "aborted before request", model: modelKey };
    opts.signal.addEventListener("abort", onExternal, { once: true });
  }
  const timer = setTimeout(() => localCtl.abort(), timeoutMs);

  const dataUrl = `data:${mimeType};base64,${imageBuffer.toString("base64")}`;

  let raw = "";
  try {
    const baseUrl = await getLmStudioUrl();
    const response = await fetcher({
      baseUrl,
      modelKey,
      systemPrompt: VISION_META_SYSTEM,
      userText: "Extract metadata from this book cover/title page:",
      imageDataUrl: dataUrl,
      signal: localCtl.signal,
    });
    raw = response.content.trim();
    if (!raw) {
      return { ok: false, error: "empty response from vision model", model: modelKey };
    }

    const jsonStr = extractJson(raw);
    if (!jsonStr) {
      return { ok: false, error: "no JSON object in response", model: modelKey, rawResponse: raw };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonStr);
    } catch (e) {
      return { ok: false, error: `JSON.parse failed: ${e instanceof Error ? e.message : String(e)}`, model: modelKey, rawResponse: raw };
    }

    /* Снимаем мусорные значения "Unknown"/"N/A" → null до zod-валидации. */
    if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      const nullify = ["title", "author", "language", "publisher"];
      for (const k of nullify) {
        const v = obj[k];
        if (typeof v === "string") {
          const s = v.trim();
          if (!s || /^(unknown|n\/a|none|null|undefined|неизвестно|невідомо)$/i.test(s)) {
            obj[k] = null;
          }
        }
      }
    }

    const validation = VisionMetaSchema.safeParse(parsed);
    if (!validation.success) {
      return {
        ok: false,
        error: `schema mismatch: ${validation.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
        model: modelKey,
        rawResponse: raw,
      };
    }

    return { ok: true, meta: validation.data, model: modelKey, rawResponse: raw };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg, model: modelKey, rawResponse: raw };
  } finally {
    clearTimeout(timer);
    if (opts.signal) opts.signal.removeEventListener("abort", onExternal);
  }
}

/**
 * Главный entry-point: отправить буфер обложки в loaded LM Studio vision-модель,
 * получить bibliographic metadata. Никогда не throw.
 *
 * Если vision-модели нет — возвращает {ok:false, error:"no vision model loaded in LM Studio"},
 * caller (md-converter) пишет warning и продолжает импорт без vision enrichment.
 */
export async function extractMetadataFromCover(
  imageBuffer: Buffer,
  opts: ExtractMetaFromCoverOptions = {},
): Promise<VisionMetaResult> {
  if (!imageBuffer || imageBuffer.length === 0) {
    return { ok: false, error: "empty image buffer" };
  }

  /* Preflight only on production path — DI-tests inject synthetic buffers
     (fake PNG signatures) which would be rejected by sharp() validation. */
  const isDiTest = !!(opts.fetcherImpl || opts.listLoadedImpl);
  if (!isDiTest) {
    const preflight = await validateImageBuffer(imageBuffer);
    if (!preflight.ok) {
      telemetry.logEvent({
        type: "lmstudio.invalid_image_rejected",
        reason: preflight.reason,
        bytes: imageBuffer.length,
      });
      return { ok: false, error: `image preflight failed: ${preflight.reason}` };
    }
    if (!opts.mimeType) {
      opts = { ...opts, mimeType: preflight.mime };
    }
  }

  /* Иt 8Б: resolver-first. modelRoleResolver — single source of truth для
     роли vision_meta (preference + fallback chain + capability filter +
     cache TTL). pickVisionModels остаётся как fallback если resolver не дал
     результат (например, ни одной vision-модели не загружено). */
  let preferredModelKey = opts.modelKey;
  if (!preferredModelKey?.trim() && !opts.listLoadedImpl) {
    try {
      const { modelRoleResolver } = await import("./model-role-resolver.js");
      const resolved = await modelRoleResolver.resolve("vision_meta");
      if (resolved?.modelKey) preferredModelKey = resolved.modelKey;
    } catch { /* resolver не инициализирован (тесты) — fall through */ }
  }

  let candidates = (await pickVisionModels({
    preferredModelKey,
    listLoadedImpl: opts.listLoadedImpl,
  })).slice(0, getMaxModelAttempts(opts.maxModelAttempts));

  /* Lazy-load: если prefs содержит visionModelKey, но модель не загружена в
   * LM Studio — попытаться загрузить ЧЕРЕЗ POOL. Решает проблему «Olympics
   * записал prefs → import pipeline видит null → skip vision» И защищает
   * от DDoS параллельной загрузки моделей: pool.acquire идёт через единую
   * runOnChain цепочку, конкурирующие acquire дедуплицируются. */
  if (candidates.length === 0 && !opts.listLoadedImpl) {
    const prefKey = opts.modelKey?.trim() || "";
    if (prefKey) {
      try {
        const handle = await getModelPool().acquire(prefKey, {
          role: "vision_meta",
          ttlSec: 1800,
          gpuOffload: "max",
        });
        /* Сразу release: ниже мы всё равно сделаем pool.withModel для inference.
           Между release и withModel модель в LM Studio не выгрузится — у Pool
           LRU eviction срабатывает только когда нужно место под другую модель. */
        handle.release();
        candidates = [{ modelKey: prefKey }];
      } catch { /* load failed — fall through to error */ }
    }
  }

  if (candidates.length === 0) {
    return {
      ok: false,
      error: "no vision-capable model loaded in LM Studio (recommended: qwen3-vl-4b or qwen3-vl-8b; also: qwen2.5-vl, pixtral, gemma-3, llava, minicpm-v — or set preferences.visionModelKey)",
    };
  }

  const attempts: VisionMetaResult["attempts"] = [];
  const warnings: string[] = [];
  let bestIncomplete: VisionMetaResult | null = null;
  let lastFailure: VisionMetaResult | null = null;

  /* Test hooks (fetcher/listLoaded) run in isolation and MUST NOT hit real
     LM Studio load path via ModelPool. In production, keep pooled loading. */
  const useDirectModelRequest = !!(opts.fetcherImpl || opts.listLoadedImpl);
  const pool = useDirectModelRequest ? null : getModelPool();
  /* Иt 8В.MAIN.1.2: scheduler observability — vision-meta cover расходует
     vision-модель на GPU, идёт через heavy lane (как vision-OCR и
     vision-illustration). Тестовый путь (useDirectModelRequest) обходит
     scheduler — изолированные fetcherImpl-тесты не должны зависеть от
     singleton scheduler state. Production путь — всегда через enqueue. */
  const scheduler = useDirectModelRequest ? null : getImportScheduler();
  for (const candidate of candidates) {
    const runInference = (): Promise<VisionMetaResult> =>
      useDirectModelRequest
        ? requestMetaFromModel(imageBuffer, candidate.modelKey, opts)
        : pool!.withModel(
          candidate.modelKey,
          { role: "vision_meta", ttlSec: 1800, gpuOffload: "max" },
          () => requestMetaFromModel(imageBuffer, candidate.modelKey, opts),
        );
    const result = scheduler
      ? await scheduler.enqueue("heavy", runInference)
      : await runInference();
    if (!result.ok || !result.meta) {
      const reason = result.error ?? "unknown error";
      attempts.push({ model: candidate.modelKey, ok: false, reason });
      warnings.push(`vision-meta fallback: ${candidate.modelKey} failed: ${reason}`);
      lastFailure = result;
      continue;
    }

    const missing = isMissingBibliographicCore(result.meta);
    if (missing === null) {
      return { ...result, attempts: [...attempts, { model: candidate.modelKey, ok: true }], warnings };
    }

    attempts.push({ model: candidate.modelKey, ok: true, reason: missing });
    warnings.push(`vision-meta fallback: ${candidate.modelKey} returned incomplete metadata (${missing})`);
    if (!bestIncomplete || result.meta.confidence > (bestIncomplete.meta?.confidence ?? -1)) {
      bestIncomplete = result;
    }
  }

  if (bestIncomplete?.meta) {
    return { ...bestIncomplete, attempts, warnings };
  }
  return {
    ok: false,
    error: lastFailure?.error ?? "all vision-meta fallback models failed",
    model: lastFailure?.model,
    rawResponse: lastFailure?.rawResponse,
    attempts,
    warnings,
  };
}
