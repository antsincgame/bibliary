/**
 * DjVu Converter — двухступенчатый по принципу «формат = контейнер».
 *
 * АЛГОРИТМ (см. план smart-import-pipeline.md, Контур 4):
 *
 *   Шаг 1 (LIGHT): runDjvutxt → quality check.
 *     Если есть качественный текстовый слой (80% научно-технических книг)
 *     — возвращаем text-extracted, vision-LLM не нужен. Cover опционально
 *     извлекается через ddjvu -format=tiff -page=1 для отдельного vision_meta.
 *
 *   Шаг 2 (MEDIUM): ddjvu -format=pdf → delegate в обычный pdfParser.
 *     Если текста нет — конвертим DjVu в имиджевый PDF и отдаём существующему
 *     pipeline. pdf-inspector распознает что это Scanned, fallback на OS OCR
 *     (через Universal Cascade — см. extractors/cascade-runner.ts).
 *     Vision-LLM включается только если OS OCR недоступен / вернул пусто.
 *
 * РЕЗУЛЬТАТ:
 *   Для типичной DjVu без vision-LLM:
 *     - 80% случаев: Tier 0 (djvutxt) → готово, 0 LLM запросов
 *     - 18% случаев: Tier 1 (ddjvu→pdf → OS OCR) → 0 LLM запросов
 *     - 2% случаев: Tier 2 (vision-LLM) — реально сложные сканы с handwriting
 *
 *   Раньше провайдер default="auto" гнал vision-LLM на ВСЕ страницы, что
 *   создавало DDoS heavy очереди (см. Итерацию 1 hotfix).
 *
 * АРХИТЕКТУРНЫЙ КОНТРАКТ ConvertResult:
 *   - "text-extracted": текст уже есть, парсер использует его напрямую.
 *   - "delegate": конвертим в другой формат (pdf), парсер делегирует к pdfParser.
 *   - cleanup() ОБЯЗАТЕЛЬНО вызвать в finally — иначе временные файлы накапливаются в tmpdir.
 */

import { promises as fs } from "fs";
import * as path from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { runDdjvuToPdf, runDjvutxt, getDjvuInstallHint } from "../parsers/djvu-cli.js";
import { isQualityText } from "../extractors/quality-heuristic.js";
import { getImportScheduler } from "../../library/import-task-scheduler.js";
import { getCachedConvert, setCachedConvert } from "./cache.js";

export type DjvuConvertResult =
  | {
      kind: "text-extracted";
      text: string;
      warnings: string[];
      cleanup: () => Promise<void>;
    }
  | {
      kind: "delegate";
      path: string;
      ext: "pdf";
      warnings: string[];
      cleanup: () => Promise<void>;
    };

export interface DjvuConvertOptions {
  signal?: AbortSignal;
  /**
   * Уже посчитанный результат `runDjvutxt(srcPath)` от caller'а. Если задан —
   * convertDjvu не вызывает runDjvutxt повторно, экономит секунды на больших
   * файлах. Используется parseDjvu, который сам делает quality check и
   * передаёт сырой текст сюда.
   */
  precomputedText?: string;
}

/**
 * Конвертировать DjVu для дальнейшего парсинга.
 *
 * Возвращает либо извлечённый текст (если djvutxt дал качественный результат),
 * либо путь к временному PDF (если нужна растеризация и OCR).
 *
 * Caller обязан вызвать result.cleanup() в finally.
 */
export async function convertDjvu(
  srcPath: string,
  opts: DjvuConvertOptions = {},
): Promise<DjvuConvertResult> {
  const warnings: string[] = [];

  /* Шаг 1 — пытаемся извлечь готовый OCR-слой. Если caller передал
     precomputedText — используем его (избегаем дублирования с parseDjvu). */
  let text = opts.precomputedText ?? "";
  if (opts.precomputedText === undefined) {
    try {
      text = await runDjvutxt(srcPath, opts.signal);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`djvutxt unavailable or failed: ${msg.slice(0, 140)}`);
      warnings.push(getDjvuInstallHint());
    }
  }

  if (isQualityText(text)) {
    return {
      kind: "text-extracted",
      text,
      warnings,
      cleanup: async () => undefined,
    };
  }

  /* Иt 8В.MAIN.3: cache check ДО expensive ddjvu→pdf конвертации.
     500-page DjVu = 30-60 sec ddjvu + 200 MB PDF. Повторный re-import
     (mtime не изменился) хитит cache мгновенно. Cache key invalidates на
     mtime/size — оригинальный DjVu не должен быть тронут. */
  const cached = await getCachedConvert(srcPath, "djvu", "pdf");
  if (cached) {
    return {
      kind: "delegate",
      path: cached.path,
      ext: "pdf",
      warnings: [...warnings, ...cached.warnings],
      cleanup: cached.cleanup,
    };
  }

  /* Шаг 2 — конвертируем в имиджевый PDF и делегируем pdfParser. */
  const pdfPath = path.join(tmpdir(), `bibliary-djvu-${randomUUID()}.pdf`);
  /* Универсальный cleanup для pdfPath — пытается удалить файл если он существует.
     Используется и в success ветке, и в error ветке: ddjvu мог успеть частично
     записать файл и упасть, оставив orphan в tmpdir. ENOENT silently игнорируется
     (нормальный случай если ddjvu вообще ничего не создал). */
  const cleanupPdfPath = async (): Promise<void> => {
    await fs.unlink(pdfPath).catch((unlinkErr) => {
      if ((unlinkErr as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return;
      console.warn("[converters/djvu] cleanup failed:", unlinkErr);
    });
  };

  try {
    /* Иt 8В.MAIN.1.4: scheduler observability + CPU-fairness — ddjvu -format=pdf
       это CPU-bound растеризация (не GPU). Большая DjVu-книга (300+ страниц,
       150-300 MB) занимает 10-60 секунд при 100% CPU. medium lane (concurrency=3)
       не даёт 4 параллельным импортам одновременно запустить ddjvu и съесть
       все ядра, оставив парсер-пул без CPU. heavy lane (=1) был бы слишком
       строг — ddjvu не конкурирует с GPU-моделями за VRAM. */
    await getImportScheduler().enqueue("medium", () => runDdjvuToPdf(srcPath, pdfPath, opts.signal));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push(`ddjvu -format=pdf failed: ${msg.slice(0, 200)}`);
    warnings.push(getDjvuInstallHint());
    /* Если конвертация в PDF не удалась — возвращаем пустой text-extracted
       с warnings, но cleanup всё равно подключен: ddjvu мог успеть начать
       запись и упасть с partial output. ENOENT-safe. */
    return {
      kind: "text-extracted",
      text: "",
      warnings,
      cleanup: cleanupPdfPath,
    };
  }

  /* Иt 8В.MAIN.3: успешный convert → пишем в cache async (fire-and-forget).
     Кэш скопирует файл в `<cacheDir>/<sha>.pdf` через atomic rename, поэтому
     возвращаемый pdfPath остаётся валидным до cleanup() caller'а. */
  void setCachedConvert(srcPath, "djvu", pdfPath, "pdf").catch((err) => {
    console.warn("[converters/djvu] cache write failed:", err);
  });

  return {
    kind: "delegate",
    path: pdfPath,
    ext: "pdf",
    warnings,
    cleanup: cleanupPdfPath,
  };
}
