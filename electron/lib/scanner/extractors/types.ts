/**
 * Universal Extractor — Tier 0/1/2 каскад извлечения текста.
 *
 * АРХИТЕКТУРНЫЙ ПРИНЦИП:
 *   Формат — это контейнер. Способ обработки — свойство содержимого, выбираемое
 *   каскадом «от дешёвого к дорогому»:
 *
 *     Tier 0 (FREE):      существующий текстовый слой (djvutxt, pdftotext, mobi text)
 *     Tier 1 (CHEAP):     OS OCR (Windows.Media.Ocr / macOS Vision)
 *     Tier 2 (EXPENSIVE): vision-LLM (Qwen-VL и сородичи)
 *
 * Cascade Runner вызывает Tier'ы по порядку и останавливается на первом, чьё
 * качество (quality score) превышает порог. Это решает корневую проблему DjVu DDoS
 * (см. план smart-import-pipeline.md) и одновременно подходит для PDF/CBZ/multi-TIFF.
 *
 * КОНТРАКТ TextExtractor:
 *   - Каждый Tier возвращает null если НЕ применим (например, Tier 0 для имиджевого PDF
 *     без текстового слоя). Возвращает ExtractionAttempt с quality < 0.5 если применим
 *     но результат «мусор» — Cascade Runner это интерпретирует как «не справился».
 *   - Tier'ы НЕ знают друг о друге — каскад оркестрирует их извне.
 *   - Кеширование (см. ocr-cache.ts) — забота Runner'а или конкретного Tier'а, не type'а.
 */

import type { OcrEngine } from "./ocr-cache.js";

export interface ExtractionAttempt {
  tier: 0 | 1 | 2;
  engine: OcrEngine;
  /** Quality score 0..1. Cascade останавливается если >= acceptableQuality. */
  quality: number;
  text: string;
  /** Опциональный диапазон страниц (для per-page routing). */
  pageRange?: { from: number; to: number };
  warnings: string[];
}

export interface ExtractOptions {
  /** sha256 файла для кеширования. Если undefined — кеш не используется. */
  fileSha256?: string;
  /** Конкретная страница (для per-page Tier'ов). undefined = вся книга. */
  pageIndex?: number;
  /** Языки для OCR подсказок ("ru", "en", "uk"). */
  languages?: string[];
  /** Caller-side abort. Все Tier'ы должны его уважать. */
  signal?: AbortSignal;
  /** Conditional vision модель (override role resolver). */
  visionModelKey?: string;
  /** Принудительно отключить какой-то Tier (например, "только Tier 0+1, без LLM"). */
  disabledTiers?: ReadonlyArray<0 | 1 | 2>;
}

/**
 * Контракт Tier-экстрактора.
 *
 * Реализации:
 *   - DjvuTextLayerExtractor (Tier 0) — обёртка над djvutxt.
 *   - SystemOcrExtractor (Tier 1) — обёртка над @napi-rs/system-ocr.
 *   - VisionLlmExtractor (Tier 2) — обёртка над recognizeWithVisionLlm.
 *
 * Конкретные реализации появляются по мере подключения форматов.
 * Этот файл декларирует только контракт.
 */
export interface TextExtractor {
  /** Tier 0 — бесплатно, без LLM. Возвращает null если не применим к файлу. */
  tryTextLayer?(srcPath: string, opts: ExtractOptions): Promise<ExtractionAttempt | null>;
  /** Tier 1 — дёшево, без LLM (только OS OCR). */
  tryOsOcr?(srcPath: string, opts: ExtractOptions): Promise<ExtractionAttempt | null>;
  /** Tier 2 — дорого, vision-LLM. Используется только когда Tier 0/1 не справились. */
  tryVisionLlm?(srcPath: string, opts: ExtractOptions): Promise<ExtractionAttempt | null>;
}

/**
 * Решение Cascade Runner о выбранной попытке.
 */
export interface CascadeResult {
  /**
   * Выбранная попытка ИЛИ null.
   *
   * Не-null случаи:
   *   - Tier достиг `acceptableQuality` — каскад остановлен на нём, attempt = тот Tier.
   *   - Все Tier'ы отработали, но никто не достиг threshold — attempt = лучший
   *     по quality (reduce max), attempts содержит все попытки для диагностики.
   *
   * null случаи:
   *   - Все Tier'ы вернули null (extractor не имел реализаций ИЛИ все методы
   *     вернули null как «не применимо к этому файлу»).
   *   - Caller прервал через AbortSignal до первого вызова Tier.
   *   - extractor вообще не реализует ни одного tryXxx метода.
   */
  attempt: ExtractionAttempt | null;
  /** Все попытки в порядке вызова — для диагностики и UI телеметрии. */
  attempts: ExtractionAttempt[];
  /** Quality threshold, который определил остановку каскада. */
  acceptableQuality: number;
}

/**
 * Дефолтный порог качества: Tier останавливает каскад если quality >= 0.5.
 * Tier 0 (готовый текст) обычно даёт 0.9+. Tier 1 (OS OCR) — 0.6-0.8.
 * Tier 2 (vision-LLM) — 0.7-0.95. Если все три ниже 0.5 — возвращаем
 * лучшее из имеющегося с warnings.
 */
export const DEFAULT_ACCEPTABLE_QUALITY = 0.5;

/**
 * Максимальная длина строки ошибки в `ExtractionAttempt.warnings[]`. Применяется
 * при ловле throw из system-OCR / vision-LLM в Tier-методах extractor'ов.
 *
 * Зачем константа: длинные stack-trace'ы засоряют `book.md` frontmatter
 * (warnings персистируются туда). 200 chars — компромисс: достаточно для
 * диагностики, но не раздувает frontmatter при scan-PDF на 500 страниц,
 * где могут быть сотни failed-page warnings.
 */
export const MAX_OCR_WARNING_LEN = 200;
