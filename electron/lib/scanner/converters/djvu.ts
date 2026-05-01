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
    await runDdjvuToPdf(srcPath, pdfPath, opts.signal);
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

  return {
    kind: "delegate",
    path: pdfPath,
    ext: "pdf",
    warnings,
    cleanup: cleanupPdfPath,
  };
}
