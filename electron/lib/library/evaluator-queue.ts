/**
 * Evaluator Queue — фоновый воркер pre-flight оценки книг.
 *
 * Контракт:
 *   - На startup читает из cache-db все книги с `status='imported'`
 *     и добавляет их в FIFO.
 *   - N параллельных слотов (default 2, runtime 1..16 через
 *     `setEvaluatorSlots`, env `BIBLIARY_EVAL_SLOTS`). Каждый слот --
 *     отдельная корутина, тянет из общей очереди. Это даёт честный
 *     parallelism для лёгких моделей и не убивает GPU при тяжёлых:
 *     юзер сам выкручивает слайдер. С пользовательской кристаллизацией
 *     не конкурируем -- chatWithPolicy сериализует доступ к модели
 *     внутри LM Studio, очередь просто ждёт.
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
import { getBookById, getBooksByIds, streamBookIdsByStatus, upsertBook } from "./cache-db.js";
import { evaluateBook as evaluateBookImpl, pickEvaluatorModel as pickEvaluatorModelImpl } from "./book-evaluator.js";
import { buildSurrogate } from "./surrogate-builder.js";
import {
  parseFrontmatter,
  parseBookMarkdownChapters,
  replaceFrontmatter,
  upsertEvaluatorReasoning,
} from "./md-converter.js";
import { isAbortError } from "../resilience/lm-request-policy.js";
import type { BookCatalogMeta } from "./types.js";
import type { EvaluationResult } from "./types.js";

/**
 * Inject-able dependencies — позволяют тестам подменить LLM/IO без
 * запуска LM Studio. В продакшене используются реальные impl.
 *
 * Контракт: deps подменяются ТОЛЬКО через `_setEvaluatorDepsForTests`,
 * никаких иных способов мутации нет. Это закрывает риск "тест случайно
 * перетёр прод-зависимость и не вернул назад".
 */
interface EvaluatorDeps {
  evaluateBook: (surrogate: string, opts: { model: string; signal: AbortSignal }) => Promise<EvaluationResult>;
  pickEvaluatorModel: () => Promise<string | null>;
  readFile: (p: string) => Promise<string>;
  writeFile: (p: string, content: string) => Promise<void>;
}

const defaultDeps: EvaluatorDeps = {
  evaluateBook: (s, o) => evaluateBookImpl(s, o),
  pickEvaluatorModel: () => pickEvaluatorModelImpl(),
  readFile: (p) => fs.readFile(p, "utf-8"),
  writeFile: (p, c) => fs.writeFile(p, c, "utf-8"),
};

let deps: EvaluatorDeps = defaultDeps;

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
const paused = { value: false };
let totalEvaluated = 0;
let totalFailed = 0;
let modelOverride: string | null = null;

/**
 * Slot pool — N независимых корутин-воркеров. Каждый слот тянет из общей
 * `queue`, оценивает книгу, идёт за следующей. Дефолт = 2 (защита VRAM
 * на тяжёлых reasoning-моделях). Override через ENV `BIBLIARY_EVAL_SLOTS`
 * или runtime `setEvaluatorSlots`.
 *
 * Slot state ведём в Map по индексу — это позволяет UI показывать ВСЕ
 * текущие книги (не только одну как раньше). Контракт `getEvaluatorStatus`
 * выдаёт первый занятый slot для backward-compat (renderer пока ждёт
 * single `currentBookId`).
 */
interface SlotState {
  active: boolean;
  bookId: string | null;
  title: string | null;
  controller: AbortController | null;
}

const DEFAULT_SLOT_COUNT = 2;
const MAX_SLOT_COUNT = 16; /* sane upper bound — никто не запустит >16 LLM параллельно */

function resolveSlotCount(): number {
  const raw = process.env.BIBLIARY_EVAL_SLOTS?.trim();
  if (!raw) return DEFAULT_SLOT_COUNT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return DEFAULT_SLOT_COUNT;
  return Math.min(n, MAX_SLOT_COUNT);
}

let slotCount = resolveSlotCount();
const slots: SlotState[] = [];

function ensureSlots(): void {
  while (slots.length < slotCount) {
    slots.push({ active: false, bookId: null, title: null, controller: null });
  }
}
ensureSlots();

/** Сколько слотов сейчас выполняют работу. */
function activeSlotCount(): number {
  let n = 0;
  for (const s of slots) if (s.active) n += 1;
  return n;
}

/** Первый занятый slot — для backward-compat одиночного UI поля currentBookId. */
function firstBusySlot(): SlotState | null {
  for (const s of slots) if (s.active) return s;
  return null;
}

function emit(event: EvaluatorEvent): void {
  ee.emit("event", event);
}

/** Подписка на события очереди (для IPC bridge). */
export function subscribeEvaluator(cb: (e: EvaluatorEvent) => void): () => void {
  ee.on("event", cb);
  return () => ee.off("event", cb);
}

export function getEvaluatorStatus(): EvaluatorStatus {
  const busy = firstBusySlot();
  return {
    running: activeSlotCount() > 0,
    paused: paused.value,
    currentBookId: busy?.bookId ?? null,
    currentTitle: busy?.title ?? null,
    queueLength: queue.length,
    totalEvaluated,
    totalFailed,
  };
}

/**
 * Изменяет количество параллельных evaluator slots в runtime. Применяется
 * с следующего цикла очереди — текущие занятые слоты доигрывают свою книгу.
 * Если `n` < текущего числа активных, лишние слоты тихо завершатся пустым
 * `runWorker` циклом. Если `n` >, новые слоты немедленно подхватят очередь.
 */
export function setEvaluatorSlots(n: number): void {
  if (!Number.isInteger(n) || n < 1) return;
  slotCount = Math.min(n, MAX_SLOT_COUNT);
  ensureSlots();
  /* Пробуем разбудить новых: если в очереди что-то есть и слоты idle. */
  for (let i = 0; i < slotCount; i++) {
    if (!slots[i].active) void runSlot(i);
  }
}

/** Текущий лимит slots — для UI и тестов. */
export function getEvaluatorSlotCount(): number {
  return slotCount;
}

/** Override для модели эвалюатора. null -- авто-выбор через pickEvaluatorModel. */
export function setEvaluatorModel(modelKey: string | null): void {
  modelOverride = modelKey;
}

/**
 * Проверяет, не обрабатывается ли книга прямо сейчас одним из слотов.
 * Используется enqueueBook чтобы избежать постановки в очередь книги,
 * которая уже в работе у параллельного слота.
 */
function isBookInProgress(bookId: string): boolean {
  for (const s of slots) {
    if (s.active && s.bookId === bookId) return true;
  }
  return false;
}

/** Добавляет книгу в конец очереди. Идемпотентно: повтор не дублирует. */
export function enqueueBook(bookId: string): void {
  if (inQueue.has(bookId) || isBookInProgress(bookId)) return;
  queue.push(bookId);
  inQueue.add(bookId);
  emit({ type: "evaluator.queued", bookId, remaining: queue.length });
  scheduleAvailableSlots();
}

/**
 * Высокоприоритетная постановка: книга идёт в ГОЛОВУ очереди, перепрыгивая
 * остальных. Используется UI-flow «оценить эти первыми» (selected rows).
 * Идемпотентно: если книга уже в очереди — переносим её на 0-ю позицию.
 */
export function enqueuePriority(bookId: string): void {
  if (isBookInProgress(bookId)) return;
  if (inQueue.has(bookId)) {
    const idx = queue.indexOf(bookId);
    if (idx > 0) {
      queue.splice(idx, 1);
      queue.unshift(bookId);
    }
    return;
  }
  queue.unshift(bookId);
  inQueue.add(bookId);
  emit({ type: "evaluator.queued", bookId, remaining: queue.length });
  scheduleAvailableSlots();
}

/** Массовая постановка в очередь -- удобно после batch-импорта. */
export function enqueueMany(bookIds: string[]): void {
  for (const id of bookIds) enqueueBook(id);
}

/** Будит все idle slots до slotCount. Идемпотентно: уже активные слоты не трогает. */
function scheduleAvailableSlots(): void {
  for (let i = 0; i < slotCount; i++) {
    if (!slots[i].active) void runSlot(i);
  }
}

export function pauseEvaluator(): void {
  if (paused.value) return;
  paused.value = true;
  emit({ type: "evaluator.paused" });
}

export function resumeEvaluator(): void {
  if (!paused.value) return;
  paused.value = false;
  emit({ type: "evaluator.resumed" });
  scheduleAvailableSlots();
}

/**
 * Прерывает все текущие оценки во всех слотах (не очищает очередь).
 * Имя сохранено для backward-compat: семантически теперь это «cancel all
 * inflight» — что и ожидается в UI-кнопке «Stop».
 */
export function cancelCurrentEvaluation(reason = "user-cancel"): void {
  for (const s of slots) {
    if (s.controller) s.controller.abort(reason);
  }
}

/** Очищает очередь (текущая задача доигрывается). */
export function clearQueue(): void {
  queue.length = 0;
  inQueue.clear();
}

/**
 * Page size для bootstrap-стриминга. На партии 50k книг каждый раз тащить
 * полный список из SQLite и одной транзакцией enqueue'ить всё — opasно
 * для responsiveness UI. Стрим по 500 книг даёт регулярные передышки
 * event loop'у и снимает прежний кэп `limit: 1000`.
 */
const BOOTSTRAP_PAGE_SIZE = 500;

/**
 * Bootstrap при запуске приложения:
 *   1. Читает books WHERE status IN ('imported', 'evaluating') страницами
 *      по {@link BOOTSTRAP_PAGE_SIZE} -- никаких hardcoded limit'ов на
 *      масштабе 50k.
 *   2. `evaluating` строки сбрасывает в `imported` (значит "процесс упал
 *      во время оценки").
 *   3. Все `imported` ставит в очередь — slots сами разберут.
 *
 * Идемпотентно: повторный вызов не задублирует (enqueueBook проверяет
 * `inQueue` set).
 */
export async function bootstrapEvaluatorQueue(): Promise<void> {
  /* Stage 1: reset stuck `evaluating` строк. Cursor по id (не по offset) —
     устойчив к concurrent изменениям. На каждой итерации берём страницу
     ids и грузим их meta через `getBooksByIds` (минует кэп query). */
  let stuckCursor: string | null = null;
  while (true) {
    const { ids, nextCursor } = streamBookIdsByStatus(["evaluating"], BOOTSTRAP_PAGE_SIZE, stuckCursor);
    if (ids.length === 0) break;
    const stuckRows = getBooksByIds(ids);
    for (const meta of stuckRows) {
      const reset: BookCatalogMeta = { ...meta, status: "imported" };
      upsertBook(reset, meta.mdPath);
      /* В book.md тоже -- иначе после rebuildFromFs опять появится evaluating. */
      try {
        const md = await deps.readFile(meta.mdPath);
        await deps.writeFile(meta.mdPath, replaceFrontmatter(md, reset));
      } catch {
        /* tolerate */
      }
    }
    if (!nextCursor) break;
    stuckCursor = nextCursor;
  }

  /* Stage 2: enqueue ВСЕ `imported` через cursor-стриминг. Race-safe —
     даже если slot выхватит книгу X и переведёт её в `evaluating` пока
     мы ещё пагинируем, мы её уже взяли в текущем батче. Cursor по `id`
     гарантирует, что на следующей странице мы не пропустим/не дубликатим. */
  let importedCursor: string | null = null;
  while (true) {
    const { ids, nextCursor } = streamBookIdsByStatus(["imported"], BOOTSTRAP_PAGE_SIZE, importedCursor);
    if (ids.length === 0) break;
    enqueueMany(ids);
    if (!nextCursor) break;
    importedCursor = nextCursor;
  }
}

/**
 * Один slot-воркер: тянет из очереди и обрабатывает книги пока есть
 * работа и не paused. Несколько slots могут крутиться параллельно — каждый
 * имеет собственный slot state в `slots[idx]`, поэтому race по
 * currentBookId/Controller невозможен (раньше это была glob-переменная).
 *
 * Если slot выходит за границу `slotCount` (был уменьшен через
 * `setEvaluatorSlots`), он молча завершается — лишний slot не нужен.
 */
async function runSlot(idx: number): Promise<void> {
  const slot = slots[idx];
  if (!slot) return;
  if (slot.active) return;
  if (idx >= slotCount) return;
  slot.active = true;
  try {
    while (true) {
      if (paused.value) break;
      if (idx >= slotCount) break; /* slot был уменьшен в runtime */
      const next = queue.shift();
      if (!next) break;
      inQueue.delete(next);
      await evaluateOneInSlot(next, slot);
    }
  } finally {
    slot.active = false;
    slot.bookId = null;
    slot.title = null;
    slot.controller = null;
    /* Idle event только когда ВСЕ слоты свободны и очередь пуста.
       Иначе идущие параллельно слоты эмитили бы преждевременный idle. */
    if (activeSlotCount() === 0 && queue.length === 0 && !paused.value) {
      emit({ type: "evaluator.idle" });
    }
  }
}

async function evaluateOneInSlot(bookId: string, slot: SlotState): Promise<void> {
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

  slot.bookId = bookId;
  slot.title = meta.titleEn ?? meta.title;
  slot.controller = new AbortController();
  emit({ type: "evaluator.started", bookId, title: slot.title });

  /* Mark as evaluating -- защита от двойного запуска при rerun. */
  upsertBook({ ...meta, status: "evaluating" }, meta.mdPath);

  try {
    /* 1. Загрузить markdown. */
    const md = await deps.readFile(meta.mdPath);
    const chapters = parseBookMarkdownChapters(md);
    if (chapters.length === 0) {
      const failed: BookCatalogMeta = { ...meta, status: "failed", warnings: [...(meta.warnings ?? []), "evaluator: no chapters parsed from book.md"] };
      upsertBook(failed, meta.mdPath);
      await persistFrontmatter(failed, meta.mdPath, md);
      totalFailed += 1;
      emit({ type: "evaluator.failed", bookId, title: slot.title, error: "no chapters" });
      return;
    }

    /* 2. Surrogate. */
    const surrogate = buildSurrogate(chapters);

    /* 3. Pick model. Override has priority. */
    const model = modelOverride ?? (await deps.pickEvaluatorModel());
    if (!model) {
      const failed: BookCatalogMeta = { ...meta, status: "failed", warnings: [...(meta.warnings ?? []), "evaluator: no LLM loaded"] };
      upsertBook(failed, meta.mdPath);
      await persistFrontmatter(failed, meta.mdPath, md);
      totalFailed += 1;
      emit({ type: "evaluator.failed", bookId, title: slot.title, error: "no LLM loaded" });
      return;
    }

    /* 4. LLM call. Используем signal этого слота — параллельные слоты
       имеют независимые AbortController'ы, cancel одного не валит других. */
    const slotSignal = slot.controller!.signal;
    const result = await deps.evaluateBook(surrogate.surrogate, { model, signal: slotSignal });
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
      emit({ type: "evaluator.failed", bookId, title: slot.title, error: result.warnings.join("; ") || "evaluation returned null", warnings: result.warnings });
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
    if (isAbortError(err) || slot.controller?.signal.aborted) {
      upsertBook({ ...meta, status: "imported" }, meta.mdPath);
      emit({ type: "evaluator.skipped", bookId, title: slot.title, error: "aborted" });
    } else {
      const failed: BookCatalogMeta = { ...meta, status: "failed", warnings: [...(meta.warnings ?? []), `evaluator: ${msg}`] };
      upsertBook(failed, meta.mdPath);
      try {
        const md = await deps.readFile(meta.mdPath);
        await persistFrontmatter(failed, meta.mdPath, md);
      } catch {
        /* tolerate */
      }
      totalFailed += 1;
      emit({ type: "evaluator.failed", bookId, title: slot.title, error: msg });
    }
  }
}

/** Атомарно перезаписывает frontmatter в book.md и (опционально) Evaluator Reasoning секцию. */
async function persistFrontmatter(meta: BookCatalogMeta, mdPath: string, md: string, reasoning?: string | null): Promise<void> {
  let next = replaceFrontmatter(md, meta);
  if (reasoning !== undefined) next = upsertEvaluatorReasoning(next, reasoning);
  await deps.writeFile(mdPath, next);
}

/** Тестовый helper: сбрасывает все счётчики и состояние. Только для unit-tests. */
export function _resetEvaluatorForTests(): void {
  queue.length = 0;
  inQueue.clear();
  paused.value = false;
  totalEvaluated = 0;
  totalFailed = 0;
  modelOverride = null;
  /* Сбрасываем slots: cancel текущие, очищаем массив, восстанавливаем дефолт. */
  for (const s of slots) {
    if (s.controller) s.controller.abort("test-reset");
    s.active = false;
    s.bookId = null;
    s.title = null;
    s.controller = null;
  }
  slots.length = 0;
  slotCount = resolveSlotCount();
  ensureSlots();
  ee.removeAllListeners();
  deps = defaultDeps;
}

/**
 * Тестовый DI-hook: подменяет evaluateBook/pickEvaluatorModel/IO.
 * Передавай только нужные поля -- остальные останутся реальными.
 * Сбрасывается на defaultDeps вызовом `_resetEvaluatorForTests`.
 */
export function _setEvaluatorDepsForTests(overrides: Partial<EvaluatorDeps>): void {
  deps = { ...deps, ...overrides };
}

/* Re-export parser helper -- удобно для тестов. */
export { parseFrontmatter };
