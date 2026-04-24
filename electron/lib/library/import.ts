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
import { detectExt, type SupportedExt } from "../scanner/parsers/index.js";
import { convertBookToMarkdown, replaceFrontmatter } from "./md-converter.js";
import { getLibraryRoot } from "./paths.js";
import { upsertBook, getBookById, getKnownSha256s } from "./cache-db.js";
import { extractArchive, isArchive, cleanupExtractedDir } from "./archive-extractor.js";
import type { BookCatalogMeta } from "./types.js";
import { resolveStoredBookPaths } from "./storage-contract.js";
import { computeFileSha256 } from "./sha-stream.js";
import { findNearDuplicate, registerForNearDup } from "./near-dup-detector.js";
import { walkSupportedFiles } from "./file-walker.js";
import { runWithConcurrency } from "./async-pool.js";
import { ArchiveTracker } from "./archive-tracker.js";
import * as os from "os";

const SUPPORTED_BOOK_EXTS: ReadonlySet<SupportedExt> = new Set(["pdf", "epub", "fb2", "txt", "docx"]);

export interface ImportResult {
  /** "added" -- новая книга. "duplicate" -- уже была (SHA совпал). "skipped" -- неподдерживаемый формат. "failed" -- ошибка парсинга. */
  outcome: "added" | "duplicate" | "skipped" | "failed";
  bookId?: string;
  meta?: BookCatalogMeta;
  warnings: string[];
  /** Текст ошибки если outcome='failed'. */
  error?: string;
  /** Имя архива-источника, если книга пришла из распаковки. */
  sourceArchive?: string;
}

export interface ImportFolderOptions {
  /** Если true -- сканировать архивы (zip/cbz/rar/7z/cbr) и распаковывать. */
  scanArchives?: boolean;
  /** OCR-флаг для PDF (медленно). По умолчанию false. */
  ocrEnabled?: boolean;
  /** Прерывание (например, юзер нажал Stop). */
  signal?: AbortSignal;
  /** Колбэк прогресса: вызывается после каждого файла. */
  onProgress?: (event: ProgressEvent) => void;
  /** Колбэк после успешного импорта -- evaluator-queue его подхватывает. */
  onBookImported?: (meta: BookCatalogMeta) => void;
}

/**
 * Прогресс импорта. Streaming-friendly: scanner и parser работают параллельно,
 * поэтому событий два типа.
 *
 *  - `phase: "discovered"` — scanner нашёл ещё одну книгу, парсер ещё не
 *    подходил. `discovered` нарастает; `processed`/`outcome`/`currentFile`
 *    отсутствуют. Таких событий = ровно столько, сколько файлов в папке.
 *  - `phase: "scan-complete"` — обход FS завершён; `discovered` финально.
 *  - `phase: "processed"` — конкретный файл обработан (added/duplicate/...).
 *    Содержит `currentFile`, `outcome` и накопленные счётчики.
 *
 * Backward-compat поля `index` и `total`: дублируют `processed`/`discovered`,
 * чтобы старый UI-код не падал. Для новых интеграций — читать `phase`.
 */
export type ProgressEventPhase = "discovered" | "processed" | "scan-complete";

export interface ProgressEvent {
  phase: ProgressEventPhase;
  /** Сколько файлов уже найдено сканером (нарастает). */
  discovered: number;
  /** Сколько файлов уже прошли через парсер (≤ discovered). */
  processed: number;
  /** Только для phase="processed". */
  currentFile?: string;
  outcome?: ImportResult["outcome"];
  /** Backward-compat: старый UI читает index/total. */
  index: number;
  total: number;
}

export interface ImportFolderResult {
  total: number;
  added: number;
  duplicate: number;
  skipped: number;
  failed: number;
  warnings: string[];
}

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

/** Импорт одной книги. Внутренний инвариант: caller гарантирует supported format. */
export async function importBookFromFile(
  absPath: string,
  opts: Omit<ImportFolderOptions, "onProgress" | "scanArchives"> & { sourceArchive?: string } = {},
): Promise<ImportResult> {
  const warnings: string[] = [];
  const ext = detectExt(absPath);
  if (!ext || !SUPPORTED_BOOK_EXTS.has(ext)) {
    return { outcome: "skipped", warnings: [`import: unsupported format ${path.extname(absPath)}`], sourceArchive: opts.sourceArchive };
  }

  /* SHA-256 потоково (см. sha-stream.ts) — считаем ДО парсинга. Парсинг
     5–500 МБ книги стоит секунды CPU; SHA — миллисекунды чтения. Если файл
     уже в каталоге, экономим всю парсинг-работу. */
  let sha256: string;
  try {
    sha256 = await computeFileSha256(absPath, opts.signal);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { outcome: "failed", warnings, error: `sha-256 failed: ${msg}`, sourceArchive: opts.sourceArchive };
  }

  /* Дедуп по SHA-256 содержимого ДО парсинга — главная экономия CPU при
     повторном импорте папки. */
  const known = getKnownSha256s();
  const dupId = known.get(sha256);
  if (dupId) {
    const existing = getBookById(dupId);
    return {
      outcome: "duplicate",
      bookId: dupId,
      meta: existing ?? undefined,
      warnings: [...warnings, `import: duplicate of ${dupId} (SHA-256 match, parse skipped)`],
      sourceArchive: opts.sourceArchive,
    };
  }

  /* Парсинг + Markdown — sha передаём как precomputed, чтобы не читать файл
     второй раз. */
  let convResult;
  try {
    convResult = await convertBookToMarkdown(absPath, {
      ocrEnabled: opts.ocrEnabled === true,
      signal: opts.signal,
      precomputedSha256: sha256,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { outcome: "failed", warnings, error: msg, sourceArchive: opts.sourceArchive };
  }
  /* Накопленные warnings — единый список. И в `ImportResult.warnings`
     (transient, для UI), и в `finalMeta.warnings` (persistent, в
     book.md frontmatter). Никаких mergedWarnings/дубликатов. */
  warnings.push(...(convResult.meta.warnings ?? []));

  /* Подготавливаем папку library/{slug}/. Slug = meta.id (16 hex SHA content). */
  const root = await getLibraryRoot();
  const stored = resolveStoredBookPaths(root, convResult.meta.id, convResult.meta.originalFormat);
  const bookDir = stored.bookDir;
  await fs.mkdir(bookDir, { recursive: true });

  /* Копируем оригинал. Имя файла нормализуем как `original.{ext}`. */
  const originalDest = stored.originalPath;
  try {
    await fs.copyFile(absPath, originalDest);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { outcome: "failed", warnings, error: `copy-original failed: ${msg}`, sourceArchive: opts.sourceArchive };
  }

  /* Near-duplicate check (PDF/EPUB одной книги): только soft-warning, без
     автомёрджа. Пользователь увидит подсказку в UI и сам решит судьбу. */
  const nearDupId = findNearDuplicate(convResult.meta);
  if (nearDupId && nearDupId !== convResult.meta.id) {
    warnings.push(
      `near-duplicate of ${nearDupId} (same title+author+chapters, different SHA)`,
    );
  }

  /* Финальная meta: originalFile = "original.{ext}", sourceArchive,
     warnings — тот же агрегированный список (parser + near-dup). */
  const finalMeta: BookCatalogMeta = {
    ...convResult.meta,
    originalFile: stored.originalFile,
    sourceArchive: opts.sourceArchive,
    warnings: warnings.length > 0 ? [...warnings] : undefined,
  };

  /* Перестраиваем markdown с финальной meta (новый frontmatter). */
  const mdPath = stored.mdPath;
  const finalMd = rebuildMarkdownWithFinalMeta(convResult.markdown, finalMeta);
  try {
    await fs.writeFile(mdPath, finalMd, "utf-8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { outcome: "failed", warnings, error: `write book.md failed: ${msg}`, sourceArchive: opts.sourceArchive };
  }

  upsertBook(finalMeta, mdPath);
  registerForNearDup(finalMeta, finalMeta.id);

  return { outcome: "added", bookId: finalMeta.id, meta: finalMeta, warnings, sourceArchive: opts.sourceArchive };
}

/** Заменяет frontmatter в готовом markdown на финальный (после копирования оригинала). */
function rebuildMarkdownWithFinalMeta(markdown: string, finalMeta: BookCatalogMeta): string {
  return replaceFrontmatter(markdown, finalMeta);
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

/** Размер parser pool по умолчанию = cpus-1, минимум 1. ENV-override. */
function resolveParserPoolSize(): number {
  const env = process.env.BIBLIARY_PARSER_POOL_SIZE?.trim();
  if (env) {
    const n = Number(env);
    if (Number.isInteger(n) && n >= 1) return n;
  }
  const cpus = typeof os.cpus === "function" ? os.cpus().length : 1;
  return Math.max(1, cpus - 1);
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
}

export async function importFolderToLibrary(folderPath: string, opts: ImportFolderOptions = {}): Promise<ImportFolderResult> {
  const stat = await fs.stat(folderPath);
  if (!stat.isDirectory()) {
    throw new Error(`importFolderToLibrary: not a directory: ${folderPath}`);
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
    extras: Pick<ProgressEvent, "currentFile" | "outcome"> = {},
  ): void => {
    if (!opts.onProgress) return;
    opts.onProgress({
      phase,
      discovered: counters.discovered,
      processed: counters.processed,
      currentFile: extras.currentFile,
      outcome: extras.outcome,
      index: counters.processed,
      total: counters.discovered,
    });
  };

  /* Stage 1: streaming scanner. Архивы (если scanArchives=true) yield'ятся
     наравне с обычными книгами — раскрытие происходит в Stage 1.5. */
  const walker = walkSupportedFiles(folderPath, SUPPORTED_BOOK_EXTS, {
    includeArchives: opts.scanArchives === true,
    signal: opts.signal,
  });

  /* Tracker управляет lifecycle temp-директорий распакованных архивов:
     cleanup срабатывает после обработки последней книги из архива. */
  const archiveTracker = new ArchiveTracker();

  /* Stage 1.5: expander. Архивы синхронно распаковывает, yields каждую
     книгу как отдельный ImportTask. Counter `discovered` нарастает по
     числу РЕАЛЬНЫХ книг (не файлов на диске) — пользователь видит то,
     что реально пойдёт в pipeline. */
  async function* expandTasks(): AsyncGenerator<ImportTask> {
    for await (const filePath of walker) {
      if (opts.signal?.aborted) return;

      if (!isArchive(filePath)) {
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
    }
    emit("scan-complete");
  }

  /* Stage 2: parser pool. Конкуренция = cpus-1 (CPU-bound parsing). */
  const poolSize = resolveParserPoolSize();
  const pool = runWithConcurrency(
    expandTasks(),
    poolSize,
    async (task) => runImportTaskWithTimeout(task, opts, archiveTracker, PER_FILE_TIMEOUT_MS),
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
      for (const r of itemResults) {
        result[r.outcome] += 1;
        if (r.warnings.length > 0) result.warnings.push(...r.warnings);
        if (r.outcome === "added" && r.meta && opts.onBookImported) opts.onBookImported(r.meta);
        firstOutcome = r.outcome;
      }
      emit("processed", { currentFile: settled.input.bookPath, outcome: firstOutcome });
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
  const timer = setTimeout(() => {
    localCtl.abort(new Error(`per-file timeout after ${Math.round(timeoutMs / 1000)}s`));
  }, timeoutMs);
  try {
    const result = await importBookFromFile(task.bookPath, {
      ocrEnabled: opts.ocrEnabled,
      signal: localCtl.signal,
      sourceArchive: task.sourceArchive,
    });
    /* Подмешиваем extract warnings к первой книге архива для трассировки. */
    if (task.extractWarnings && task.extractWarnings.length > 0) {
      result.warnings = [...task.extractWarnings, ...result.warnings];
    }
    return [result];
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
