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

export interface PreflightOptions {
  /** Если true — рекурсивно обходим вложенные папки (для folder-flow). */
  recursive?: boolean;
  /** Максимум файлов для полного probe (защита от папок-монстров). По умолчанию 5000. */
  maxFiles?: number;
  /** AbortSignal для отмены длинных preflight'ов. */
  signal?: AbortSignal;
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

  const collected: string[] = [];
  await walkCollect(folderPath, recursive, maxFiles, collected, opts.signal);
  return preflightFiles(collected, { ...opts, _startTime: start });
}

const PREFLIGHT_SUB_TIMEOUT_MS = 10_000;

function withTimeout<T>(promise: Promise<T>, fallback: T, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => {
      const t = setTimeout(() => {
        console.warn(`[preflight] ${label} timed out after ${PREFLIGHT_SUB_TIMEOUT_MS}ms — using fallback`);
        resolve(fallback);
      }, PREFLIGHT_SUB_TIMEOUT_MS);
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

  const [ocr, evaluator, entries] = await Promise.all([
    withTimeout(getOcrCapabilities(), FALLBACK_OCR, "getOcrCapabilities"),
    withTimeout(getEvaluatorReadiness(), FALLBACK_EVALUATOR, "getEvaluatorReadiness"),
    probeAll(paths, opts.signal),
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
      if (recursive) await walkCollect(full, recursive, maxFiles, out, signal);
      continue;
    }
    if (!ent.isFile()) continue;
    const ext = path.extname(ent.name).toLowerCase().replace(/^\./, "");
    if (PREFLIGHT_WALK_EXTS.has(ext)) {
      out.push(full);
    }
  }
}

async function probeAll(paths: ReadonlyArray<string>, signal?: AbortSignal): Promise<PreflightFileEntry[]> {
  const result: PreflightFileEntry[] = [];
  /* Параллельность 4 — не нагружаем диск/IO больше чем нужно для preflight.
     PDF-inspector держит рантайм буфер ~ размер PDF в памяти. */
  const CONCURRENCY = 4;
  let idx = 0;
  async function worker(): Promise<void> {
    while (idx < paths.length) {
      if (signal?.aborted) throw new Error("preflight aborted");
      const myIdx = idx++;
      const p = paths[myIdx];
      const ext = path.extname(p).toLowerCase().replace(/^\./, "");
      if (!PROBED_EXTS.has(ext)) {
        /* Пропускаем — для preflight не интересен (epub/fb2 имеют свой text). */
        continue;
      }
      const entry = await probeOne(p, ext);
      result.push(entry);
    }
  }
  const workers: Promise<void>[] = [];
  for (let i = 0; i < CONCURRENCY; i++) workers.push(worker());
  await Promise.all(workers);
  return result;
}

async function probeOne(filePath: string, ext: string): Promise<PreflightFileEntry> {
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

  if (ext === "djvu" || ext === "djv") {
    try {
      const r = await probeDjvuTextLayer(filePath);
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
      return {
        path: filePath,
        size,
        ext,
        status: "unknown",
        reason: err instanceof Error ? err.message : String(err),
      };
    }
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
