/**
 * Calibre Converter — MOBI/AZW/AZW3/PDB/PRC/CHM/LIT/LRF/RB/SNB → EPUB.
 *
 * Использует системный Calibre (`ebook-convert.exe`) — runtime detection через
 * `resolveCalibreBinary()`. Vendoring не требуется (Calibre большой, ~250 MB+).
 *
 * АРХИТЕКТУРНЫЙ КОНТРАКТ:
 *   - Возвращает `{ kind: "delegate", ext: "epub", path: <tmp>.epub, cleanup }`.
 *     Caller (PARSERS dispatcher) делегирует epubParser.
 *   - Если Calibre не найден — `{ kind: "text-extracted", text: "", warnings }`
 *     с понятным install-hint (НЕ throw — graceful degradation, как в convertDjvu).
 *   - **Heavy lane scheduling**: Calibre конвертация = 5-60 секунд GPU/CPU.
 *     Идёт через `getImportScheduler().enqueue("heavy", convertFn)`. Это первое
 *     реальное использование scheduler в production pipeline (v0.6.0 → v0.7.0).
 *   - Cleanup: caller ОБЯЗАН вызвать `result.cleanup()` в finally — иначе
 *     orphan `.epub` накопятся в tmpdir.
 *
 * Mapping форматов (Calibre → EPUB target):
 *   `.mobi`/`.azw`/`.azw3`/`.azw4` → EPUB ✓ (Kindle native)
 *   `.pdb`/`.prc` → EPUB ✓ (Palm/Mobipocket)
 *   `.chm` → EPUB ✓ (Compiled HTML Help)
 *   `.lit` → EPUB ✓ (MS Reader, deprecated but Calibre support)
 *   `.lrf` → EPUB ✓ (Sony BBeB)
 *   `.rb` → EPUB ✓ (Rocket eBook)
 *   `.snb` → EPUB ✓ (S Note Book)
 *   `.tcr` → EPUB ✓ (Psion text-comp)
 */

import { promises as fs } from "fs";
import * as path from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { resolveCalibreBinary, runEbookConvert, getCalibreInstallHint } from "./calibre-cli.js";
import { getImportScheduler } from "../../library/import-task-scheduler.js";
import { getCachedConvert, setCachedConvert } from "./cache.js";

/* Re-using тип контракта из converters/djvu — single source of truth.
   В Iter 6А не выделяем общий converters/types.ts (premature abstraction
   при 2 converter'ах); если в Iter 6Б появятся ещё CBZ/multi-TIFF/TCR — тогда. */
export type CalibreConvertResult =
  | {
      kind: "text-extracted";
      text: string;
      warnings: string[];
      cleanup: () => Promise<void>;
    }
  | {
      kind: "delegate";
      path: string;
      ext: "epub";
      warnings: string[];
      cleanup: () => Promise<void>;
    };

export interface CalibreConvertOptions {
  signal?: AbortSignal;
  /** Override timeout для ebook-convert. Default 120000 (2 min). */
  timeoutMs?: number;
}

/**
 * Конвертировать legacy формат (MOBI/AZW/CHM/PDB/...) в EPUB через Calibre.
 *
 * Возвращает либо delegate→epub (для парсинга через epubParser), либо
 * text-extracted с empty text + warnings если Calibre отсутствует или сбой.
 *
 * Через scheduler heavy lane — реально лимитирует параллельные Calibre процессы
 * (default heavy concurrency = 1, можно поднять через setLimit для batch import).
 */
export async function convertViaCalibre(
  srcPath: string,
  opts: CalibreConvertOptions = {},
): Promise<CalibreConvertResult> {
  const warnings: string[] = [];
  const ext = path.extname(srcPath).slice(1).toLowerCase();

  /* Iter 6В — Cache check ДО любых тяжёлых операций. Если был успешный convert
     этого файла раньше, и mtime не изменилось — отдаём cached EPUB. */
  const cached = await getCachedConvert(srcPath, ext, "epub");
  if (cached) {
    return {
      kind: "delegate",
      path: cached.path,
      ext: "epub",
      warnings: cached.warnings,
      cleanup: cached.cleanup,
    };
  }

  /* Проверка наличия Calibre — graceful если не установлен. */
  const tool = await resolveCalibreBinary();
  if (!tool) {
    warnings.push(`Calibre not installed — cannot convert ${path.extname(srcPath)} files`);
    warnings.push(getCalibreInstallHint());
    return {
      kind: "text-extracted",
      text: "",
      warnings,
      cleanup: async () => undefined,
    };
  }

  const epubPath = path.join(tmpdir(), `bibliary-calibre-${randomUUID()}.epub`);

  /* Cleanup всегда try-unlink — graceful если Calibre частично создал файл и упал. */
  const cleanupEpub = async (): Promise<void> => {
    await fs.unlink(epubPath).catch((unlinkErr) => {
      if ((unlinkErr as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return;
      console.warn("[converters/calibre] cleanup failed:", unlinkErr);
    });
  };

  try {
    /* Через scheduler heavy lane: первое реальное production использование
       ImportTaskScheduler. Convert тяжёлый (Calibre Python runtime + парсинг
       MOBI/CHM может занять десятки секунд). Heavy concurrency=1 по дефолту
       сериализует Calibre — защищает CPU от 4+ параллельных импортов. */
    const { stderr } = await getImportScheduler().enqueue("heavy", () =>
      runEbookConvert(srcPath, epubPath, {
        signal: opts.signal,
        timeoutMs: opts.timeoutMs,
        /* `--no-default-epub-cover` — не генерировать дефолтную обложку
           (Calibre иначе вставляет "no cover" placeholder). */
        extraArgs: ["--no-default-epub-cover"],
      }),
    );

    /* stderr от Calibre — обычно прогресс/warnings, не ошибка. Сохраняем
       только если содержит явные error markers. */
    if (stderr && /error|fail|exception/i.test(stderr)) {
      warnings.push(`Calibre stderr: ${stderr.slice(0, 200)}`);
    }

    /* Iter 6В — успешный convert → сохраняем в cache (async fire-and-forget,
       не блокируем caller). При повторном импорте этого файла будет hit. */
    void setCachedConvert(srcPath, ext, epubPath, "epub").catch((err) => {
      console.warn("[converters/calibre] cache write failed:", err);
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push(`ebook-convert failed: ${msg.slice(0, 200)}`);
    /* При сбое — вернуть text-extracted с empty text + warnings. Caller увидит
       проблему через warnings, импорт завершится с status="failed". */
    return {
      kind: "text-extracted",
      text: "",
      warnings,
      cleanup: cleanupEpub,
    };
  }

  return {
    kind: "delegate",
    path: epubPath,
    ext: "epub",
    warnings,
    cleanup: cleanupEpub,
  };
}
