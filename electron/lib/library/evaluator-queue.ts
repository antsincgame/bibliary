/**
 * Evaluator Queue — фоновый воркер pre-flight оценки книг.
 *
 * Контракт:
 *   - На startup читает из cache-db все книги с `status='imported'`
 *     и добавляет их в FIFO.
 *   - N параллельных слотов. Источники конфигурации (Иt 8В.CRITICAL.2):
 *     `prefs.evaluatorSlots` (single source of truth, Settings UI) > default 2.
 *     На module-init используется default; `applyEvaluatorPrefs(prefs)` подтянет
 *     значение из store при boot main.ts (см. `applyRuntimeSideEffects`).
 *     Runtime смена через `setEvaluatorSlots` или `applyEvaluatorPrefs(prefs)`.
 *     Каждый слот -- отдельная корутина, тянет из общей очереди. Это даёт
 *     честный parallelism для лёгких моделей и не убивает GPU при тяжёлых:
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
import {
  evaluateBook as evaluateBookImpl,
  pickEvaluatorModel as pickEvaluatorModelImpl,
  type PickEvaluatorModelOptions,
} from "./book-evaluator.js";
import { buildSurrogate } from "./surrogate-builder.js";
import {
  parseBookMarkdownChapters,
  replaceFrontmatter,
} from "./md-converter.js";
import {
  persistFrontmatter as persistFrontmatterImpl,
  extractMetadataHints,
} from "./evaluator-persist.js";
import { isAbortError } from "../resilience/lm-request-policy.js";
import { getImportScheduler } from "./import-task-scheduler.js";
import { readPipelinePrefsOrNull } from "../preferences/store.js";
import { withBookMdLock } from "./book-md-mutex.js";
import { logModelAction } from "../llm/lmstudio-actions-log.js";
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
  pickEvaluatorModel: (opts?: PickEvaluatorModelOptions) => Promise<string | null>;
  readFile: (p: string) => Promise<string>;
  writeFile: (p: string, content: string) => Promise<void>;
  /**
   * Читает hints из preferences для evaluator-модели. Лениво обёрнуто, чтобы
   * тесты могли подменить без поднятия preferences-стора. По умолчанию идёт
   * в `getPreferencesStore().getAll()`; если стор не инициализирован
   * (тестовая среда) — возвращает пустой объект (тесты, у которых нет prefs,
   * остаются на старом auto-pick поведении через `pickEvaluatorModel`).
   */
  readEvaluatorPrefs: () => Promise<EvaluatorPrefs>;
}

interface EvaluatorPrefs {
  preferred?: string;
  fallbacks?: string[];
  /** Если true (default) — picker может взять любую loaded LLM при отсутствии preferred. */
  allowFallback: boolean;
}

async function defaultReadEvaluatorPrefs(): Promise<EvaluatorPrefs> {
  try {
    const prefs = await readPipelinePrefsOrNull();
    if (!prefs) return { allowFallback: true };
    const preferred = prefs.evaluatorModel?.trim() || undefined;
    const fallbacks = (prefs.evaluatorModelFallbacks ?? "")
      .split(/[\s,;]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    /* allowFallback по умолчанию true — пользователь не должен застревать
       на "Ошибка" из-за того что забыл загрузить конкретную модель. */
    const allowFallback = prefs.evaluatorAllowFallback ?? true;
    return { preferred, fallbacks, allowFallback };
  } catch {
    /* PreferencesStore не инициализирован (например, в юнит-тестах без
       initPreferencesStore) — поведение как раньше: чистый auto-pick. */
    return { allowFallback: true };
  }
}

const defaultDeps: EvaluatorDeps = {
  evaluateBook: (s, o) => evaluateBookImpl(s, o),
  pickEvaluatorModel: (opts) => pickEvaluatorModelImpl(opts),
  readFile: (p) => fs.readFile(p, "utf-8"),
  writeFile: (p, c) => fs.writeFile(p, c, "utf-8"),
  readEvaluatorPrefs: defaultReadEvaluatorPrefs,
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
/**
 * v1.0.7 (autonomous heresy fix): набор книг, которые имеют ПРАВО
 * триггерить автозагрузку моделей с диска через `pickEvaluatorModel(...allowAutoLoad: true)`.
 *
 * Контракт:
 *   - enqueueBook(id) без opts → НЕ добавляется в этот сет → cold-start
 *     resume / bootstrap не грузит 35GB модель в фон.
 *   - enqueueBook(id, { allowAutoLoad: true }) → добавляется → книга, которую
 *     пользователь явно импортировал ИЛИ нажал «Оценить», получает право.
 *   - При взятии книги слотом — флаг считывается и СРАЗУ удаляется (одноразовый).
 *
 * До v1.0.7 все enqueue получали `allowAutoLoad: true` навсегда — это и
 * породило autonomous load при старте app (см. `bootstrapEvaluatorQueue`).
 */
const autoLoadAllowedBooks = new Set<string>();
const paused = { value: false };
let totalEvaluated = 0;
let totalFailed = 0;
let modelOverride: string | null = null;

/**
 * Slot pool — N независимых корутин-воркеров. Каждый слот тянет из общей
 * `queue`, оценивает книгу, идёт за следующей. Дефолт = 2 (защита VRAM
 * на тяжёлых reasoning-моделях). Конфиг — `prefs.evaluatorSlots` (Settings UI),
 * runtime смена через `setEvaluatorSlots` / `applyEvaluatorPrefs`.
 * Иt 8В.CRITICAL.2: env `BIBLIARY_EVAL_SLOTS` удалён.
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

let slotCount = DEFAULT_SLOT_COUNT;
const slots: SlotState[] = [];

function ensureSlots(): void {
  while (slots.length < slotCount) {
    slots.push({ active: false, bookId: null, title: null, controller: null });
  }
}
ensureSlots();

/** Сколько слотов сейчас выполняют работу. */
export function activeSlotCount(): number {
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

/**
 * Применить лимит evaluator slots из preferences (Иt 8Б).
 * Вызывается из preferences.ipc.applyRuntimeSideEffects при boot и каждом
 * preferences:set. Тонкая обёртка над setEvaluatorSlots — не меняет семантику.
 */
export function applyEvaluatorPrefs(prefs: { evaluatorSlots?: number }): void {
  if (typeof prefs.evaluatorSlots === "number" && prefs.evaluatorSlots >= 1) {
    setEvaluatorSlots(prefs.evaluatorSlots);
  }
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

/**
 * Опции постановки книги в очередь.
 *
 * @property allowAutoLoad — v1.0.7: разрешить evaluator-у грузить
 *   preferred-модель с диска в VRAM, если она не загружена. По умолчанию
 *   `false` — для cold-start resume (`bootstrapEvaluatorQueue`) и любых
 *   фоновых пере-enqueue. Caller обязан явно передать `true`, если он
 *   действительно представляет user-intent (`POST library:import`,
 *   manual "Re-evaluate", `resumeEvaluator()` от UI кнопки).
 */
export interface EnqueueBookOptions {
  allowAutoLoad?: boolean;
}

/** Добавляет книгу в конец очереди. Идемпотентно: повтор не дублирует. */
export function enqueueBook(bookId: string, opts: EnqueueBookOptions = {}): void {
  if (inQueue.has(bookId) || isBookInProgress(bookId)) {
    /* Если книга уже в очереди, но новый caller разрешает autoLoad — апгрейдим
       флаг (например: bootstrap поставил без autoLoad, потом пользователь
       нажал "Re-evaluate" с правом). Понижение флага НЕ делаем — однажды
       выданное разрешение действует до взятия слотом. */
    if (opts.allowAutoLoad) autoLoadAllowedBooks.add(bookId);
    return;
  }
  queue.push(bookId);
  inQueue.add(bookId);
  if (opts.allowAutoLoad) autoLoadAllowedBooks.add(bookId);
  emit({ type: "evaluator.queued", bookId, remaining: queue.length });
  scheduleAvailableSlots();
}

/**
 * Высокоприоритетная постановка: книга идёт в ГОЛОВУ очереди, перепрыгивая
 * остальных. Используется UI-flow «оценить эти первыми» (selected rows).
 * Идемпотентно: если книга уже в очереди — переносим её на 0-ю позицию.
 */
export function enqueuePriority(bookId: string, opts: EnqueueBookOptions = {}): void {
  if (isBookInProgress(bookId)) return;
  if (opts.allowAutoLoad) autoLoadAllowedBooks.add(bookId);
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
export function enqueueMany(bookIds: string[], opts: EnqueueBookOptions = {}): void {
  for (const id of bookIds) enqueueBook(id, opts);
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
  const wasPaused = paused.value;
  if (wasPaused) {
    paused.value = false;
    emit({ type: "evaluator.resumed" });
  }
  void enqueuePendingImportedBooks()
    .then(() => scheduleAvailableSlots())
    .catch((err) => console.error("[evaluator-queue/resumeEvaluator] enqueue failed:", err));
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
 * Single-flight promise для lazy bootstrap.
 * null = не стартовал ещё, Promise = уже запущен (или завершён).
 * При ошибке сбрасывается в null, чтобы следующий вызов мог повторить попытку.
 */
let _bootstrapOnce: Promise<void> | null = null;

/**
 * Запускает bootstrap ровно один раз. Повторные вызовы возвращают тот же
 * Promise. При ошибке даёт одну повторную попытку (сбрасывает _bootstrapOnce).
 * Использовать вместо прямого вызова bootstrapEvaluatorQueue вне тестов.
 */
export function ensureEvaluatorBootstrap(): Promise<void> {
  if (!_bootstrapOnce) {
    _bootstrapOnce = bootstrapEvaluatorQueue().catch((err) => {
      console.warn("[evaluator] bootstrap failed — will retry on next enqueue:", err instanceof Error ? err.message : err);
      _bootstrapOnce = null;
    }) as Promise<void>;
  }
  return _bootstrapOnce;
}

/**
 * Bootstrap при запуске приложения:
 *   1. Читает books WHERE status IN ('imported', 'evaluating', 'failed') страницами
 *      по {@link BOOTSTRAP_PAGE_SIZE} -- никаких hardcoded limit'ов на
 *      масштабе 50k.
 *   2. `evaluating` строки сбрасывает в `imported` (значит "процесс упал
 *      во время оценки").
 *   3. Все `imported` + старые evaluatable `failed` ставит в очередь — slots сами разберут.
 *
 * Идемпотентно: повторный вызов не задублирует (enqueueBook проверяет
 * `inQueue` set). Не вызывай напрямую — используй {@link ensureEvaluatorBootstrap}.
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

  /* Stage 2: enqueue ВСЕ `imported` и старые evaluatable `failed` через cursor-стриминг. Race-safe —
     даже если slot выхватит книгу X и переведёт её в `evaluating` пока
     мы ещё пагинируем, мы её уже взяли в текущем батче. Cursor по `id`
     гарантирует, что на следующей странице мы не пропустим/не дубликатим.
     `failed` фильтруем по word/chapter count: это rescue для прежних
     transient LM Studio failures, а не попытка оценивать пустой parser-fail. */
  let importedCursor: string | null = null;
  while (true) {
    const { ids, nextCursor } = streamBookIdsByStatus(["imported", "failed"], BOOTSTRAP_PAGE_SIZE, importedCursor);
    if (ids.length === 0) break;
    const rows = getBooksByIds(ids);
    await enqueueEvaluatableRows(rows);
    if (!nextCursor) break;
    importedCursor = nextCursor;
  }
}

async function enqueueEvaluatableRows(rows: Array<BookCatalogMeta & { mdPath: string }>): Promise<void> {
  for (const meta of rows) {
    if (meta.status === "imported") {
      enqueueBook(meta.id);
      continue;
    }
    if (meta.status !== "failed" || meta.wordCount <= 0 || meta.chapterCount <= 0) continue;

    const reset: BookCatalogMeta = { ...meta, status: "imported", lastError: undefined };
    upsertBook(reset, meta.mdPath);
    try {
      const md = await deps.readFile(meta.mdPath);
      await deps.writeFile(meta.mdPath, replaceFrontmatter(md, reset));
    } catch {
      /* tolerate: DB is enough to enqueue; rebuild can repair later */
    }
    enqueueBook(meta.id);
  }
}

async function enqueuePendingImportedBooks(): Promise<number> {
  let cursor: string | null = null;
  let queued = 0;
  while (true) {
    const { ids, nextCursor } = streamBookIdsByStatus(["imported", "failed"], BOOTSTRAP_PAGE_SIZE, cursor);
    if (ids.length === 0) break;
    const rows = getBooksByIds(ids);
    const before = queue.length;
    await enqueueEvaluatableRows(rows);
    queued += Math.max(0, queue.length - before);
    if (!nextCursor) break;
    cursor = nextCursor;
  }
  return queued;
}

function appendWarning(meta: BookCatalogMeta, warning: string): string[] {
  const existing = meta.warnings ?? [];
  return existing.includes(warning) ? existing : [...existing, warning];
}

function isRetryableEvaluatorIssue(message: string): boolean {
  return /no LLM loaded|preferred model .* not loaded|Circuit "lmstudio" is OPEN|service degraded|ECONNREFUSED|fetch failed|timeout|LM Studio call failed|empty response|no JSON/i.test(message);
}

async function deferEvaluationRetry(
  meta: BookCatalogMeta & { mdPath: string },
  md: string,
  reason: string,
  bookId: string,
  title: string | null,
): Promise<void> {
  const warning = `evaluator deferred: ${reason}`;
  const deferred: BookCatalogMeta = {
    ...meta,
    status: "imported",
    lastError: warning,
    warnings: appendWarning(meta, warning),
  };
  upsertBook(deferred, meta.mdPath);
  await persistFrontmatter(deferred, meta.mdPath, md);
  pauseEvaluator();
  emit({ type: "evaluator.skipped", bookId, title: title ?? meta.title, error: warning });
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
    /* Дождаться bootstrap перед первым pull'ом из очереди — гарантирует что
       все `imported` из DB уже загружены и stuck `evaluating` сброшены. */
    await ensureEvaluatorBootstrap();
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
  /* Считываем + СРАЗУ удаляем разрешение на autoLoad (одноразовое).
     Если книга вернётся в очередь через deferEvaluationRetry — она
     попадёт уже без права грузить с диска (что и нужно для cold-start). */
  const allowAutoLoadForThisBook = autoLoadAllowedBooks.has(bookId);
  autoLoadAllowedBooks.delete(bookId);

  let meta = getBookById(bookId);
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
      const reason = "evaluator: no chapters parsed from book.md";
      const failed: BookCatalogMeta = {
        ...meta,
        status: "failed",
        lastError: reason,
        warnings: appendWarning(meta, reason),
      };
      upsertBook(failed, meta.mdPath);
      await persistFrontmatter(failed, meta.mdPath, md);
      totalFailed += 1;
      emit({ type: "evaluator.failed", bookId, title: slot.title, error: "no chapters" });
      return;
    }

    /* 2. Surrogate. */
    const surrogate = buildSurrogate(chapters);

    /* 2b. Pre-scan: regex hints for author/year from frontmatter + filename + full text. */
    const metaHints = extractMetadataHints(md, meta);
    const surrogateWithHints = metaHints.length > 0
      ? `# METADATA HINTS (from filename, frontmatter, and text scan — use these as strong clues)\n${metaHints.join("\n")}\n\n${surrogate.surrogate}`
      : surrogate.surrogate;

    /* 3. Pick model. Приоритеты:
         a) `modelOverride` (выставленный через `setEvaluatorModel`) — явный
            runtime override из IPC.
         b) `prefs.evaluatorModel` + CSV fallbacks из Settings → Models —
            то, что выбрал пользователь в UI.
         c) Авто-загрузка через ModelPool (pool.acquire): если preferred/fallback
            модель не в VRAM — pool загрузит её, предварительно выгрузив ненужные
            модели (makeRoom/eviction). Pool безопасно управляет VRAM.
         d) Чистый auto-pick — только если ни a, ни b, ни c не сработали. */
    const evaluatorPrefs = await deps.readEvaluatorPrefs();
    /* Модель выбирается через pickEvaluatorModel.

       v1.0.7 (autonomous heresy fix): `allowAutoLoad` берётся из per-book
       флага `autoLoadAllowedBooks`. Книги, попавшие в очередь через
       bootstrapEvaluatorQueue (cold-start resume), флага НЕ имеют —
       evaluator работает только с loaded моделями, не грузит 35GB
       qwen3.5 в фон. Книги от user-import / manual evaluate имеют флаг
       и могут триггерить autoLoad через ModelPool.

       allowAnyLoadedFallback: если preferred задан → false: не подменяем на
       произвольную LLM, а загружаем нужную (если разрешено флагом). */
    const allowFallback = evaluatorPrefs.allowFallback;
    const allowAnyLoadedFallbackEffective = evaluatorPrefs.preferred ? false : allowFallback;
    const model = modelOverride ?? (await deps.pickEvaluatorModel({
      preferred: evaluatorPrefs.preferred,
      fallbacks: evaluatorPrefs.fallbacks,
      allowAutoLoad: allowAutoLoadForThisBook,
      allowAnyLoadedFallback: allowAnyLoadedFallbackEffective,
    }));
    if (!model) {
      const reason = evaluatorPrefs.preferred
        ? `evaluator: preferred model "${evaluatorPrefs.preferred}" not loaded in LM Studio — load it or clear evaluatorModel in Settings → Models`
        : "evaluator: no LLM loaded in LM Studio";
      if (!allowAutoLoadForThisBook) {
        /* Cold-start resume: явно не грузим модель с диска. Логируем
           для прозрачности — пользователь увидит в Models page → "Логи". */
        logModelAction("EVALUATOR-DEFER-RESUME", {
          role: "evaluator",
          modelKey: evaluatorPrefs.preferred,
          reason: "cold-start resume — autoLoad disabled to avoid autonomous VRAM grab",
          meta: { bookId, title: slot.title ?? meta.title },
        });
      } else {
        logModelAction("EVALUATOR-PICK-FAIL", {
          role: "evaluator",
          modelKey: evaluatorPrefs.preferred,
          reason,
          meta: { bookId },
        });
      }
      await deferEvaluationRetry(meta, md, reason, bookId, slot.title);
      return;
    }
    /* Если picker подменил preferred на любую loaded LLM — добавим в warnings
       прозрачную трассу, чтобы юзер видел почему оценка от другой модели. */
    if (evaluatorPrefs.preferred && model !== evaluatorPrefs.preferred) {
      meta = {
        ...meta,
        warnings: [
          ...(meta.warnings ?? []),
          `evaluator: preferred "${evaluatorPrefs.preferred}" not loaded — using "${model}" as fallback`,
        ],
      };
    }

    /* 4. LLM call. Используем signal этого слота — параллельные слоты
       имеют независимые AbortController'ы, cancel одного не валит других.

       Iter 7: оборачиваем вызов в scheduler.enqueue("medium") для observability —
       UI widget видит счётчик medium-lane (running/queued) во время evaluation.
       Это НЕ заменяет ModelPool/withModel; scheduler — observability layer
       поверх pool, лимиты medium=3 совпадают с типичной concurrency evaluator. */
    const slotSignal = slot.controller!.signal;
    const result = await getImportScheduler().enqueue("medium", () =>
      deps.evaluateBook(surrogateWithHints, { model, signal: slotSignal }),
    );
    if (!result.evaluation) {
      const reason = result.warnings.join("; ") || "evaluation returned null";
      if (isRetryableEvaluatorIssue(reason)) {
        await deferEvaluationRetry(meta, md, reason, bookId, slot.title);
        return;
      }
      const failed: BookCatalogMeta = {
        ...meta,
        status: "failed",
        lastError: reason,
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
      titleRu: ev.title_ru,
      authorRu: ev.author_ru,
      titleEn: ev.title_en,
      authorEn: ev.author_en,
      year: ev.year ?? meta.year,
      domain: ev.domain,
      tags: ev.tags,
      tagsRu: ev.tags_ru,
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
       /aborted/i) -- консистентно с lm-request-policy.
       Раньше string.includes("abort") мог ложно срабатывать на любое
       сообщение со словом "abort" внутри (например, "system abort log"). */
    const msg = err instanceof Error ? err.message : String(err);
    if (isAbortError(err) || slot.controller?.signal.aborted) {
      upsertBook({ ...meta, status: "imported" }, meta.mdPath);
      emit({ type: "evaluator.skipped", bookId, title: slot.title, error: "aborted" });
    } else {
      if (isRetryableEvaluatorIssue(msg)) {
        try {
          const md = await deps.readFile(meta.mdPath);
          await deferEvaluationRetry(meta, md, msg, bookId, slot.title);
        } catch {
          const warning = `evaluator deferred: ${msg}`;
          upsertBook({
            ...meta,
            status: "imported",
            lastError: warning,
            warnings: appendWarning(meta, warning),
          }, meta.mdPath);
          pauseEvaluator();
          emit({ type: "evaluator.skipped", bookId, title: slot.title, error: warning });
        }
        return;
      }
      const reason = `evaluator: ${msg}`;
      const failed: BookCatalogMeta = {
        ...meta,
        status: "failed",
        lastError: reason,
        warnings: appendWarning(meta, reason),
      };
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

/** Локальная обёртка над persistFrontmatter из evaluator-persist:
 *  привязывает caller'а к текущему `deps.writeFile` (DI hook для тестов).
 *
 *  Иt 8Г.1: обёрнуто в withBookMdLock(meta.id) для защиты от lost-update
 *  при гонке с illustration-worker.fs.writeFile (тот же mdPath, разные
 *  scheduler lanes). Mutex per-bookId не блокирует другие книги. */
async function persistFrontmatter(
  meta: BookCatalogMeta,
  mdPath: string,
  md: string,
  reasoning?: string | null,
): Promise<void> {
  return withBookMdLock(meta.id, () =>
    persistFrontmatterImpl(meta, mdPath, md, reasoning, deps.writeFile),
  );
}

/** Тестовый helper: сбрасывает все счётчики и состояние. Только для unit-tests. */
export function _resetEvaluatorForTests(): void {
  queue.length = 0;
  inQueue.clear();
  paused.value = false;
  totalEvaluated = 0;
  totalFailed = 0;
  modelOverride = null;
  /* Unit tests enqueue synthetic ids without a real catalog. Disable lazy
     bootstrap after reset; tests that need DB bootstrap call bootstrapEvaluatorQueue()
     explicitly. Production never calls this helper. */
  _bootstrapOnce = Promise.resolve();
  /* Сбрасываем slots: cancel текущие, очищаем массив, восстанавливаем дефолт. */
  for (const s of slots) {
    if (s.controller) s.controller.abort("test-reset");
    s.active = false;
    s.bookId = null;
    s.title = null;
    s.controller = null;
  }
  slots.length = 0;
  slotCount = DEFAULT_SLOT_COUNT;
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
