import { promises as fs } from "fs";
import * as path from "path";
import { detectExt } from "../scanner/parsers/index.js";
import { convertBookToMarkdown, replaceFrontmatter, injectCasImageRefs } from "./md-converter.js";
import { getLibraryRoot } from "./paths.js";
import { upsertBook, getBookById, getKnownSha256s } from "./cache-db.js";
import { SUPPORTED_BOOK_EXTS, type BookCatalogMeta, type SupportedBookFormat } from "./types.js";
import { resolveHumanBookPaths } from "./storage-contract.js";
import { computeFileSha256, bookIdFromSha } from "./sha-stream.js";
import { putBlob, getBlobsRoot } from "./library-store.js";
import { extractSphereFromImportPath } from "./path-sanitizer.js";
import { processIllustrations } from "./illustration-worker.js";
import { runIllustrationJob } from "./illustration-semaphore.js";
import { findNearDuplicate, registerForNearDup } from "./near-dup-detector.js";
import { getImportScheduler } from "./import-task-scheduler.js";
import {
  computeRevisionScore,
  findLatestRevisionMatch,
  registerForRevisionDedup,
  findIsbnMatch,
  getFormatPriority,
  replaceBookRevision,
} from "./revision-dedup.js";
import { parseFilename } from "./filename-parser.js";
import type { ImportFolderOptions, ImportResult } from "./import-types.js";

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

function hasPngMagic(buf: Buffer): boolean {
  if (buf.length < 8) return false;
  for (let i = 0; i < 8; i++) {
    if (buf[i] !== PNG_MAGIC[i]) return false;
  }
  return true;
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
     уже в каталоге, экономим всю парсинг-работу.

     Post-Иt 8В audit: оборачиваем в `getImportScheduler().enqueue("light", ...)` —
     это ОЖИВЛЯЕТ light lane, который до сих пор был "архитектурным резервом"
     без production caller'ов. SHA-256 streaming идеально подходит: I/O-bound,
     дешёвый CPU, естественный lightweight async. light concurrency=8 даёт
     до 8 параллельных хешей, видимых в pipeline-status-widget. */
  let sha256: string;
  try {
    sha256 = await getImportScheduler().enqueue("light", () => computeFileSha256(absPath, opts.signal));
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
      ocrAccuracy: opts.ocrAccuracy,
      ocrPdfDpi: opts.ocrPdfDpi,
      djvuRenderDpi: opts.djvuRenderDpi,
      visionMetaEnabled: opts.visionMetaEnabled,
      visionModelKey: opts.visionModelKey,
      metadataOnlineLookup: opts.metadataOnlineLookup,
      onVisionMetaEvent: opts.onVisionMetaEvent
        ? (e) => opts.onVisionMetaEvent!({ ...e, bookFile: path.basename(absPath) })
        : undefined,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return persistFailedImport(absPath, ext as SupportedBookFormat, sha256, msg, warnings, opts.sourceArchive, opts.importRoot);
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

  /* Tier 2: Revision-level дедуп одной и той же книги с разными бинарниками.
     Iter 12 P1.2: HARD+REPLACE strategy — старая ревизия удаляется ПОСЛЕ
     успешного импорта новой (deferred to end of function). */
  const latest = findLatestRevisionMatch(convResult.meta, absPath);
  /** id старой ревизии для replace ПОСЛЕ успешного upsertBook нового. */
  let pendingReplaceOldId: string | null = null;
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
      pendingReplaceOldId = latest.bookId;
      warnings.push(
        `newer revision: superseding ${latest.bookId} (${latest.title}); will replace after successful import`,
      );
    } else {
      warnings.push(`same revision score as ${latest.bookId}; keeping both variants`);
    }
  }

  /* Save images to CAS (.blobs/) and set assetUrl on each ImageRef.
     Skip blobs that are suspiciously small or fail a basic PNG-magic check —
     this prevents broken-icon placeholders in the reader when libvips produces
     a corrupt buffer (known sharp/ORC issue on Windows portable builds). */
  const root = await getLibraryRoot();
  for (const img of convResult.images) {
    if (img.buffer.length < 64) {
      warnings.push(`CAS skipped ${img.id}: buffer too small (${img.buffer.length} bytes)`);
      img.buffer = Buffer.alloc(0);
      continue;
    }
    if (img.mimeType === "image/png" && !hasPngMagic(img.buffer)) {
      warnings.push(`CAS skipped ${img.id}: PNG magic check failed (${img.buffer.length} bytes), image corrupt`);
      img.buffer = Buffer.alloc(0);
      continue;
    }
    try {
      const ref = await putBlob(root, img.buffer, img.mimeType);
      img.assetUrl = ref.assetUrl;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`CAS putBlob failed for ${img.id}: ${msg}`);
    }
  }

  /* Rebuild markdown with CAS asset URLs (no Base64). */
  convResult.markdown = rebuildMarkdownAfterCas(convResult);

  /* Human-readable path: {Sphere}/{Author_Title}/{Title}.md */
  const importRoot = opts.importRoot;
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

  /* Write sidecar manifest next to the markdown:
     <Book Title>.meta.json (new layout) or meta.json (legacy fallback). */
  try {
    await fs.writeFile(stored.metaPath, JSON.stringify(finalMeta, null, 2), "utf-8");
  } catch {
    warnings.push("meta.json write failed (non-critical)");
  }

  /* Write illustrations.json stub.
     score/description are filled later by illustration-worker.ts (Semantic Triage). */
  try {
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
    await fs.writeFile(stored.illustrationsPath, JSON.stringify(illustrationData, null, 2), "utf-8");
  } catch {
    warnings.push("illustrations.json write failed (non-critical)");
  }

  upsertBook(finalMeta, mdPath);
  registerForNearDup(finalMeta, finalMeta.id);
  registerForRevisionDedup(finalMeta);

  /* Iter 12 P1.2: HARD+REPLACE — удалить старую слабую ревизию ТОЛЬКО ПОСЛЕ
     полного успеха нового импорта. Best-effort: ошибка не возвращается как
     failed (новая книга уже в DB), а только пишется в warnings. */
  if (pendingReplaceOldId) {
    try {
      const r = await replaceBookRevision(pendingReplaceOldId, finalMeta);
      if (r.warnings.length > 0) warnings.push(...r.warnings);
      if (r.ok) warnings.push(`replaced old revision ${pendingReplaceOldId} → ${finalMeta.id}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`replaceBookRevision threw (non-fatal): ${msg}`);
    }
  }

  if (convResult.images.length > 0) {
    const blobsRoot = getBlobsRoot(root);
    const { getAppShutdownSignal } = await import("../app-lifecycle.js");
    const appSignal = getAppShutdownSignal();
    const combinedAbort = new AbortController();
    const abortCombined = () => combinedAbort.abort("shutdown");
    if (opts.signal) opts.signal.addEventListener("abort", abortCombined, { once: true });
    appSignal.addEventListener("abort", abortCombined, { once: true });
    /* Прогресс иллюстраций пробрасываем в централизованный import-logger,
       чтобы пользователь видел в UI лог: «обрабатываю img-001, score=8»
       и т.д. Без onProgress всё это уходило только в console main-процесса. */
    const illustrationProgress = (msg: string): void => {
      void (async () => {
        try {
          const { getImportLogger } = await import("./import-logger.js");
          /* Уровень info для нормальных событий, warn для known-failures
             в формате «X failed (non-fatal): ...» из illustration-worker. */
          const level: "info" | "warn" = /failed|error/i.test(msg) ? "warn" : "info";
          await getImportLogger().write({
            importId: "post-import",
            level,
            category: "vision.illustration",
            message: msg,
            file: absPath,
            details: { bookId: finalMeta.id, stage: "illustrations" },
          });
        } catch { /* logger недоступен — продолжаем тихо */ }
      })();
    };
    /* Семафор: max N книг одновременно в illustration pipeline (default 2).
       Без него импорт 100 книг создавал ~100 fire-and-forget jobs × 4
       параллельных vision-чата = до 400 одновременных HTTP к LM Studio,
       что вызывало OOM/таймауты. */
    void runIllustrationJob(() =>
      processIllustrations(bookDir, blobsRoot, combinedAbort.signal, illustrationProgress, {
        mdPath,
        illustrationsPath: stored.illustrationsPath,
        bookTitle: finalMeta.title,
        bookId: finalMeta.id,
      }),
    ).catch(async (err) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[import] illustration processing failed:", msg);
      /* Иллюстрации обрабатываются асинхронно (post-return), поэтому ошибка
         не может попасть в `warnings` исходной задачи. Логируем напрямую в
         centralised import logger — без этого пользователь никогда не узнает
         о провале (раньше ошибка терялась в console main-процесса). */
      try {
        const { getImportLogger } = await import("./import-logger.js");
        await getImportLogger().write({
          importId: "post-import",
          level: "error",
          category: "vision.illustration",
          message: `illustration processing failed for ${finalMeta.titleEn || finalMeta.title || finalMeta.id}: ${msg}`,
          file: absPath,
          details: { bookId: finalMeta.id, stage: "illustrations" },
        });
      } catch { /* logger недоступен — продолжаем тихо */ }
    }).finally(() => {
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
    await fs.writeFile(stored.metaPath, JSON.stringify(meta, null, 2), "utf-8").catch(() => undefined);
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
