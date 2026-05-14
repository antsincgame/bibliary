/**
 * Tesseract.js Tier-1 OCR engine.
 *
 * **Зачем нужен**: на Linux у Bibliary вообще нет system OCR (ни Windows.Media.Ocr,
 * ни macOS Vision Framework). Единственным fallback'ом был vision-LLM (Qwen-VL),
 * который плохо знает кириллицу — пользователи Russian/Ukrainian DjVu получали
 * галиматью даже когда сами страницы прекрасно сканировались.
 *
 * Tesseract имеет solid модели для rus/ukr/eng, скачанные локально (без CDN
 * runtime fetch), и через WASM работает одинаково на Win/macOS/Linux. ~3 секунды
 * на страницу, 80%+ confidence на типичных книжных сканах.
 *
 * **Архитектура**:
 *   - **Worker pool**: один Tesseract worker keep-alive between pages — иначе
 *     каждый page платит ~280ms init overhead. Pool создаётся лениво на первом
 *     `recognizeWithTesseract` и живёт до `disposeTesseract()` (вызываемого в
 *     shutdown teardown).
 *   - **Local tessdata**: шипим `vendor/tessdata/{rus,ukr,eng}.traineddata` через
 *     electron-builder extraResources. В dev — cwd, в packaged Electron —
 *     `process.resourcesPath`. Без CDN зависимости.
 *   - **Languages**: configurable per-call. Reorder Cyrillic-first перед вызовом
 *     (см. `reorderLanguagesForCyrillic`) — Tesseract'у это для PSM/heuristic'и
 *     полезно, хотя в отличие от Win OCR он принимает все языки одновременно.
 *
 * **Returned shape** совпадает с `recognizeImageBuffer` из ocr/index.ts —
 * caller не должен различать tier при обработке результата.
 */

import * as path from "node:path";
import { existsSync } from "node:fs";
import type { OcrPageResult } from "./index.js";

/* Tesseract.js — pure JS + WASM, активный maintenance. v7.0.0 (Dec 2025).
 * Импортируется через CJS interop из ESM-style imports — работает в обоих
 * режимах (ESM dev, CJS bundled через tsc target=commonjs). */
import type { Worker as TesseractWorker } from "tesseract.js";

/** Список поддерживаемых tessdata-моделей которые мы шипим. */
export const BUNDLED_TESSDATA_LANGS = ["rus", "ukr", "eng"] as const;
export type TessdataLang = typeof BUNDLED_TESSDATA_LANGS[number];

/**
 * 2-letter ISO codes (используются в `prefs.ocrLanguages`) → 3-letter Tesseract.
 * Tesseract использует ISO 639-3-style codes ("rus", "ukr", "eng"), не 2-letter.
 */
const ISO_TO_TESS: Record<string, TessdataLang> = {
  ru: "rus",
  uk: "ukr",
  en: "eng",
};

let worker: TesseractWorker | null = null;
let workerLangs: string[] = [];
let workerInitPromise: Promise<TesseractWorker> | null = null;

/**
 * Path к каталогу с .traineddata файлами. Поиск:
 *   1. `<cwd>/vendor/tessdata/`
 *   2. Override через ENV `BIBLIARY_TESSDATA_DIR` для тестов.
 */
function resolveTessdataDir(): string | null {
  const override = process.env.BIBLIARY_TESSDATA_DIR;
  if (override && existsSync(path.join(override, "rus.traineddata"))) return override;

  const cwdCandidate = path.join(process.cwd(), "vendor", "tessdata");
  if (existsSync(path.join(cwdCandidate, "rus.traineddata"))) return cwdCandidate;

  return null;
}

/**
 * Доступен ли Tesseract на этой системе. Возвращает false если bundled tessdata
 * не найден — caller знает что fallback на system OCR / vision-LLM.
 */
export function isTesseractAvailable(): boolean {
  return resolveTessdataDir() !== null;
}

/**
 * Маппинг 2-letter → 3-letter, фильтрация только поддерживаемых. Сохраняем
 * порядок (важно для Tesseract heuristics: первый язык = primary).
 */
function normalizeLanguages(langs: string[]): TessdataLang[] {
  const out: TessdataLang[] = [];
  const seen = new Set<string>();
  for (const code of langs) {
    const lower = code.toLowerCase().trim();
    /* Уже 3-letter? */
    if (BUNDLED_TESSDATA_LANGS.includes(lower as TessdataLang)) {
      if (!seen.has(lower)) { out.push(lower as TessdataLang); seen.add(lower); }
      continue;
    }
    const mapped = ISO_TO_TESS[lower];
    if (mapped && !seen.has(mapped)) {
      out.push(mapped);
      seen.add(mapped);
    }
  }
  /* Если ничего не нашлось — fallback на rus+ukr+eng (lib/preferences default'у). */
  if (out.length === 0) return ["rus", "ukr", "eng"];
  return out;
}

/**
 * Получить или создать worker. Если languages изменились по сравнению с уже
 * созданным worker'ом — terminate и пересоздать (Tesseract не позволяет
 * dynamically менять languages у worker'а в v7).
 */
async function getOrCreateWorker(langs: TessdataLang[]): Promise<TesseractWorker> {
  /* Уже есть worker и langs совпадают? */
  if (worker && langs.length === workerLangs.length && langs.every((l, i) => l === workerLangs[i])) {
    return worker;
  }

  /* Pending init? Дождаться, потом проверить langs. */
  if (workerInitPromise) {
    await workerInitPromise;
    if (worker && langs.every((l, i) => l === workerLangs[i])) return worker;
  }

  /* Создаём новый worker (предыдущий terminate если был). */
  if (worker) {
    try { await worker.terminate(); } catch { /* ignore */ }
    worker = null;
  }

  const tessdataDir = resolveTessdataDir();
  if (!tessdataDir) {
    throw new Error(
      "[tesseract] tessdata not found — expected vendor/tessdata/{rus,ukr,eng}.traineddata " +
      "or process.resourcesPath/vendor/tessdata/. Verify electron-builder.yml extraResources includes vendor/tessdata.",
    );
  }

  workerInitPromise = (async () => {
    /* Late import чтобы tesseract.js не загружался до первого реального
     * recognizeWithTesseract вызова (экономит ~30 MB heap при boot'е). */
    const { createWorker } = await import("tesseract.js");
    const w = await createWorker(langs, 1 /* OEM.LSTM_ONLY */, {
      langPath: tessdataDir,
      gzip: false, /* шипим uncompressed .traineddata */
      logger: () => { /* silent — логи через caller */ },
    });
    worker = w;
    workerLangs = [...langs];
    return w;
  })();

  try {
    return await workerInitPromise;
  } finally {
    workerInitPromise = null;
  }
}

export interface RecognizeWithTesseractOptions {
  /** Список языков из prefs.ocrLanguages (2-letter ISO). */
  languages?: string[];
  /** Page index для error messages / OcrPageResult.pageIndex. */
  pageIndex?: number;
  /** Cooperative cancellation. tesseract.js не поддерживает abort нативно;
   *  мы проверяем перед start'ом, в середине рекогнайз — не прерываем. */
  signal?: AbortSignal;
}

/**
 * Распознать buffer (PNG/JPEG/TIFF/WEBP). Возвращает text + confidence как
 * `OcrPageResult` чтобы caller (DjVu OCR cascade) не знал откуда результат.
 *
 * Performance baseline на 2000×1322 TIFF:
 *   - первый вызов: ~3.4с (init worker 280ms + recognize 3.1с)
 *   - последующие на том же worker'е: ~3.1с per page
 *   - languages change → worker recreate, повтор init overhead
 */
export async function recognizeWithTesseract(
  buffer: Uint8Array,
  options: RecognizeWithTesseractOptions = {},
): Promise<OcrPageResult> {
  if (options.signal?.aborted) {
    throw new Error("[tesseract] aborted before start");
  }
  const langs = normalizeLanguages(options.languages ?? []);
  const w = await getOrCreateWorker(langs);
  if (options.signal?.aborted) {
    throw new Error("[tesseract] aborted before recognize");
  }
  /* tesseract.js типизирует input как Buffer (Node ImageLike), а наш контракт
   * — Uint8Array (как у recognizeImageBuffer в ocr/index.ts). Buffer extends
   * Uint8Array, оборачиваем нулевой копией через Buffer.from с тем же
   * underlying ArrayBuffer. */
  const buf = Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const result = await w.recognize(buf);
  return {
    pageIndex: options.pageIndex ?? 0,
    text: result.data.text,
    /* tesseract.js возвращает confidence в 0..100 шкале; проект API ожидает 0..1. */
    confidence: Math.max(0, Math.min(1, result.data.confidence / 100)),
  };
}

/**
 * Дистрой worker'а. Вызывается в `main.ts` teardownSubsystems. Idempotent —
 * повторные вызовы no-op. Best-effort: ошибки terminate не пробрасываются.
 */
export async function disposeTesseract(): Promise<void> {
  if (!worker) return;
  try {
    await worker.terminate();
  } catch (err) {
    console.warn("[tesseract] terminate failed:", err instanceof Error ? err.message : err);
  } finally {
    worker = null;
    workerLangs = [];
    workerInitPromise = null;
  }
}

/* Test helpers — не использовать в production. */
export function _resetTesseractForTesting(): void {
  worker = null;
  workerLangs = [];
  workerInitPromise = null;
}
