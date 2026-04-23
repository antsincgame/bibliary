/**
 * Evaluator Queue — фоновый воркер pre-flight оценки книг.
 *
 * Контракт:
 *   - На startup читает из cache-db все книги с `status='imported'`
 *     и добавляет их в FIFO.
 *   - Один LLM-вызов за раз (одна GPU -- одна задача), чтобы не конкурировать
 *     с пользовательской кристаллизацией. Если оба запущены -- очередь сама
 *     ждёт пока chatWithPolicy освободит модель.
 *   - При каждом успехе обновляет book.md (frontmatter + Evaluator Reasoning section)
 *     и cache-db (upsertBook).
 *   - При ошибке помечает status='failed' с warning.
 *   - Переживает рестарт: незавершённые `evaluating` при следующем старте
 *     становятся `imported` (мягкий reset).
 *
 * UI получает события через subscribeEvaluator(callback). Никакого WebSocket --
 * простой EventEmitter, IPC handler пробрасывает события в renderer.
 */

import { promises as fs } from "fs";
import { EventEmitter } from "events";
import { getBookById, query, upsertBook } from "./cache-db.js";
import { evaluateBook, pickEvaluatorModel } from "./book-evaluator.js";
import { buildSurrogate } from "./surrogate-builder.js";
import {
  parseFrontmatter,
  parseBookMarkdownChapters,
  replaceFrontmatter,
  upsertEvaluatorReasoning,
} from "./md-converter.js";
import { isAbortError } from "../resilience/lm-request-policy.js";
import type { BookCatalogMeta } from "./types.js";

export interface EvaluatorEvent {
  type: "evaluator.queued" | "evaluator.started" | "evaluator.done" | "evaluator.failed" | "evaluator.idle" | "evaluator.paused" | "evaluator.resumed" | "evaluator.skipped";
  bookId?: string;
  title?: string;
  qualityScore?: number;
  isFictionOrWater?: boolean;
  warnings?: string[];
  error?: string;
  remaining?: number;
}

export interface EvaluatorStatus {
  running: boolean;
  paused: boolean;
  currentBookId: string | null;
  currentTitle: string | null;
  queueLength: number;
  totalEvaluated: number;
  totalFailed: number;
}

const ee = new EventEmitter();
const queue: string[] = [];
const inQueue = new Set<string>();
let currentBookId: string | null = null;
let currentTitle: string | null = null;
let currentController: AbortController | null = null;
let paused = false;
let workerActive = false;
let totalEvaluated = 0;
let totalFailed = 0;
let modelOverride: string | null = null;

function emit(event: EvaluatorEvent): void {
  ee.emit("event", event);
}

/** Подписка на события очереди (для IPC bridge). */
export function subscribeEvaluator(cb: (e: EvaluatorEvent) => void): () => void {
  ee.on("event", cb);
  return () => ee.off("event", cb);
}

export function getEvaluatorStatus(): EvaluatorStatus {
  return {
    running: workerActive,
    paused,
    currentBookId,
    currentTitle,
    queueLength: queue.length,
    totalEvaluated,
    totalFailed,
  };
}

/** Override для модели эвалюатора. null -- авто-выбор через pickEvaluatorModel. */
export function setEvaluatorModel(modelKey: string | null): void {
  modelOverride = modelKey;
}

/** Добавляет книгу в очередь. Идемпотентно: повтор не дублирует. */
export function enqueueBook(bookId: string): void {
  if (inQueue.has(bookId) || currentBookId === bookId) return;
  queue.push(bookId);
  inQueue.add(bookId);
  emit({ type: "evaluator.queued", bookId, remaining: queue.length });
  void runWorker();
}

/** Массовая постановка в очередь -- удобно после batch-импорта. */
export function enqueueMany(bookIds: string[]): void {
  for (const id of bookIds) enqueueBook(id);
}

export function pauseEvaluator(): void {
  if (paused) return;
  paused = true;
  emit({ type: "evaluator.paused" });
}

export function resumeEvaluator(): void {
  if (!paused) return;
  paused = false;
  emit({ type: "evaluator.resumed" });
  void runWorker();
}

/** Прерывает текущую оценку (не очищает очередь). */
export function cancelCurrentEvaluation(reason = "user-cancel"): void {
  if (currentController) currentController.abort(reason);
}

/** Очищает очередь (текущая задача доигрывается). */
export function clearQueue(): void {
  queue.length = 0;
  inQueue.clear();
}

/**
 * Bootstrap при запуске приложения:
 *   1. Читает books WHERE status IN ('imported', 'evaluating') -- последнее
 *      значит "процесс упал во время оценки", сбрасываем в imported.
 *   2. Добавляет всё в очередь.
 *
 * Идемпотентно: повторный вызов не задублирует.
 */
export async function bootstrapEvaluatorQueue(): Promise<void> {
  /* `evaluating` могло остаться с прошлого запуска -- сбрасываем в imported. */
  const stuck = query({ statuses: ["evaluating"], limit: 1000 });
  for (const meta of stuck.rows) {
    const reset: BookCatalogMeta = { ...meta, status: "imported" };
    upsertBook(reset, meta.mdPath);
    /* В book.md тоже -- иначе после rebuildFromFs опять появится evaluating. */
    try {
      const md = await fs.readFile(meta.mdPath, "utf-8");
      await fs.writeFile(meta.mdPath, replaceFrontmatter(md, reset), "utf-8");
    } catch {
      /* tolerate */
    }
  }

  const pending = query({ statuses: ["imported"], limit: 1000 });
  enqueueMany(pending.rows.map((r) => r.id));
}

async function runWorker(): Promise<void> {
  if (workerActive) return;
  workerActive = true;
  try {
    while (true) {
      if (paused) break;
      const next = queue.shift();
      if (!next) break;
      inQueue.delete(next);
      await evaluateOne(next);
    }
  } finally {
    workerActive = false;
    currentBookId = null;
    currentTitle = null;
    currentController = null;
    if (queue.length === 0 && !paused) emit({ type: "evaluator.idle" });
  }
}

async function evaluateOne(bookId: string): Promise<void> {
  const meta = getBookById(bookId);
  if (!meta) {
    emit({ type: "evaluator.skipped", bookId, error: "book not in cache-db" });
    return;
  }
  /* Уже оценена? Тогда пропускаем (на случай race). */
  if (meta.status !== "imported") {
    emit({ type: "evaluator.skipped", bookId, title: meta.title });
    return;
  }

  currentBookId = bookId;
  currentTitle = meta.titleEn ?? meta.title;
  currentController = new AbortController();
  emit({ type: "evaluator.started", bookId, title: currentTitle });

  /* Mark as evaluating -- защита от двойного запуска при rerun. */
  upsertBook({ ...meta, status: "evaluating" }, meta.mdPath);

  try {
    /* 1. Загрузить markdown. */
    const md = await fs.readFile(meta.mdPath, "utf-8");
    const chapters = parseBookMarkdownChapters(md);
    if (chapters.length === 0) {
      const failed: BookCatalogMeta = { ...meta, status: "failed", warnings: [...(meta.warnings ?? []), "evaluator: no chapters parsed from book.md"] };
      upsertBook(failed, meta.mdPath);
      await persistFrontmatter(failed, meta.mdPath, md);
      totalFailed += 1;
      emit({ type: "evaluator.failed", bookId, title: currentTitle, error: "no chapters" });
      return;
    }

    /* 2. Surrogate. */
    const surrogate = buildSurrogate(chapters);

    /* 3. Pick model. Override has priority. */
    const model = modelOverride ?? (await pickEvaluatorModel());
    if (!model) {
      const failed: BookCatalogMeta = { ...meta, status: "failed", warnings: [...(meta.warnings ?? []), "evaluator: no LLM loaded"] };
      upsertBook(failed, meta.mdPath);
      await persistFrontmatter(failed, meta.mdPath, md);
      totalFailed += 1;
      emit({ type: "evaluator.failed", bookId, title: currentTitle, error: "no LLM loaded" });
      return;
    }

    /* 4. LLM call. */
    const result = await evaluateBook(surrogate.surrogate, { model, signal: currentController.signal });
    if (!result.evaluation) {
      const failed: BookCatalogMeta = {
        ...meta,
        status: "failed",
        evaluatorModel: result.model || model,
        evaluatorReasoning: result.reasoning ?? undefined,
        evaluatedAt: new Date().toISOString(),
        warnings: [...(meta.warnings ?? []), ...result.warnings],
      };
      upsertBook(failed, meta.mdPath);
      await persistFrontmatter(failed, meta.mdPath, md, result.reasoning);
      totalFailed += 1;
      emit({ type: "evaluator.failed", bookId, title: currentTitle, error: result.warnings.join("; ") || "evaluation returned null", warnings: result.warnings });
      return;
    }

    /* 5. Build updated meta. */
    const ev = result.evaluation;
    const updated: BookCatalogMeta = {
      ...meta,
      titleEn: ev.title_en,
      authorEn: ev.author_en,
      domain: ev.domain,
      tags: ev.tags,
      qualityScore: ev.quality_score,
      conceptualDensity: ev.conceptual_density,
      originality: ev.originality,
      isFictionOrWater: ev.is_fiction_or_water,
      verdictReason: ev.verdict_reason,
      evaluatorReasoning: result.reasoning ?? undefined,
      evaluatorModel: result.model,
      evaluatedAt: new Date().toISOString(),
      status: "evaluated",
      warnings: result.warnings.length > 0 ? [...(meta.warnings ?? []), ...result.warnings] : meta.warnings,
    };
    upsertBook(updated, meta.mdPath);
    await persistFrontmatter(updated, meta.mdPath, md, result.reasoning);
    totalEvaluated += 1;

    emit({
      type: "evaluator.done",
      bookId,
      title: ev.title_en,
      qualityScore: ev.quality_score,
      isFictionOrWater: ev.is_fiction_or_water,
      warnings: result.warnings.length > 0 ? result.warnings : undefined,
    });
  } catch (err) {
    /* Сверяем abort через единый helper (проверяет ABORT_SENTINEL или
       /aborted/i) -- консистентно с lm-request-policy и judge.ts.
       Раньше string.includes("abort") мог ложно срабатывать на любое
       сообщение со словом "abort" внутри (например, "system abort log"). */
    const msg = err instanceof Error ? err.message : String(err);
    if (isAbortError(err) || currentController?.signal.aborted) {
      upsertBook({ ...meta, status: "imported" }, meta.mdPath);
      emit({ type: "evaluator.skipped", bookId, title: currentTitle, error: "aborted" });
    } else {
      const failed: BookCatalogMeta = { ...meta, status: "failed", warnings: [...(meta.warnings ?? []), `evaluator: ${msg}`] };
      upsertBook(failed, meta.mdPath);
      try {
        const md = await fs.readFile(meta.mdPath, "utf-8");
        await persistFrontmatter(failed, meta.mdPath, md);
      } catch {
        /* tolerate */
      }
      totalFailed += 1;
      emit({ type: "evaluator.failed", bookId, title: currentTitle, error: msg });
    }
  }
}

/** Атомарно перезаписывает frontmatter в book.md и (опционально) Evaluator Reasoning секцию. */
async function persistFrontmatter(meta: BookCatalogMeta, mdPath: string, md: string, reasoning?: string | null): Promise<void> {
  let next = replaceFrontmatter(md, meta);
  if (reasoning !== undefined) next = upsertEvaluatorReasoning(next, reasoning);
  await fs.writeFile(mdPath, next, "utf-8");
}

/** Тестовый helper: сбрасывает все счётчики и состояние. Только для unit-tests. */
export function _resetEvaluatorForTests(): void {
  queue.length = 0;
  inQueue.clear();
  currentBookId = null;
  currentTitle = null;
  currentController = null;
  paused = false;
  workerActive = false;
  totalEvaluated = 0;
  totalFailed = 0;
  modelOverride = null;
  ee.removeAllListeners();
}

/* Re-export parser helper -- удобно для тестов. */
export { parseFrontmatter };
