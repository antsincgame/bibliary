/* Use the shared storage contract so import writes the same on-disk layout as batch code. */
/**
 * Library Import Service — единственный способ положить книгу в каталог.
 *
 * Контракт:
 *   1. SHA-256 дедупликация (две одинаковые книги -> одна запись, status сохраняется).
 *   2. Парсинг + Markdown через `convertBookToMarkdown` (CPU-задача, безопасна
 *      рядом с GPU-кристаллизацией).
 *   3. Копирование оригинала в `library/{slug}/original.{ext}` для портативности.
 *   4. Запись `book.md` рядом.
 *   5. Upsert в SQLite-кэш (status='imported').
 *   6. Опциональный push в evaluator-queue (передаётся как callback,
 *      чтобы избежать circular import между import.ts и evaluator-queue.ts).
 *
 * НЕ вызывает LLM. Эвалюация полностью отделена -- queue заберёт книгу позже.
 */

import { promises as fs } from "fs";
import * as path from "path";
import { extractArchive, isArchive, cleanupExtractedDir } from "./archive-extractor.js";
import { SUPPORTED_BOOK_EXTS } from "./types.js";
import { walkSupportedFiles, COMPOSITE_HTML_SENTINEL } from "./file-walker.js";
import { runWithConcurrency } from "./async-pool.js";
import { ArchiveTracker } from "./archive-tracker.js";
import { CrossFormatPreDedup } from "./cross-format-prededup.js";
import { detectCompositeHtmlDir } from "./composite-html-detector.js";
import * as os from "os";
import { importBookFromFile } from "./import-book.js";
import { importCompositeHtmlBook } from "./import-composite-html.js";
import type { ImportResult, ImportFolderOptions, ProgressEvent, ProgressEventPhase, ImportFolderResult } from "./import-types.js";

export type {
  ImportResult,
  ImportFolderOptions,
  ProgressEventPhase,
  ProgressEvent,
  ImportFolderResult,
} from "./import-types.js";

export { importBookFromFile };

/**
 * Импортирует один файл (книгу или архив). Используется IPC handler'ом
 * `library:import-files` для batch'а пользовательских drag&drop. Для папок
 * используется `importFolderToLibrary` (он эффективнее: единый parser pool
 * + tracker архивов вместо локального последовательного цикла).
 *
 * Для архива в этом пути по-прежнему действует sequential-обработка
 * содержимого — это сознательный trade-off: drag&drop = единичные файлы,
 * параллелизм даёт малый выигрыш, а локальная сложность важнее.
 */
export async function importFile(absPath: string, opts: Omit<ImportFolderOptions, "onProgress"> = {}): Promise<ImportResult[]> {
  if (isArchive(absPath)) {
    if (opts.scanArchives === false) {
      return [{ outcome: "skipped", warnings: [`import: archive scanning disabled, skipped ${path.basename(absPath)}`] }];
    }
    return importArchiveSequential(absPath, opts);
  }
  return [await importBookFromFile(absPath, opts)];
}

/** Sequential extraction для drag&drop одного архива. Папочный импорт идёт через expander+pool. */
async function importArchiveSequential(absPath: string, opts: Omit<ImportFolderOptions, "onProgress">): Promise<ImportResult[]> {
  const sourceArchive = path.basename(absPath);
  const extractRes = await extractArchive(absPath);
  const results: ImportResult[] = [];

  if (extractRes.books.length === 0) {
    results.push({ outcome: "skipped", warnings: extractRes.warnings, sourceArchive });
    await cleanupExtractedDir(extractRes.tempDir);
    return results;
  }

  for (const book of extractRes.books) {
    if (opts.signal?.aborted) break;
    const r = await importBookFromFile(book.absPath, { ...opts, sourceArchive });
    if (results.length === 0) r.warnings = [...extractRes.warnings, ...r.warnings];
    results.push(r);
  }

  await cleanupExtractedDir(extractRes.tempDir);
  return results;
}

/**
 * Импорт всей папки рекурсивно. Один вызов = одна транзакция от UI.
 *
 * Архитектура (Фаза 2 «streaming ingest»):
 *   1. Scanner — async generator, идёт по FS параллельно с парсером.
 *      Прогресс начинает течь с первого найденного файла.
 *   2. Parser pool — N одновременных книг (default = cpus-1, override через
 *      ENV `BIBLIARY_PARSER_POOL_SIZE`). CPU-задача безопасна параллельно
 *      с GPU-эвалюацией.
 *   3. Per-file timeout — 8 минут на книгу (битые PDF ловятся в Фазе 3
 *      воркер-тредом, здесь пока taimeout-abort).
 *   4. Counters обновляются по мере завершения slot'ов; порядок выдачи !=
 *      порядку файлов.
 *
 * НЕ запускает эвалюацию -- caller (IPC handler) пушит каждую новую книгу
 * в evaluator-queue через `onBookImported` callback.
 */

/** 8 минут на одну книгу. Pdfjs/EPUB могут зависать на битых файлах — Фаза 3
 *  поднимет таймаут в worker_thread, пока — abort через AbortController. */
const PER_FILE_TIMEOUT_MS = 8 * 60 * 1000;

/**
 * Размер parser pool по умолчанию = cpus-1, минимум 1, максимум 4.
 *
 * Жёсткий ceiling в 4 воркера предотвращает OOM при многочасовых сессиях импорта
 * тяжёлых DJVU-книг (каждый воркер держит ~6–10 MB PNG-буферов + OCR-текст).
 * На 8-ядерной машине cpus-1 = 7 воркеров приводит к heap fragmentation и краш после
 * 4+ часов непрерывного импорта. ENV-override позволяет превысить ceiling для CI/batch.
 */
function resolveParserPoolSize(): number {
  const env = process.env.BIBLIARY_PARSER_POOL_SIZE?.trim();
  if (env) {
    const n = Number(env);
    if (Number.isInteger(n) && n >= 1) return n;
  }
  const cpus = typeof os.cpus === "function" ? os.cpus().length : 1;
  const SAFE_POOL_CEILING = 4;
  return Math.min(Math.max(1, cpus - 1), SAFE_POOL_CEILING);
}

/**
 * Internal task для общего pool'а. `bookPath` — что парсить;
 * `sourceArchive` — basename архива-источника (для трассировки);
 * `archiveTempDir` — temp-папка распаковки (для refcount cleanup в tracker).
 * `extractWarnings` — warnings от extractArchive, прикрепляются к ПЕРВОЙ
 * книге архива (для UI-трассировки причины skipped/failed).
 */
interface ImportTask {
  bookPath: string;
  sourceArchive?: string;
  archiveTempDir?: string;
  extractWarnings?: string[];
  /** When true, bookPath is an HTML directory assembled as a Composite HTML Book. */
  isCompositeHtml?: boolean;
}

export async function importFolderToLibrary(folderPath: string, opts: ImportFolderOptions = {}): Promise<ImportFolderResult> {
  const stat = await fs.stat(folderPath);
  if (!stat.isDirectory()) {
    throw new Error(`importFolderToLibrary: not a directory: ${folderPath}`);
  }

  if (!opts.importRoot) {
    opts.importRoot = folderPath;
  }

  const result: ImportFolderResult = {
    total: 0,
    added: 0,
    duplicate: 0,
    skipped: 0,
    failed: 0,
    warnings: [],
  };

  const counters = { discovered: 0, processed: 0 };
  const emit = (
    phase: ProgressEventPhase,
    extras: Pick<ProgressEvent, "currentFile" | "outcome" | "duplicateReason" | "existingBookId" | "existingBookTitle" | "errorMessage" | "fileWarnings"> = {},
  ): void => {
    if (!opts.onProgress) return;
    opts.onProgress({
      phase,
      discovered: counters.discovered,
      processed: counters.processed,
      currentFile: extras.currentFile,
      outcome: extras.outcome,
      duplicateReason: extras.duplicateReason,
      existingBookId: extras.existingBookId,
      existingBookTitle: extras.existingBookTitle,
      errorMessage: extras.errorMessage,
      fileWarnings: extras.fileWarnings,
      index: counters.processed,
      total: counters.discovered,
    });
  };

  /* Stage 1: streaming scanner. Архивы (если scanArchives=true) yield'ятся
     наравне с обычными книгами — раскрытие происходит в Stage 1.5. */
  const walkOpts: Parameters<typeof walkSupportedFiles>[2] = {
    includeArchives: opts.scanArchives === true,
    signal: opts.signal,
    detectCompositeHtml: true,
    verifyMagic: true,
    onMagicReject: (filePath, reason) => {
      result.warnings.push(`magic-guard: skipped ${path.basename(filePath)} — ${reason}`);
      counters.discovered += 1;
      counters.processed += 1;
      result.skipped += 1;
      emit("discovered");
      emit("processed", {
        currentFile: filePath,
        outcome: "skipped",
        errorMessage: reason,
      });
    },
  };
  if (typeof opts.maxDepth === "number" && Number.isFinite(opts.maxDepth) && opts.maxDepth >= 0) {
    walkOpts.maxDepth = Math.floor(opts.maxDepth);
  }
  const walker = walkSupportedFiles(folderPath, SUPPORTED_BOOK_EXTS, walkOpts);

  /* Tracker управляет lifecycle temp-директорий распакованных архивов:
     cleanup срабатывает после обработки последней книги из архива. */
  const archiveTracker = new ArchiveTracker();

  /* Cross-format pre-dedup: одна инстанция на всю сессию импорта папки.
     Только прямые книжные файлы (не архивы) проверяются здесь.
     Правило: Book.pdf + Book.djvu → один basename, побеждает epub>pdf>djvu.
     Book v1.pdf + Book v2.pdf → разные basename → обе проходят. */
  const crossFormatDedup = new CrossFormatPreDedup();

  /* Stage 1.5: expander. Архивы синхронно распаковывает, yields каждую
     книгу как отдельный ImportTask. Counter `discovered` нарастает по
     числу РЕАЛЬНЫХ книг (не файлов на диске) — пользователь видит то,
     что реально пойдёт в pipeline. */
  const cap = typeof opts.maxDiscovered === "number" && Number.isFinite(opts.maxDiscovered) && opts.maxDiscovered >= 0
    ? Math.floor(opts.maxDiscovered)
    : null;

  async function* expandTasks(): AsyncGenerator<ImportTask> {
    for await (const filePath of walker) {
      if (opts.signal?.aborted) return;
      if (cap !== null && counters.discovered >= cap) break;

      // Composite HTML Book sentinel — detect and yield as single virtual book task
      if (filePath.startsWith(COMPOSITE_HTML_SENTINEL)) {
        const dirPath = filePath.slice(COMPOSITE_HTML_SENTINEL.length);
        const compositeBook = await detectCompositeHtmlDir(dirPath);
        if (compositeBook && compositeBook.files.length > 0) {
          counters.discovered += 1;
          emit("discovered");
          yield { bookPath: dirPath, isCompositeHtml: true };
        }
        continue;
      }

      if (!isArchive(filePath)) {
        // Cross-format pre-dedup: skip if same basename already seen with better format
        const decision = crossFormatDedup.check(filePath);
        if (!decision.include) {
          result.warnings.push(`cross-format dedup: skipped ${path.basename(filePath)} (kept ${path.basename(decision.supersededBy ?? "")})`);
          counters.discovered += 1;
          counters.processed += 1;
          result.skipped += 1;
          emit("discovered");
          emit("processed", { currentFile: filePath, outcome: "skipped" });
          continue;
        }
        counters.discovered += 1;
        emit("discovered");
        yield { bookPath: filePath };
        continue;
      }

      /* Архив — распаковываем сразу, yield'ит каждую книгу. */
      const sourceArchive = path.basename(filePath);
      let extractRes;
      try {
        extractRes = await extractArchive(filePath);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result.warnings.push(`archive ${sourceArchive}: ${msg}`);
        counters.discovered += 1;
        counters.processed += 1;
        result.failed += 1;
        emit("discovered");
        emit("processed", { currentFile: filePath, outcome: "failed" });
        continue;
      }

      if (extractRes.books.length === 0) {
        /* Пустой архив или zip-bomb refused — учитываем как один skipped task,
           чтобы пользователь видел в счётчиках, что архив был и почему. */
        await cleanupExtractedDir(extractRes.tempDir);
        counters.discovered += 1;
        counters.processed += 1;
        result.skipped += 1;
        if (extractRes.warnings.length > 0) result.warnings.push(...extractRes.warnings);
        emit("discovered");
        emit("processed", { currentFile: filePath, outcome: "skipped" });
        continue;
      }

      archiveTracker.register(extractRes.tempDir, extractRes.books.length, () =>
        cleanupExtractedDir(extractRes.tempDir),
      );

      let isFirstBook = true;
      for (const book of extractRes.books) {
        if (opts.signal?.aborted) return;
        if (cap !== null && counters.discovered >= cap) break;
        counters.discovered += 1;
        emit("discovered");
        yield {
          bookPath: book.absPath,
          sourceArchive,
          archiveTempDir: extractRes.tempDir,
          extractWarnings: isFirstBook && extractRes.warnings.length > 0 ? extractRes.warnings : undefined,
        };
        isFirstBook = false;
      }
      if (cap !== null && counters.discovered >= cap) break;
    }
    emit("scan-complete");
  }

  /* Stage 2: parser pool. Конкуренция = cpus-1 (CPU-bound parsing). */
  const poolSize = resolveParserPoolSize();
  const pool = runWithConcurrency(
    expandTasks(),
    poolSize,
    async (task) => {
      emit("file-start", { currentFile: task.bookPath });
      return runImportTaskWithTimeout(task, opts, archiveTracker, PER_FILE_TIMEOUT_MS);
    },
  );

  /* Stage 3: единый sink — копит счётчики, шлёт «processed»-event,
     прокидывает onBookImported в evaluator queue по мере добавления книг. */
  try {
    for await (const settled of pool) {
      if (opts.signal?.aborted) break;
      const itemResults: ImportResult[] = settled.ok
        ? settled.value
        : [{ outcome: "failed", warnings: [], error: settled.error.message }];
      counters.processed += 1;
      let firstOutcome: ImportResult["outcome"] = itemResults[0]?.outcome ?? "failed";
      let firstDuplicateReason: ImportResult["duplicateReason"] | undefined = itemResults[0]?.duplicateReason;
      let firstExistingBookId: string | undefined = itemResults[0]?.existingBookId;
      let firstExistingBookTitle: string | undefined = itemResults[0]?.existingBookTitle;
      let firstError: string | undefined;
      const aggregatedFileWarnings: string[] = [];
      for (const r of itemResults) {
        result[r.outcome] += 1;
        if (r.warnings.length > 0) {
          result.warnings.push(...r.warnings);
          aggregatedFileWarnings.push(...r.warnings);
        }
        /* КРИТИЧНО: r.error больше не теряется. До этого фикса timeout/pool
           failures были видны только в счётчике `failed` без причины. */
        if (r.error) {
          const tagged = `${path.basename(settled.input.bookPath)}: ${r.error}`;
          result.warnings.push(`[ERROR] ${tagged}`);
          if (!firstError) firstError = tagged;
        }
        if (r.outcome === "added" && r.meta && opts.onBookImported) opts.onBookImported(r.meta);
        firstOutcome = r.outcome;
        firstDuplicateReason = r.duplicateReason;
        firstExistingBookId = r.existingBookId;
        firstExistingBookTitle = r.existingBookTitle;
      }
      emit("processed", {
        currentFile: settled.input.bookPath,
        outcome: firstOutcome,
        duplicateReason: firstDuplicateReason,
        existingBookId: firstExistingBookId,
        existingBookTitle: firstExistingBookTitle,
        errorMessage: firstError,
        fileWarnings: aggregatedFileWarnings.length > 0 ? aggregatedFileWarnings : undefined,
      });
    }
  } finally {
    /* На случай abort или throw — очищаем все live temp-папки. Tracker
       идемпотентен, повторная очистка через finishOne уже завершённых
       slot'ов — no-op. */
    await archiveTracker.cleanupAll();
  }

  result.total = counters.processed;
  return result;
}

/**
 * Парсит одну книгу (обычную или из архива) с per-file timeout. После
 * обработки сообщает tracker'у, что одна книга из архива готова — это
 * триггерит cleanup tempDir когда счётчик дойдёт до 0.
 *
 * Per-file timeout (8 мин): если pdfjs/EPUB зависает на битом файле, abort
 * через AbortController; книга помечается failed, партия из 10k не блокируется.
 */
async function runImportTaskWithTimeout(
  task: ImportTask,
  opts: ImportFolderOptions,
  tracker: ArchiveTracker,
  timeoutMs: number,
): Promise<ImportResult[]> {
  const localCtl = new AbortController();
  const cleanup = linkAbortSignal(opts.signal, localCtl);
  let timeoutMessage: string | null = null;
  const timer = setTimeout(() => {
    timeoutMessage = `per-file timeout after ${Math.round(timeoutMs / 1000)}s`;
    localCtl.abort(new Error(timeoutMessage));
  }, timeoutMs);
  try {
    // Composite HTML books are assembled from a directory, not a single file
    if (task.isCompositeHtml) {
      return [await importCompositeHtmlBook(task.bookPath, opts, localCtl.signal)];
    }

    const result = await Promise.race([
      importBookFromFile(task.bookPath, {
        ocrEnabled: opts.ocrEnabled,
        signal: localCtl.signal,
        sourceArchive: task.sourceArchive,
        djvuOcrProvider: opts.djvuOcrProvider,
        ocrLanguages: opts.ocrLanguages,
        visionMetaEnabled: opts.visionMetaEnabled,
        visionModelKey: opts.visionModelKey,
        onVisionMetaEvent: opts.onVisionMetaEvent,
        importRoot: opts.importRoot,
      }),
      new Promise<ImportResult>((_, reject) => {
        localCtl.signal.addEventListener("abort", () => {
          reject(new Error(timeoutMessage ?? "aborted"));
        }, { once: true });
      }),
    ]);
    /* Подмешиваем extract warnings к первой книге архива для трассировки. */
    if (task.extractWarnings && task.extractWarnings.length > 0) {
      result.warnings = [...task.extractWarnings, ...result.warnings];
    }
    return [result];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return [{
      outcome: "failed",
      warnings: task.extractWarnings ? [...task.extractWarnings] : [],
      error: msg,
      sourceArchive: task.sourceArchive,
    }];
  } finally {
    clearTimeout(timer);
    cleanup();
    /* Сигнал tracker'у — одна книга из архива закрыта (success или failure
       не важно, главное что больше не используется). На не-архивных книгах
       (`archiveTempDir === undefined`) tracker делает no-op. */
    await tracker.finishOne(task.archiveTempDir);
  }
}

/** Копирует abort из внешнего сигнала в локальный controller. Возвращает
 *  cleanup-функцию для отписки listener'а (избегает утечки на 50k файлов). */
function linkAbortSignal(
  external: AbortSignal | undefined,
  ctl: AbortController,
): () => void {
  if (!external) return () => {};
  if (external.aborted) {
    ctl.abort();
    return () => {};
  }
  const onAbort = (): void => ctl.abort();
  external.addEventListener("abort", onAbort, { once: true });
  return () => external.removeEventListener("abort", onAbort);
}
