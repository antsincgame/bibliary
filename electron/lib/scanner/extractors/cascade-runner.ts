/**
 * Cascade Runner — оркестратор Tier 0 → 1a → 1b → 2.
 *
 * АЛГОРИТМ:
 *   1. Tier 0  (text-layer): попробовать. Если quality >= acceptableQuality — принять, остановить.
 *   2. Tier 1a (tesseract):  попробовать. Если quality >= acceptableQuality — принять, остановить.
 *   3. Tier 1b (system-ocr): попробовать. Если quality >= acceptableQuality — принять, остановить.
 *   4. Tier 2  (vision-llm): попробовать. Принять любой результат.
 *
 *   Если все четыре отдали null или мусор < threshold — вернуть лучшее из имеющегося
 *   (по quality score) с warnings, либо null если вообще ничего.
 *
 *   Tier пропускается если:
 *     - extractor не реализует соответствующий метод (typeof undefined)
 *     - opts.disabledTiers содержит этот tier
 *
 * ПОЧЕМУ Tesseract ПЕРЕД system-ocr (PR #2 Tier-1a):
 *   - Win/Mac: solid Cyrillic. Windows.Media.Ocr берёт ТОЛЬКО первый язык
 *     из preferredLangs — при mixed-language `["en","ru"]` выдаёт latin
 *     homoglyphs для русских букв ("06pa3y" вместо "образу"). Tesseract
 *     нативно multi-language и стабильно даёт solid Cyrillic из коробки.
 *   - Tier 1b system-ocr остаётся как fallback (быстрее на коротких
 *     документах, нет 280ms init overhead).
 *   - vision-llm — только когда оба CPU-tier'а провалились (heavy GPU lane).
 *
 * ИНТЕГРАЦИЯ С КЕШЕМ:
 *   Если opts.fileSha256 + opts.pageIndex заданы — Runner проверяет ocr-cache
 *   перед каждым Tier'ом и сохраняет результат после успешного. Это снимает
 *   повторный OCR при re-import той же книги.
 */

import type {
  CascadeResult,
  ExtractOptions,
  ExtractionAttempt,
  TextExtractor,
} from "./types.js";
import { DEFAULT_ACCEPTABLE_QUALITY } from "./types.js";
import { getCachedOcr, setCachedOcr, type OcrEngine } from "./ocr-cache.js";
import { getOcrDriftMonitor } from "../ocr-drift-monitor.js";

export interface RunCascadeOptions extends ExtractOptions {
  acceptableQuality?: number;
}

/**
 * Запустить каскад на конкретном файле (или странице).
 *
 * Best-effort: исключения внутри одного Tier не валят весь каскад — Runner
 * ловит и переходит к следующему. Это критично для надёжности при ошибках
 * djvutxt или сети LM Studio.
 */
export async function runExtractionCascade(
  extractor: TextExtractor,
  srcPath: string,
  opts: RunCascadeOptions = {},
): Promise<CascadeResult> {
  const acceptableQuality = opts.acceptableQuality ?? DEFAULT_ACCEPTABLE_QUALITY;
  const disabled = new Set<number>(opts.disabledTiers ?? []);
  const attempts: ExtractionAttempt[] = [];

  /* Tier 1a (tesseract) и 1b (system-ocr) оба представлены числом 1 в
     ExtractionAttempt.tier — disabledTiers продолжает фильтровать обоих
     одной записью `1` (backward-compat для caller'ов). Различение
     происходит через поле `engine`. */
  const tiers: Array<{
    tier: 0 | 1 | 2;
    engine: OcrEngine;
    method?: TextExtractor["tryTextLayer"];
  }> = [
    { tier: 0, engine: "text-layer", method: extractor.tryTextLayer?.bind(extractor) },
    { tier: 1, engine: "tesseract",  method: extractor.tryTesseract?.bind(extractor) },
    { tier: 1, engine: "system-ocr", method: extractor.tryOsOcr?.bind(extractor) },
    { tier: 2, engine: "vision-llm", method: extractor.tryVisionLlm?.bind(extractor) },
  ];

  for (const { tier, engine, method } of tiers) {
    if (!method) continue;
    if (disabled.has(tier)) continue;
    if (opts.signal?.aborted) break;

    /* Проверка кеша перед вызовом Tier'а. */
    const cached = await tryGetCached(opts, engine, tier);
    if (cached) {
      attempts.push(cached);
      if (cached.quality >= acceptableQuality) {
        return { attempt: cached, attempts, acceptableQuality };
      }
      continue;
    }

    let attempt: ExtractionAttempt | null = null;
    try {
      attempt = await method(srcPath, opts);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      attempts.push({
        tier,
        engine,
        quality: 0,
        text: "",
        warnings: [`tier ${tier} (${engine}) threw: ${msg.slice(0, 200)}`],
      });
      continue;
    }

    if (!attempt) continue;
    attempts.push(attempt);

    /* Drift-monitor: telemetry-only сигнал для пост-морт анализа.
       Не блокирует пайплайн. Записываем только осмысленный quality (>0). */
    if (attempt.quality > 0) {
      try {
        getOcrDriftMonitor().record(attempt.engine, attempt.quality);
      } catch {
        /* Drift monitor не должен ломать OCR — глотаем любые ошибки. */
      }
    }

    /* Сохраняем в кеш только осмысленный результат (quality > 0). Тот факт что
       Tier «не справился» с quality=0 в кеше нам не нужен — повторный re-import
       должен переоценить (вдруг engine улучшился, либо сменился movellModel). */
    if (attempt.quality > 0) {
      await trySetCached(opts, attempt);
    }

    if (attempt.quality >= acceptableQuality) {
      return { attempt, attempts, acceptableQuality };
    }
  }

  /* Никто не достиг порога — выбираем лучшее из имеющегося. */
  const best = attempts.reduce<ExtractionAttempt | null>((acc, a) => {
    if (!acc) return a;
    return a.quality > acc.quality ? a : acc;
  }, null);

  return { attempt: best, attempts, acceptableQuality };
}

async function tryGetCached(
  opts: RunCascadeOptions,
  engine: OcrEngine,
  tier: 0 | 1 | 2,
): Promise<ExtractionAttempt | null> {
  if (!opts.fileSha256 || opts.pageIndex === undefined) return null;
  const entry = await getCachedOcr(opts.fileSha256, opts.pageIndex, engine);
  if (!entry) return null;
  return {
    tier,
    engine,
    quality: entry.quality,
    text: entry.text,
    warnings: [`tier ${tier} (${engine}): from cache (created ${entry.createdAt})`],
  };
}

async function trySetCached(opts: RunCascadeOptions, attempt: ExtractionAttempt): Promise<void> {
  if (!opts.fileSha256 || opts.pageIndex === undefined) return;
  await setCachedOcr(opts.fileSha256, opts.pageIndex, {
    engine: attempt.engine,
    quality: attempt.quality,
    text: attempt.text,
    createdAt: new Date().toISOString(),
  });
}
