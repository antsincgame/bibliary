/**
 * Preflight scanner — анализирует папку или список файлов ДО старта импорта.
 *
 * Цель: предупредить пользователя что часть файлов — image-only сканы без
 * text-layer'а (типичная проблема старых русских DjVu/PDF), для которых
 * нужен OCR. Если OCR не настроен — эти файлы вернут пусто.
 *
 * Скорость: probe одного DjVu = 1-5 мс (IFF in-process), PDF = 50-200 мс
 * (pdf-inspector). Для 100 файлов общий preflight ~20-30 секунд при PDF
 * heavy папке. DjVu-only — секунды.
 */

import { promises as fs } from "fs";
import * as path from "path";
import { probeDjvuTextLayer } from "../scanner/parsers/djvu-iff-probe.js";
import { probePdfTextLayer } from "../scanner/parsers/pdf-text-probe.js";
import { getOcrCapabilities, type OcrCapabilities } from "./ocr-capabilities.js";
import { getEvaluatorReadiness, type EvaluatorReadiness } from "./evaluator-readiness.js";
import { SUPPORTED_BOOK_EXTS } from "./types.js";

export interface PreflightFileEntry {
  /** Абсолютный путь. */
  path: string;
  /** Размер в байтах. */
  size: number;
  /** Расширение в lower case без точки. */
  ext: string;
  /** "ok" — файл с текст-слоем (быстрый импорт), "image-only" — нужен OCR,
   *  "unknown" — probe не смог определить, "invalid" — magic bytes сломаны. */
  status: "ok" | "image-only" | "unknown" | "invalid";
  /** Диагностика (при unknown/invalid). */
  reason?: string;
}

export interface PreflightReport {
  /** Все обнаруженные DjVu/PDF/etc файлы (после рекурсивного обхода если был). */
  totalFiles: number;
  /** С text-layer'ом. Импортируются быстро, без OCR. */
  okFiles: number;
  /** Image-only сканы. Требуют OCR-движок. */
  imageOnlyFiles: number;
  /** Probe не определил (например слишком большой PDF, или модуль не загрузился). */
  unknownFiles: number;
  /** Битые/не-DjVu/PDF файлы. */
  invalidFiles: number;
  /** Файлы которые preflight не охватил (например EPUB/FB2 — у них всегда text-layer). */
  skippedFiles: number;
  /** OCR readiness — если imageOnlyFiles > 0 и !anyAvailable, импорт image-only безнадёжен. */
  ocr: OcrCapabilities;
  /** Evaluator readiness — если !ready, ВСЕ книги после импорта пометятся `failed`. */
  evaluator: EvaluatorReadiness;
  /** Подробный список файлов — для отображения деталей в UI. */
  entries: PreflightFileEntry[];
  /** Сколько секунд занял preflight (для UI feedback). */
  elapsedMs: number;
}

export type PreflightProgressPhase =
  | "walking"   /* идёт обход папки, считаем файлы */
  | "ocr"       /* проверяем OCR capabilities (system / vision-LLM) */
  | "evaluator" /* проверяем готовность evaluator'а в LM Studio */
  | "probing"   /* пробуем text-layer для DjVu/PDF */
  | "complete"; /* всё готово */

export interface PreflightProgressEvent {
  phase: PreflightProgressPhase;
  /** Сколько файлов обнаружено к этому моменту (walking) или просканировано (probing). */
  current?: number;
  /** Сколько ВСЕГО файлов нужно пройти (только для probing). */
  total?: number;
  /** Текущий путь файла (для probing — последний пробуемый). */
  currentPath?: string;
  /** Чек-точки готовности: ocr/evaluator завершились с этим статусом. */
  status?: "ok" | "skipped" | "timeout" | "failed";
  /** Опциональное человекочитаемое сообщение. */
  message?: string;
}

export interface PreflightOptions {
  /** Если true — рекурсивно обходим вложенные папки (для folder-flow). */
  recursive?: boolean;
  /** Максимум файлов для полного probe (защита от папок-монстров). По умолчанию 5000. */
  maxFiles?: number;
  /** AbortSignal для отмены длинных preflight'ов. */
  signal?: AbortSignal;
  /** Подписка на этапы preflight для UI прогресс-бара. */
  onProgress?: (evt: PreflightProgressEvent) => void;
}

const PROBED_EXTS = new Set(["djvu", "djv", "pdf"]);
/** Те же расширения, что `importFolderToLibrary` через `walkSupportedFiles` — иначе preflight даёт totalFiles=0 и UI не показывает модал. */
const PREFLIGHT_WALK_EXTS = SUPPORTED_BOOK_EXTS as ReadonlySet<string>;

const DEFAULT_MAX_FILES = 5000;

export async function preflightFolder(folderPath: string, opts: PreflightOptions = {}): Promise<PreflightReport> {
  const start = Date.now();
  const stat = await fs.stat(folderPath);
  if (!stat.isDirectory()) {
    throw new Error(`preflightFolder: not a directory: ${folderPath}`);
  }
  const recursive = opts.recursive ?? true;
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;

  const onProgress = opts.onProgress;
  onProgress?.({ phase: "walking", current: 0, message: `scanning ${folderPath}` });

  const collected: string[] = [];
  let lastWalkEmit = Date.now();
  await walkCollect(folderPath, recursive, maxFiles, collected, opts.signal, () => {
    /* эмитим каждые ~250ms или каждые 100 файлов чтобы UI был отзывчив без спама */
    const now = Date.now();
    if (collected.length % 100 === 0 || now - lastWalkEmit > 250) {
      lastWalkEmit = now;
      onProgress?.({ phase: "walking", current: collected.length });
    }
  });
  onProgress?.({ phase: "walking", current: collected.length, status: "ok", message: `found ${collected.length} files` });

  return preflightFiles(collected, { ...opts, _startTime: start });
}

/* LM Studio probe должен быть БЫСТРЫМ — если она offline, ждём максимум 5s
   (раньше было 10s, что плюсом давало двойную задержку для ocr+evaluator). */
const PREFLIGHT_LM_TIMEOUT_MS = 5_000;

function withTimeout<T>(
  promise: Promise<T>,
  fallback: T,
  label: string,
  onTimeout?: () => void,
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => {
      const t = setTimeout(() => {
        console.warn(`[preflight] ${label} timed out after ${PREFLIGHT_LM_TIMEOUT_MS}ms — using fallback`);
        onTimeout?.();
        resolve(fallback);
      }, PREFLIGHT_LM_TIMEOUT_MS);
      t.unref(); /* allow process to exit if nothing else is pending */
    }),
  ]);
}

const FALLBACK_OCR: OcrCapabilities = {
  systemOcr: { available: false, platform: process.platform, languages: [], reason: "preflight timeout" },
  visionLlm: { available: false, reason: "preflight timeout" },
  anyAvailable: false,
};

const FALLBACK_EVALUATOR: EvaluatorReadiness = {
  ready: false,
  reason: "preflight timeout — LM Studio may be unreachable",
  fallbackPolicyEnabled: true,
};

export async function preflightFiles(
  paths: ReadonlyArray<string>,
  opts: PreflightOptions & { _startTime?: number } = {},
): Promise<PreflightReport> {
  const start = opts._startTime ?? Date.now();
  const onProgress = opts.onProgress;

  /* Эмитим старт всех трёх параллельных подзадач, чтобы UI показал чек-листы. */
  onProgress?.({ phase: "ocr", message: "checking OCR capabilities…" });
  onProgress?.({ phase: "evaluator", message: "checking LM Studio…" });
  onProgress?.({ phase: "probing", current: 0, total: paths.length });

  const [ocr, evaluator, entries] = await Promise.all([
    withTimeout(getOcrCapabilities(), FALLBACK_OCR, "getOcrCapabilities", () => {
      onProgress?.({ phase: "ocr", status: "timeout", message: "OCR check timed out" });
    }).then((v) => {
      onProgress?.({ phase: "ocr", status: "ok", message: v.anyAvailable ? "OCR ready" : "OCR not configured" });
      return v;
    }),
    withTimeout(getEvaluatorReadiness(), FALLBACK_EVALUATOR, "getEvaluatorReadiness", () => {
      onProgress?.({ phase: "evaluator", status: "timeout", message: "LM Studio unreachable" });
    }).then((v) => {
      onProgress?.({ phase: "evaluator", status: v.ready ? "ok" : "skipped", message: v.ready ? `evaluator: ${v.willUse}` : (v.reason ?? "no LLM") });
      return v;
    }),
    probeAll(paths, opts.signal, onProgress),
  ]);

  let ok = 0;
  let imageOnly = 0;
  let unknown = 0;
  let invalid = 0;
  let skipped = 0;
  for (const e of entries) {
    if (e.status === "ok") ok++;
    else if (e.status === "image-only") imageOnly++;
    else if (e.status === "unknown") unknown++;
    else if (e.status === "invalid") invalid++;
  }

  /* Skipped — это всё что preflight не пробовал классифицировать (epub, fb2, etc). */
  skipped = paths.length - entries.length;

  onProgress?.({ phase: "complete", current: paths.length, total: paths.length, status: "ok" });

  return {
    totalFiles: paths.length,
    okFiles: ok,
    imageOnlyFiles: imageOnly,
    unknownFiles: unknown,
    invalidFiles: invalid,
    skippedFiles: skipped,
    ocr,
    evaluator,
    entries,
    elapsedMs: Date.now() - start,
  };
}

async function walkCollect(
  dir: string,
  recursive: boolean,
  maxFiles: number,
  out: string[],
  signal?: AbortSignal,
  onFileFound?: () => void,
): Promise<void> {
  if (signal?.aborted) throw new Error("preflight aborted");
  if (out.length >= maxFiles) return;

  let dirents;
  try {
    dirents = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of dirents) {
    if (signal?.aborted) throw new Error("preflight aborted");
    if (out.length >= maxFiles) return;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (recursive) await walkCollect(full, recursive, maxFiles, out, signal, onFileFound);
      continue;
    }
    if (!ent.isFile()) continue;
    const ext = path.extname(ent.name).toLowerCase().replace(/^\./, "");
    if (PREFLIGHT_WALK_EXTS.has(ext)) {
      out.push(full);
      onFileFound?.();
    }
  }
}

async function probeAll(
  paths: ReadonlyArray<string>,
  signal?: AbortSignal,
  onProgress?: (evt: PreflightProgressEvent) => void,
): Promise<PreflightFileEntry[]> {
  const result: PreflightFileEntry[] = [];
  /* Адаптивная параллельность:
     - DjVu IFF-probe читает ≤64 KB → можно высокую параллельность.
     - PDF-inspector буферизует весь файл в памяти → при большой доле PDF держим ниже.
     Для E:\Bibliarifull (1000 DjVu, 0 PDF): CONCURRENCY=16 vs hardcoded 4 = 4x быстрее. */
  const pdfCount = paths.filter((p) => path.extname(p).toLowerCase() === ".pdf").length;
  const CONCURRENCY = pdfCount > 64 ? 6 : pdfCount > 16 ? 8 : 16;
  let idx = 0;
  let processed = 0;
  let lastEmit = Date.now();
  async function worker(): Promise<void> {
    while (idx < paths.length) {
      if (signal?.aborted) throw new Error("preflight aborted");
      const myIdx = idx++;
      const p = paths[myIdx];
      const ext = path.extname(p).toLowerCase().replace(/^\./, "");
      if (!PROBED_EXTS.has(ext)) {
        /* Пропускаем — для preflight не интересен (epub/fb2 имеют свой text). */
        processed++;
        continue;
      }
      const entry = await probeOne(p, ext);
      result.push(entry);
      processed++;
      const now = Date.now();
      if (processed % 25 === 0 || now - lastEmit > 250 || processed === paths.length) {
        lastEmit = now;
        onProgress?.({ phase: "probing", current: processed, total: paths.length, currentPath: p });
      }
    }
  }
  const workers: Promise<void>[] = [];
  for (let i = 0; i < CONCURRENCY; i++) workers.push(worker());
  await Promise.all(workers);
  onProgress?.({ phase: "probing", current: paths.length, total: paths.length, status: "ok" });
  return result;
}

async function probeOne(filePath: string, ext: string): Promise<PreflightFileEntry> {
  if (ext === "djvu" || ext === "djv") {
    /* DjVu probe уже читает fh.stat() внутри — используем r.fileSize, избегая
       двойного stat-вызова на файл. Для 1000 DjVu = 1000 лишних syscall'ов. */
    try {
      const r = await probeDjvuTextLayer(filePath);
      const size = typeof r.fileSize === "number" ? r.fileSize : 0;
      if (!r.valid) {
        return { path: filePath, size, ext, status: "invalid", reason: r.parseError };
      }
      return {
        path: filePath,
        size,
        ext,
        status: r.hasTextLayer ? "ok" : "image-only",
      };
    } catch (err) {
      const code = typeof err === "object" && err !== null && "code" in err
        ? String((err as NodeJS.ErrnoException).code ?? "")
        : "";
      const msg = err instanceof Error ? err.message : String(err);
      return {
        path: filePath,
        size: 0,
        ext,
        status: code === "ENOENT" ? "invalid" : "unknown",
        reason: msg,
      };
    }
  }

  /* PDF и прочие — stat нужен отдельно (probePdfTextLayer сам его не возвращает). */
  let size = 0;
  try {
    size = (await fs.stat(filePath)).size;
  } catch (err) {
    return {
      path: filePath,
      size: 0,
      ext,
      status: "invalid",
      reason: `stat failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (ext === "pdf") {
    try {
      const r = await probePdfTextLayer(filePath);
      if (!r.valid) {
        return { path: filePath, size, ext, status: "invalid", reason: r.parseError };
      }
      if (r.classification === "unknown") {
        return { path: filePath, size, ext, status: "unknown", reason: r.parseError };
      }
      return {
        path: filePath,
        size,
        ext,
        status: r.hasTextLayer ? "ok" : "image-only",
      };
    } catch (err) {
      return {
        path: filePath,
        size,
        ext,
        status: "unknown",
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }

  return { path: filePath, size, ext, status: "unknown", reason: `unprobed extension: ${ext}` };
}

/**
 * Фильтрует список путей, оставляя только те которые НЕ были помечены как
 * image-only в preflight. Используется для действия [Skip image-only] из UI.
 */
export function filterOutImageOnly(paths: ReadonlyArray<string>, report: PreflightReport): string[] {
  const imageOnlySet = new Set(report.entries.filter((e) => e.status === "image-only").map((e) => e.path));
  return paths.filter((p) => !imageOnlySet.has(p));
}

export interface FolderPeekResult {
  /** Сколько файлов поддерживаемых типов найдено (с учётом recursive). */
  totalFiles: number;
  /** Первые N имён (только basename без полного пути), для отображения в confirm-диалоге. */
  sampleNames: string[];
  /** Достиг ли peek лимита maxFiles (значит totalFiles может быть больше). */
  truncated: boolean;
}

/**
 * Быстрый "peek" папки — БЕЗ probe, БЕЗ stat'ов, только readdir+filter.
 * Цель: показать пользователю "Найдено 1024 файла, например: book1.djvu, …" в
 * подтверждающем диалоге сразу после picker'а, ДО старта preflight.
 *
 * Дешевле preflight в 100+ раз: только обход dir entries.
 */
export async function peekFolderFiles(
  folderPath: string,
  opts: { recursive?: boolean; maxFiles?: number; sampleSize?: number } = {},
): Promise<FolderPeekResult> {
  const recursive = opts.recursive ?? true;
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
  const sampleSize = opts.sampleSize ?? 10;
  const collected: string[] = [];
  await walkCollect(folderPath, recursive, maxFiles, collected);
  const sample = collected.slice(0, sampleSize).map((p) => {
    const idx = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
    return idx >= 0 ? p.slice(idx + 1) : p;
  });
  return {
    totalFiles: collected.length,
    sampleNames: sample,
    truncated: collected.length >= maxFiles,
  };
}
