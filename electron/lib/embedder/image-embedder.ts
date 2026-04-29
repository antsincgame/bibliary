/**
 * Image / multimodal embedder — CLIP (Xenova/clip-vit-base-patch32).
 *
 * Зачем нужен:
 *   - Векторный поиск ПО КАРТИНКАМ (image-to-image и text-to-image).
 *   - Текст и изображение проектируются в ОДНО 512-dim пространство, поэтому
 *     можно искать "найди диаграмму архитектуры по запросу 'cache hierarchy'"
 *     и наоборот: "похожие иллюстрации на эту".
 *
 * Размерности:
 *   - clip-vit-base-patch32 → 512 dims (vision_embeds == text_embeds dim).
 *   - Это меньше чем E5 (384), и КОРОЧЕ — Qdrant хранит компактнее.
 *
 * Загрузка:
 *   - Lazy: модель скачивается при ПЕРВОМ вызове embedImage / embedTextForImage.
 *   - В transformers.js modelKey = "Xenova/clip-vit-base-patch32".
 *   - Размер модели в кэше: ~600 MB (vision + text encoders).
 *
 * Опасности:
 *   - Cold-start ~30s на CPU. Используем тот же COLD_START_TIMEOUT_MS=120_000.
 *   - Загрузка из HF при первом запуске — нужен интернет один раз.
 *   - Не вызывать одновременно с E5 при нехватке RAM (CLIP +600 MB on top
 *     of E5's 150 MB → суммарно ~750 MB кэша моделей).
 */

import type {
  PreTrainedModel,
  PreTrainedTokenizer,
  Processor,
} from "@xenova/transformers";
import { configureTransformersCache as _configureCache } from "./shared.js";

/** Fixed CLIP model key — projects vision + text into shared 512-dim space. */
export const DEFAULT_IMAGE_EMBED_MODEL = "Xenova/clip-vit-base-patch32";

/** Vector dimensions of CLIP-base-patch32 — must match Qdrant collection size. */
export const IMAGE_EMBED_DIMS = 512;

const COLD_START_TIMEOUT_MS = 180_000; /* CLIP больше E5, дадим запас */
const EMBED_CALL_TIMEOUT_MS = 30_000;

interface CachedClip {
  ready: Promise<{
    visionModel: PreTrainedModel;
    textModel: PreTrainedModel;
    processor: Processor;
    tokenizer: PreTrainedTokenizer;
  }>;
  resolved: {
    visionModel: PreTrainedModel;
    textModel: PreTrainedModel;
    processor: Processor;
    tokenizer: PreTrainedTokenizer;
  } | null;
}

const cache = new Map<string, CachedClip>();

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`[image-embedder] ${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

async function loadClipParts(modelKey: string): Promise<CachedClip["resolved"]> {
  _configureCache();
  /* Динамический import чтобы не тащить ~150MB transformers.js в стартап
   * пока пользователь не включил image-search. */
  const tx = await import("@xenova/transformers");
  const [processor, tokenizer, visionModel, textModel] = await Promise.all([
    tx.AutoProcessor.from_pretrained(modelKey),
    tx.AutoTokenizer.from_pretrained(modelKey),
    tx.CLIPVisionModelWithProjection.from_pretrained(modelKey),
    tx.CLIPTextModelWithProjection.from_pretrained(modelKey),
  ]);
  return { processor, tokenizer, visionModel, textModel };
}

/**
 * Lazy-load both vision + text projection heads.
 * Subsequent calls reuse the same cached instances.
 */
async function getClip(modelKey: string = DEFAULT_IMAGE_EMBED_MODEL) {
  const existing = cache.get(modelKey);
  if (existing) return existing.resolved ?? existing.ready;

  const ready = withTimeout(
    (async () => {
      const parts = await loadClipParts(modelKey);
      if (!parts) throw new Error("CLIP loader returned empty");
      const slot = cache.get(modelKey);
      if (slot) slot.resolved = parts;
      return parts;
    })(),
    COLD_START_TIMEOUT_MS,
    `cold-start ${modelKey}`,
  ).catch((e) => {
    cache.delete(modelKey);
    throw e;
  });

  cache.set(modelKey, { ready, resolved: null });
  return ready;
}

/**
 * Embed an image → 512-dim vector in CLIP's shared image-text space.
 *
 * `imageInput` accepts:
 *   - data URL (`data:image/jpeg;base64,...`)
 *   - file:// URL
 *   - http(s) URL
 *   - absolute file path string (will be wrapped to file://)
 *
 * Vector is L2-normalised so cosine similarity works directly in Qdrant
 * with `Distance: "Cosine"`.
 */
export async function embedImage(
  imageInput: string,
  modelKey: string = DEFAULT_IMAGE_EMBED_MODEL,
): Promise<number[]> {
  const { visionModel, processor } = await getClip(modelKey);
  const tx = await import("@xenova/transformers");

  const url = imageInput.startsWith("data:") || /^[a-z]+:\/\//i.test(imageInput)
    ? imageInput
    : `file://${imageInput}`;

  const image = await tx.RawImage.read(url);
  const out = await withTimeout(
    (async () => {
      const inputs = await processor(image);
      const { image_embeds } = await visionModel(inputs);
      return l2Normalise(Array.from(image_embeds.data as Float32Array));
    })(),
    EMBED_CALL_TIMEOUT_MS,
    "embedImage",
  );
  return out;
}

/**
 * Embed a TEXT query into the same CLIP image-text space, so it can be
 * searched against vectors stored from `embedImage`.
 *
 * Use this for "find illustration matching: 'cache hierarchy diagram'".
 * For text-to-text search use `embedQuery` from shared.ts (E5).
 */
export async function embedTextForImage(
  text: string,
  modelKey: string = DEFAULT_IMAGE_EMBED_MODEL,
): Promise<number[]> {
  const { textModel, tokenizer } = await getClip(modelKey);
  const out = await withTimeout(
    (async () => {
      const inputs = tokenizer([text], { padding: true, truncation: true });
      const { text_embeds } = await textModel(inputs);
      return l2Normalise(Array.from(text_embeds.data as Float32Array));
    })(),
    EMBED_CALL_TIMEOUT_MS,
    "embedTextForImage",
  );
  return out;
}

/**
 * L2-normalise a vector so cosine similarity == dot product.
 * CLIP outputs unnormalised projections — Qdrant expects normalised vectors
 * for stable Cosine ranking.
 */
function l2Normalise(v: number[]): number[] {
  let s = 0;
  for (const x of v) s += x * x;
  const norm = Math.sqrt(s) || 1;
  return v.map((x) => x / norm);
}

/** For tests / shutdown — drop loaded models from memory. */
export function clearImageEmbedderCache(): void {
  cache.clear();
}
