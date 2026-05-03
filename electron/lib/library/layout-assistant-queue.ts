/**
 * Layout Assistant Queue — async opt-in очередь пост-обработки book.md.
 *
 * В отличие от evaluator-queue: single-slot (1.5B model на CPU не имеет смысла
 * параллелить), opt-in (триггерится только при `prefs.layoutAssistantEnabled`),
 * не блокирует импорт.
 *
 * Контракт идемпотентности:
 *   - `enqueueLayoutBook(id)` — повторная постановка той же книги ignored
 *     пока она в очереди или активно обрабатывается.
 *   - Если книга уже имеет marker — `runLayoutAssistant` вернёт applied:false
 *     и мы перейдём к следующей.
 *
 * Bootstrap: на app start читаем `imported` книги, если prefs.enabled —
 * добавляем в очередь.
 */

import { EventEmitter } from "events";
import { getBookById, streamBookIdsByStatus } from "./cache-db.js";
import { runLayoutAssistant } from "./layout-assistant.js";
import { readPipelinePrefsOrNull } from "../preferences/store.js";
import type { BookStatus } from "./types.js";

export interface LayoutAssistantEvent {
  type:
    | "layout.queued"
    | "layout.started"
    | "layout.done"
    | "layout.skipped"
    | "layout.failed"
    | "layout.idle"
    | "layout.paused"
    | "layout.resumed";
  bookId?: string;
  title?: string;
  applied?: boolean;
  chunksOk?: number;
  chunksFailed?: number;
  warnings?: string[];
  error?: string;
  remaining?: number;
}

export interface LayoutAssistantStatus {
  running: boolean;
  paused: boolean;
  currentBookId: string | null;
  queueLength: number;
  totalProcessed: number;
  totalSkipped: number;
  totalFailed: number;
}

const ee = new EventEmitter();
const queue: string[] = [];
const inQueue = new Set<string>();
const paused = { value: false };
let activeBookId: string | null = null;
let slotRunning = false;
let totalProcessed = 0;
let totalSkipped = 0;
let totalFailed = 0;
let abortController: AbortController | null = null;

function emit(evt: LayoutAssistantEvent): void {
  ee.emit("event", evt);
}

export function subscribeLayoutAssistant(cb: (evt: LayoutAssistantEvent) => void): () => void {
  ee.on("event", cb);
  return () => {
    ee.off("event", cb);
  };
}

export function getLayoutAssistantStatus(): LayoutAssistantStatus {
  return {
    running: slotRunning,
    paused: paused.value,
    currentBookId: activeBookId,
    queueLength: queue.length,
    totalProcessed,
    totalSkipped,
    totalFailed,
  };
}

/**
 * Поставить книгу в очередь. Идемпотентно.
 *
 * Проверка enabled flag — НЕ здесь. Caller (import hook B9) уже проверил.
 * Это позволяет вручную ставить книги через IPC даже когда auto-режим OFF.
 */
export function enqueueLayoutBook(bookId: string): void {
  if (!bookId || typeof bookId !== "string") return;
  if (inQueue.has(bookId)) return;
  if (activeBookId === bookId) return;
  queue.push(bookId);
  inQueue.add(bookId);
  emit({ type: "layout.queued", bookId, remaining: queue.length });
  void runSlot();
}

export function pauseLayoutAssistant(): void {
  if (paused.value) return;
  paused.value = true;
  emit({ type: "layout.paused" });
}

export function resumeLayoutAssistant(): void {
  if (!paused.value) return;
  paused.value = false;
  emit({ type: "layout.resumed" });
  void runSlot();
}

export function cancelCurrentLayoutAssistant(reason: string): void {
  if (abortController) {
    abortController.abort(reason);
  }
}

export function clearLayoutAssistantQueue(): void {
  queue.length = 0;
  inQueue.clear();
}

async function runSlot(): Promise<void> {
  if (slotRunning) return;
  if (paused.value) return;
  slotRunning = true;
  try {
    while (queue.length > 0 && !paused.value) {
      const bookId = queue.shift();
      if (!bookId) break;
      inQueue.delete(bookId);
      await processOne(bookId);
    }
  } finally {
    slotRunning = false;
    activeBookId = null;
    abortController = null;
    if (queue.length === 0) emit({ type: "layout.idle" });
  }
}

async function processOne(bookId: string): Promise<void> {
  const meta = getBookById(bookId);
  if (!meta) {
    emit({ type: "layout.failed", bookId, error: "book not found in cache-db" });
    totalFailed++;
    return;
  }
  activeBookId = bookId;
  abortController = new AbortController();
  emit({ type: "layout.started", bookId, title: meta.title });

  /* Bug 4 fix: внешний withBookMdLock удалён. runLayoutAssistant теперь
     сам берёт lock ТОЛЬКО на write-фазу и детектирует concurrent edits через
     hash-check. LLM inference (~10 min на CPU) больше не блокирует evaluator. */
  try {
    const result = await runLayoutAssistant(meta.mdPath, { signal: abortController!.signal });
    if (result.applied) {
      totalProcessed++;
      emit({
        type: "layout.done",
        bookId,
        title: meta.title,
        applied: true,
        chunksOk: result.chunksOk,
        chunksFailed: result.chunksFailed,
        warnings: result.warnings,
      });
    } else {
      totalSkipped++;
      emit({
        type: "layout.skipped",
        bookId,
        title: meta.title,
        applied: false,
        chunksOk: result.chunksOk,
        chunksFailed: result.chunksFailed,
        warnings: result.warnings,
        error: result.error,
      });
    }
  } catch (e) {
    totalFailed++;
    emit({
      type: "layout.failed",
      bookId,
      title: meta.title,
      error: e instanceof Error ? e.message : String(e),
    });
  } finally {
    activeBookId = null;
    abortController = null;
  }
}

/**
 * Bootstrap: при старте приложения, если `prefs.layoutAssistantEnabled` —
 * найти все `imported` книги БЕЗ marker и добавить в очередь.
 *
 * Не падает, если prefs не инициализированы (тестовая среда).
 */
export async function bootstrapLayoutAssistantQueue(): Promise<void> {
  try {
    let enabled = false;
    try {
      const prefs = await readPipelinePrefsOrNull();
      enabled = prefs?.layoutAssistantEnabled === true;
    } catch {
      /* prefs не инициализированы — пропускаем bootstrap. */
      return;
    }
    if (!enabled) return;

    const statuses: BookStatus[] = ["imported"];
    const pageSize = 200;
    let cursor: string | null = null;
    while (true) {
      const { ids, nextCursor } = streamBookIdsByStatus(statuses, pageSize, cursor);
      if (ids.length === 0) break;
      for (const id of ids) enqueueLayoutBook(id);
      if (!nextCursor) break;
      cursor = nextCursor;
    }
  } catch (err) {
    /* Bug 23 fix: bootstrap DB-ошибки не должны давать unhandled rejection.
       Логируем и продолжаем — отсутствие bootstrap только замедлит обработку
       очереди (пользователь сможет запустить вручную). */
    console.error("[layout-assistant] bootstrapLayoutAssistantQueue failed:", err instanceof Error ? err.message : err);
  }
}
