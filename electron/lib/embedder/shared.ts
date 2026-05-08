/**
 * Shared embedder singleton.
 *
 * Shared singleton: one cached pipeline per model key.
 * Race-safe: parallel callers wait on a single Promise during cold-start
 * so we never call `pipeline()` twice for the same key.
 *
 * Embedding text is wrapped here so encoding conventions
 * ("query: " vs "passage: " for E5 family) live in one place.
 */
import * as path from "path";
import { existsSync } from "fs";
import { createRequire } from "module";
import type { FeatureExtractionPipeline } from "@xenova/transformers";
import { DEFAULT_EMBED_MODEL } from "../scanner/embedding.js";

/**
 * sharp@0.32 stores libvips DLLs in vendor/<ver>/win32-x64/lib/.
 * Windows LoadLibrary won't find them unless the directory is on PATH.
 * In portable builds, the DLLs live inside app.asar.unpacked/ thanks
 * to the asarUnpack config.
 */
function ensureSharpDllPath(): void {
  if (process.platform !== "win32") return;

  const candidates: string[] = [];

  try {
    const req = createRequire(__filename);
    const sharpEntry = req.resolve("sharp");
    const sharpDir = path.dirname(sharpEntry);
    candidates.push(path.join(sharpDir, "vendor"));
  } catch { /* sharp not resolvable — will error later anyway */ }

  if (typeof process.resourcesPath === "string") {
    candidates.push(
      path.join(process.resourcesPath, "app.asar.unpacked", "node_modules", "sharp", "vendor"),
    );
  }

  candidates.push(path.join(process.cwd(), "node_modules", "sharp", "vendor"));

  for (const vendorBase of candidates) {
    const libDir = path.join(vendorBase, "8.14.5", "win32-x64", "lib");
    if (existsSync(libDir)) {
      if (!process.env.PATH?.includes(libDir)) {
        console.log(`[embedder] Adding sharp vendor DLL path: ${libDir}`);
        process.env.PATH = libDir + path.delimiter + (process.env.PATH ?? "");
      }
      return;
    }
  }
  console.warn("[embedder] sharp vendor DLL path not found, embedding may fail");
}

/**
 * Перенаправляет кеш @xenova/transformers (ONNX-модели) из ~/.cache/huggingface
 * в BIBLIARY_DATA_DIR/models — чтобы данные portable-версии жили рядом с .exe,
 * а не разбросано по профилю пользователя Windows.
 */
export function configureTransformersCache(): void {
  const dataDir = process.env.BIBLIARY_DATA_DIR?.trim();
  if (!dataDir) return;
  const modelsDir = path.join(dataDir, "models");
  process.env.TRANSFORMERS_CACHE = modelsDir;
  process.env.HF_HOME = modelsDir;
}

async function loadPipeline(): Promise<typeof import("@xenova/transformers")["pipeline"]> {
  ensureSharpDllPath();
  configureTransformersCache();
  const mod = await import("@xenova/transformers");
  /* Дополнительно задаём через env API трансформеров (v2.x). */
  mod.env.cacheDir = process.env.TRANSFORMERS_CACHE ?? mod.env.cacheDir;
  return mod.pipeline;
}

interface CachedExtractor {
  ready: Promise<FeatureExtractionPipeline>;
  resolved: FeatureExtractionPipeline | null;
}

const cache = new Map<string, CachedExtractor>();

/* AUDIT 2026-04-21: до этой правки ни pipeline init, ни сам вызов экстрактора
   не были обёрнуты таймаутом. Один зависший ONNX inference (например, OOM в
   Wasm runtime, GPU stall) подвешивал весь Bibliary: ingest, RAG-чат, judge.
   Cold-start легитимно длинный (модель ~150MB качается из HF при первом
   запуске), поэтому два разных лимита. */
const COLD_START_TIMEOUT_MS = 120_000;
const EMBED_CALL_TIMEOUT_MS = 15_000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`[embedder] ${label} timed out after ${ms}ms`));
    }, ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/**
 * Lazy-loaded extractor for the given model key. Subsequent callers
 * with the same key get the cached instance; concurrent callers during
 * cold-start await the same in-flight Promise.
 *
 * Cold-start обёрнут в COLD_START_TIMEOUT_MS — если pipeline init завис,
 * сбрасываем кэш чтобы следующий вызов мог попробовать заново вместо
 * вечного зависания.
 */
export async function getEmbedder(model: string = DEFAULT_EMBED_MODEL): Promise<FeatureExtractionPipeline> {
  const existing = cache.get(model);
  if (existing) {
    return existing.resolved ?? existing.ready;
  }
  const ready = withTimeout(
    (async () => {
      const pipelineFn = await loadPipeline();
      const m = await pipelineFn("feature-extraction", model);
      const slot = cache.get(model);
      if (slot) slot.resolved = m;
      return m;
    })(),
    COLD_START_TIMEOUT_MS,
    `cold-start ${model}`,
  ).catch((e) => {
    /* Сбрасываем неудачный init, чтобы следующая попытка не наследовала
       зависший Promise. */
    cache.delete(model);
    throw e;
  });
  cache.set(model, { ready, resolved: null });
  return ready;
}

/**
 * Embed a single passage (used during ingest -- E5 expects the prefix
 * "passage: " for stored vectors).
 */
export async function embedPassage(text: string, model: string = DEFAULT_EMBED_MODEL): Promise<number[]> {
  const extractor = await getEmbedder(model);
  const out = await withTimeout(
    extractor(`passage: ${text}`, { pooling: "mean", normalize: true }),
    EMBED_CALL_TIMEOUT_MS,
    "embedPassage",
  );
  return Array.from(out.data as Float32Array);
}

/**
 * Embed a search query (E5 expects the prefix "query: " for retrieval-
 * time vectors -- different from passage to maximise cross-encoder match).
 */
export async function embedQuery(text: string, model: string = DEFAULT_EMBED_MODEL): Promise<number[]> {
  const extractor = await getEmbedder(model);
  const out = await withTimeout(
    extractor(`query: ${text}`, { pooling: "mean", normalize: true }),
    EMBED_CALL_TIMEOUT_MS,
    "embedQuery",
  );
  return Array.from(out.data as Float32Array);
}

/**
 * L2-normalize a vector in place semantics: returns a fresh array v / ||v||.
 * Используется для пере-нормализации центроидов после арифметического mean
 * нескольких уже-нормализованных эмбеддингов. Без этого центроид имеет
 * ||v|| < 1, и cosine с Chroma-векторами получается заниженным (ложные
 * NOVEL'ы в uniqueness-evaluator).
 *
 * Возвращает копию, чтобы не мутировать input. Если ||v||=0 (degenerate) —
 * возвращает копию без изменений (защита от div-by-zero).
 */
export function l2Normalize(v: number[] | Float32Array): number[] {
  let sumSq = 0;
  for (let i = 0; i < v.length; i++) sumSq += v[i] * v[i];
  const norm = Math.sqrt(sumSq);
  if (norm === 0) return Array.from(v);
  const out = new Array<number>(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / norm;
  return out;
}
