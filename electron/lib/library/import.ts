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
import { convertBookToMarkdown, replaceFrontmatter, injectCasImageRefs } from "./md-converter.js";
import { getLibraryRoot } from "./paths.js";
import { upsertBook, getBookById, getKnownSha256s } from "./cache-db.js";
import { extractArchive, isArchive, cleanupExtractedDir } from "./archive-extractor.js";
import { SUPPORTED_BOOK_EXTS, type BookCatalogMeta, type SupportedBookFormat } from "./types.js";
import { resolveStoredBookPaths, resolveHumanBookPaths } from "./storage-contract.js";
import { computeFileSha256, bookIdFromSha } from "./sha-stream.js";
import { putBlob, getBlobsRoot } from "./library-store.js";
import { extractSphereFromImportPath } from "./path-sanitizer.js";
import { processIllustrations } from "./illustration-worker.js";
import { findNearDuplicate, registerForNearDup } from "./near-dup-detector.js";
import {
  computeRevisionScore,
  findLatestRevisionMatch,
  registerForRevisionDedup,
  findIsbnMatch,
  getFormatPriority,
} from "./revision-dedup.js";
import { walkSupportedFiles, COMPOSITE_HTML_SENTINEL } from "./file-walker.js";
import { runWithConcurrency } from "./async-pool.js";
import { ArchiveTracker } from "./archive-tracker.js";
import { parseFilename } from "./filename-parser.js";
import { CrossFormatPreDedup } from "./cross-format-prededup.js";
import { detectCompositeHtmlDir, assembleCompositeHtmlBook } from "./composite-html-detector.js";
import * as os from "os";

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
  /** Расшифровка причины duplicate для UI. */
  duplicateReason?: "duplicate_sha" | "duplicate_isbn" | "duplicate_older_revision";
  /** Существующая книга в каталоге, из-за которой текущая была пропущена. */
  existingBookId?: string;
  existingBookTitle?: string;
}

export interface ImportFolderOptions {
  /** Если true -- сканировать архивы (zip/cbz/rar/7z/cbr) и распаковывать. */
  scanArchives?: boolean;
  /** OCR-флаг для PDF (медленно). По умолчанию false. */
  ocrEnabled?: boolean;
  /** Import root folder (для определения Sphere из первого сегмента пути). */
  importRoot?: string;
  /**
   * Макс. глубина вложенности относительно `folderPath` (см. file-walker).
   * По умолчанию 16. Для «только три уровня папок» передай 3.
   */
  maxDepth?: number;
  /**
   * Опциональный потолок числа обнаруженных книг-задач (для стресс-/smoke-тестов).
   * После достижения лимита обход останавливается; часть папки может остаться не прочитанной.
   */
  maxDiscovered?: number;
  /** Прерывание (например, юзер нажал Stop). */
  signal?: AbortSignal;
  /** Колбэк прогресса: вызывается после каждого файла. */
  onProgress?: (event: ProgressEvent) => void;
  /** Колбэк после успешного импорта -- evaluator-queue его подхватывает. */
  onBookImported?: (meta: BookCatalogMeta) => void;
  /**
   * OCR-провайдер для DJVU. "system" | "vision-llm" | "none". Default "system".
   * Берётся из preferences и пробрасывается в md-converter.
   * "vision-llm" использует локальную vision-модель LM Studio.
   */
  djvuOcrProvider?: "system" | "vision-llm" | "none";
  /** Хинты OCR-языков ("uk", "en", "ru"). Первый — primary для Windows OCR. */
  ocrLanguages?: string[];
  /** Включить Vision LLM extraction метаданных из обложки (через LM Studio). */
  visionMetaEnabled?: boolean;
  /** Override modelKey vision-модели в LM Studio. Пусто = автодетект. */
  visionModelKey?: string;
  /**
   * Колбэк vision-meta событий — для логирования в IPC слой.
   * Импорт каждой книги может вызвать start/success/failed.
   */
  onVisionMetaEvent?: (event: { phase: "start" | "success" | "failed"; bookFile: string; message?: string; durationMs?: number; meta?: unknown }) => void;
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
  duplicateReason?: ImportResult["duplicateReason"];
  existingBookId?: string;
  existingBookTitle?: string;
  /**
   * Текст ошибки или предупреждения для UI/лога. Заполняется когда
   * outcome === "failed" (тогда это error) или когда у успешного файла
   * есть warnings (например, OCR fallback) — тогда это первая warning.
   */
  errorMessage?: string;
  /** Все warnings конкретно этого файла, пробрасываются в UI лог. */
  fileWarnings?: string[];
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
  if (!ext || !(SUPPORTED_BOOK_EXTS as ReadonlySet<string>).has(ext)) {
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
      duplicateReason: "duplicate_sha",
      existingBookId: dupId,
      existingBookTitle: existing?.title,
      warnings: [...warnings, `import: duplicate of ${dupId} (SHA-256 match, parse skipped)`],
      sourceArchive: opts.sourceArchive,
    };
  }

  /* Парсинг + Markdown — sha передаём как precomputed, чтобы не читать файл
     второй раз. Pref'ы (djvuOcrProvider/ocrLanguages/visionMetaEnabled/visionModelKey)
     пробрасываются из IPC слоя — без них локальный Vision LLM не работает на импорте. */
  let convResult;
  try {
    convResult = await convertBookToMarkdown(absPath, {
      ocrEnabled: opts.ocrEnabled === true,
      signal: opts.signal,
      precomputedSha256: sha256,
      djvuOcrProvider: opts.djvuOcrProvider,
      ocrLanguages: opts.ocrLanguages,
      visionMetaEnabled: opts.visionMetaEnabled,
      visionModelKey: opts.visionModelKey,
      onVisionMetaEvent: opts.onVisionMetaEvent
        ? (e) => opts.onVisionMetaEvent!({ ...e, bookFile: path.basename(absPath) })
        : undefined,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return persistFailedImport(absPath, ext as SupportedBookFormat, sha256, msg, warnings, opts.sourceArchive, (opts as ImportFolderOptions).importRoot);
  }
  /* Накопленные warnings — единый список. И в `ImportResult.warnings`
     (transient, для UI), и в `finalMeta.warnings` (persistent, в
     book.md frontmatter). Никаких mergedWarnings/дубликатов. */
  warnings.push(...(convResult.meta.warnings ?? []));

  /* Fallback enrichment from folder/filename when parser metadata is weak. */
  const fnMeta = parseFilename(absPath);
  if (fnMeta) {
    const m = convResult.meta;
    if (!m.author && fnMeta.author) m.author = fnMeta.author;
    if (m.year == null && fnMeta.year) m.year = fnMeta.year;
    if (fnMeta.title && (m.title === path.parse(absPath).name || m.originalFormat === "txt")) {
      m.title = fnMeta.title;
    }
  }

  /* Tier 1: ISBN-based dedup. Same ISBN = same book regardless of filename. */
  const isbnHit = findIsbnMatch(convResult.meta.isbn);
  if (isbnHit && isbnHit.bookId !== convResult.meta.id) {
    const existingPri = getFormatPriority(isbnHit.format ?? "");
    const candidatePri = getFormatPriority(convResult.meta.originalFormat);
    if (candidatePri <= existingPri) {
      return {
        outcome: "duplicate",
        bookId: isbnHit.bookId,
        duplicateReason: "duplicate_isbn" as const,
        existingBookId: isbnHit.bookId,
        existingBookTitle: isbnHit.title,
        warnings: [...warnings, `ISBN match: same book as ${isbnHit.bookId} (${isbnHit.title}), format priority ${candidatePri} <= ${existingPri}`],
        sourceArchive: opts.sourceArchive,
      };
    }
    warnings.push(`ISBN match: better format (${convResult.meta.originalFormat}) supersedes ${isbnHit.bookId} (${isbnHit.title})`);
  }

  /* Tier 2: Revision-level дедуп одной и той же книги с разными бинарниками. */
  const latest = findLatestRevisionMatch(convResult.meta, absPath);
  if (latest && latest.bookId !== convResult.meta.id) {
    const candidateScore = computeRevisionScore(convResult.meta, absPath);
    if (candidateScore < latest.score) {
      const message = `older revision skipped: kept ${latest.bookId} (${latest.title})`;
      return {
        outcome: "duplicate",
        bookId: latest.bookId,
        duplicateReason: "duplicate_older_revision",
        existingBookId: latest.bookId,
        existingBookTitle: latest.title,
        warnings: [...warnings, message],
        sourceArchive: opts.sourceArchive,
      };
    }
    if (candidateScore > latest.score) {
      warnings.push(`newer revision detected: supersedes ${latest.bookId} (${latest.title})`);
    } else {
      warnings.push(`same revision score as ${latest.bookId}; keeping both variants`);
    }
  }

  /* Save images to CAS (.blobs/) and set assetUrl on each ImageRef. */
  const root = await getLibraryRoot();
  for (const img of convResult.images) {
    if (img.buffer.length > 0) {
      try {
        const ref = await putBlob(root, img.buffer, img.mimeType);
        img.assetUrl = ref.assetUrl;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        warnings.push(`CAS putBlob failed for ${img.id}: ${msg}`);
      }
    }
  }

  /* Rebuild markdown with CAS asset URLs (no Base64). */
  convResult.markdown = rebuildMarkdownAfterCas(convResult);

  /* Human-readable path: {Sphere}/{Author_Title}/{Title}.md */
  const importRoot = (opts as ImportFolderOptions).importRoot;
  const stored = await resolveHumanBookPaths(root, convResult.meta, absPath, importRoot);
  const bookDir = stored.bookDir;
  await fs.mkdir(bookDir, { recursive: true });

  /* Copy original file. */
  const originalDest = stored.originalPath;
  try {
    await fs.copyFile(absPath, originalDest);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { outcome: "failed", warnings, error: `copy-original failed: ${msg}`, sourceArchive: opts.sourceArchive };
  }

  /* Near-duplicate soft-warning. */
  const nearDupId = findNearDuplicate(convResult.meta);
  if (nearDupId && nearDupId !== convResult.meta.id) {
    warnings.push(
      `near-duplicate of ${nearDupId} (same title+author+chapters, different SHA)`,
    );
  }

  /* Determine sphere from import root. */
  const sphere = importRoot
    ? extractSphereFromImportPath(absPath, importRoot)
    : "unsorted";

  const finalMeta: BookCatalogMeta = {
    ...convResult.meta,
    originalFile: stored.originalFile,
    sourceArchive: opts.sourceArchive,
    sphere,
    warnings: warnings.length > 0 ? [...warnings] : undefined,
  };

  /* Write markdown with final meta. */
  const mdPath = stored.mdPath;
  const finalMd = rebuildMarkdownWithFinalMeta(convResult.markdown, finalMeta);
  try {
    await fs.writeFile(mdPath, finalMd, "utf-8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { outcome: "failed", warnings, error: `write book.md failed: ${msg}`, sourceArchive: opts.sourceArchive };
  }

  /* Write meta.json manifest. */
  try {
    const metaJsonPath = path.join(bookDir, "meta.json");
    await fs.writeFile(metaJsonPath, JSON.stringify(finalMeta, null, 2), "utf-8");
  } catch {
    warnings.push("meta.json write failed (non-critical)");
  }

  /* Write illustrations.json stub.
     score/description are filled later by illustration-worker.ts (Semantic Triage). */
  try {
    const illustrationsPath = path.join(bookDir, "illustrations.json");
    const illustrationData = convResult.images
      .filter((img) => img.assetUrl)
      .map((img) => ({
        id: img.id,
        sha256: img.assetUrl!.replace("bibliary-asset://sha256/", ""),
        mimeType: img.mimeType,
        bytes: img.buffer.length,
        score: null,
        description: null,
        skipped: false,
        caption: img.caption ?? null,
      }));
    await fs.writeFile(illustrationsPath, JSON.stringify(illustrationData, null, 2), "utf-8");
  } catch {
    warnings.push("illustrations.json write failed (non-critical)");
  }

  upsertBook(finalMeta, mdPath);
  registerForNearDup(finalMeta, finalMeta.id);
  registerForRevisionDedup(finalMeta);

  if (convResult.images.length > 0) {
    const blobsRoot = getBlobsRoot(root);
    const { getAppShutdownSignal } = await import("../app-lifecycle.js");
    const appSignal = getAppShutdownSignal();
    const combinedAbort = new AbortController();
    const abortCombined = () => combinedAbort.abort("shutdown");
    if (opts.signal) opts.signal.addEventListener("abort", abortCombined, { once: true });
    appSignal.addEventListener("abort", abortCombined, { once: true });
    void processIllustrations(bookDir, blobsRoot, combinedAbort.signal).catch(() => {}).finally(() => {
      if (opts.signal) opts.signal.removeEventListener("abort", abortCombined);
      appSignal.removeEventListener("abort", abortCombined);
    });
  }

  return { outcome: "added", bookId: finalMeta.id, meta: finalMeta, warnings, sourceArchive: opts.sourceArchive };
}

/** Заменяет frontmatter в готовом markdown на финальный (после копирования оригинала). */
function rebuildMarkdownWithFinalMeta(markdown: string, finalMeta: BookCatalogMeta): string {
  return replaceFrontmatter(markdown, finalMeta);
}

/** Rebuild markdown to inject CAS asset URLs into the image refs section. */
function rebuildMarkdownAfterCas(conv: { meta: BookCatalogMeta; images: import("./types.js").ImageRef[]; markdown: string }): string {
  return injectCasImageRefs(conv.markdown, conv.images, conv.meta);
}

async function persistFailedImport(
  absPath: string,
  format: SupportedBookFormat,
  sha256: string,
  error: string,
  warnings: string[],
  sourceArchive?: string,
  importRoot?: string,
): Promise<ImportResult> {
  const failureWarning = `parser failed: ${error}`;
  const metaWarnings = [...warnings, failureWarning];
  const fnMeta = parseFilename(absPath);
  const meta: BookCatalogMeta = {
    id: bookIdFromSha(sha256),
    sha256,
    originalFile: `original.${format}`,
    originalFormat: format,
    sourceArchive,
    sphere: importRoot ? extractSphereFromImportPath(absPath, importRoot) : "unsorted",
    title: fnMeta?.title ?? path.parse(absPath).name,
    author: fnMeta?.author,
    year: fnMeta?.year,
    wordCount: 0,
    chapterCount: 0,
    status: "failed",
    warnings: metaWarnings,
  };

  try {
    const root = await getLibraryRoot();
    const stored = await resolveHumanBookPaths(root, meta, absPath, importRoot);
    await fs.mkdir(stored.bookDir, { recursive: true });
    await fs.copyFile(absPath, stored.originalPath);
    const bodyTitle = meta.title.replace(/\r?\n/g, " ").trim() || path.parse(absPath).name;
    const markdown = replaceFrontmatter("---\n---\n\n# Placeholder\n\nImport failed.\n", meta)
      .replace("# Placeholder", `# ${bodyTitle}\n\nImport failed: ${error}`);
    await fs.writeFile(stored.mdPath, markdown, "utf-8");
    upsertBook(meta, stored.mdPath);
    return {
      outcome: "failed",
      bookId: meta.id,
      meta,
      warnings: metaWarnings,
      error,
      sourceArchive,
    };
  } catch (persistErr) {
    const persistMsg = persistErr instanceof Error ? persistErr.message : String(persistErr);
    return {
      outcome: "failed",
      warnings: metaWarnings,
      error: `${error}; fallback import failed: ${persistMsg}`,
      sourceArchive,
    };
  }
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
        if (compositeBook && compositeBook.files.length >= 10) {
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

/**
 * Import a Composite HTML Book (directory of HTML files assembled into one book).
 * Reuses the same storage/dedup logic as importBookFromFile but uses
 * assembleCompositeHtmlBook() instead of a file parser.
 */
async function importCompositeHtmlBook(
  dirPath: string,
  opts: ImportFolderOptions,
  signal: AbortSignal,
): Promise<ImportResult> {
  const warnings: string[] = [];

  const compositeBook = await detectCompositeHtmlDir(dirPath);
  if (!compositeBook || compositeBook.files.length === 0) {
    return { outcome: "skipped", warnings: [`composite-html: empty or undetected dir ${path.basename(dirPath)}`] };
  }

  if (signal.aborted) {
    return { outcome: "skipped", warnings: ["composite-html: aborted"] };
  }

  let parsed;
  try {
    parsed = await assembleCompositeHtmlBook(compositeBook);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { outcome: "failed", warnings, error: `composite-html assemble failed: ${msg}` };
  }

  warnings.push(...(parsed.metadata.warnings ?? []));

  // Build a synthetic SHA from directory path (no single file SHA)
  const { createHash } = await import("crypto");
  const syntheticSha = createHash("sha256").update(`composite-html:${dirPath}`).digest("hex");
  const bookId = bookIdFromSha(syntheticSha);

  // Check SHA dedup
  const known = getKnownSha256s();
  if (known.has(syntheticSha)) {
    const dupId = known.get(syntheticSha)!;
    const existing = getBookById(dupId);
    return {
      outcome: "duplicate",
      bookId: dupId,
      meta: existing ?? undefined,
      duplicateReason: "duplicate_sha",
      existingBookId: dupId,
      existingBookTitle: existing?.title,
      warnings: [...warnings, `composite-html: already imported as ${dupId}`],
    };
  }

  const root = await getLibraryRoot();
  const importRoot = opts.importRoot;
  const sphere = importRoot ? extractSphereFromImportPath(dirPath, importRoot) : "unsorted";

  const wordCount = parsed.sections.reduce(
    (sum, s) => sum + s.paragraphs.reduce((ps, p) => ps + p.split(/\s+/).filter(Boolean).length, 0),
    0,
  );

  const meta: import("./types.js").BookCatalogMeta = {
    id: bookId,
    sha256: syntheticSha,
    originalFile: path.basename(dirPath),
    originalFormat: "html" as import("./types.js").SupportedBookFormat,
    sphere,
    title: compositeBook.inferredTitle,
    wordCount,
    chapterCount: parsed.sections.length,
    status: parsed.sections.length > 0 ? "imported" : "unsupported",
    warnings: warnings.length > 0 ? [...warnings] : undefined,
  };

  // Build markdown
  let markdown = `---\n`;
  markdown += `id: "${bookId}"\n`;
  markdown += `sha256: "${syntheticSha}"\n`;
  markdown += `originalFile: "${path.basename(dirPath)}"\n`;
  markdown += `originalFormat: html\n`;
  markdown += `sphere: "${sphere}"\n`;
  markdown += `title: "${compositeBook.inferredTitle.replace(/"/g, '\\"')}"\n`;
  markdown += `wordCount: ${wordCount}\n`;
  markdown += `chapterCount: ${parsed.sections.length}\n`;
  markdown += `status: ${meta.status}\n`;
  markdown += `---\n\n`;
  markdown += `# ${compositeBook.inferredTitle}\n\n`;
  for (const section of parsed.sections) {
    const heading = "#".repeat(section.level + 1);
    markdown += `${heading} ${section.title}\n\n`;
    for (const p of section.paragraphs) {
      markdown += `${p}\n\n`;
    }
  }

  const stored = await resolveHumanBookPaths(root, meta, dirPath, importRoot);
  await fs.mkdir(stored.bookDir, { recursive: true });

  try {
    await fs.writeFile(stored.mdPath, markdown, "utf-8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { outcome: "failed", warnings, error: `composite-html: write book.md failed: ${msg}` };
  }

  try {
    const metaJsonPath = path.join(stored.bookDir, "meta.json");
    await fs.writeFile(metaJsonPath, JSON.stringify(meta, null, 2), "utf-8");
  } catch {
    warnings.push("meta.json write failed (non-critical)");
  }

  upsertBook(meta, stored.mdPath);
  registerForNearDup(meta, bookId);
  registerForRevisionDedup(meta);

  warnings.push(`composite-html: assembled ${compositeBook.files.length} files from ${path.basename(dirPath)}`);

  if (opts.onBookImported) {
    opts.onBookImported(meta);
  }

  return { outcome: "added", bookId, meta, warnings };
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
