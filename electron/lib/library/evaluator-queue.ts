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
  readEvaluatorPrefs: () => Promise<{ preferred?: string; fallbacks?: string[] }>;
  /**
   * Загрузить preferred модель в LM Studio ДО pickEvaluatorModel.
   * Closes Шерлок-bug v0.4.6: picker возвращает preferred ТОЛЬКО если она
   * уже в loaded; иначе скоринг может выбрать другую (более крупную) модель.
   * По дефолту идёт через `getModelPool().acquire()` (с Итерации 1) — раньше
   * был прямой `lmstudio-client.loadModel`, что давало конкурентную загрузку
   * при N>1 evaluator-слотах одной модели. Тесты — no-op.
   * МОЖЕТ throw: исключение от pool пробрасывается, caller (`evaluateOneInSlot`)
   * оборачивает в try/catch и идёт по fallback пути через picker.
   */
  ensurePreferredLoaded: (modelKey: string) => Promise<void>;
}

async function defaultReadEvaluatorPrefs(): Promise<{ preferred?: string; fallbacks?: string[] }> {
  try {
    const { readPipelinePrefsOrNull } = await import("../preferences/store.js");
    const prefs = await readPipelinePrefsOrNull();
    if (!prefs) return {};
    const preferred = prefs.evaluatorModel?.trim() || undefined;
    const fallbacks = (prefs.evaluatorModelFallbacks ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    return { preferred, fallbacks };
  } catch {
    /* PreferencesStore не инициализирован (например, в юнит-тестах без
       initPreferencesStore) — поведение как раньше: чистый auto-pick. */
    return {};
  }
}

async function defaultEnsurePreferredLoaded(modelKey: string): Promise<void> {
  /* Раньше вызывался прямой loadModel() — две параллельные книги в очереди
     дёргали client.llm.load одной и той же модели одновременно, что для
     тяжёлых evaluator-моделей (>20 GB) приводило к OOM и крэшу LM Studio.
     Теперь pool.acquire сериализует всё через runOnChain и дедуплицирует
     in-flight загрузки. Immediate release: refCount удержится через
     последующий evaluateBook → pool.withModel; модель не выгрузится между
     ними (LRU eviction только при нехватке места). */
  const { getModelPool } = await import("../llm/model-pool.js");
  const handle = await getModelPool().acquire(modelKey, {
    role: "evaluator-prewarm",
    ttlSec: 900,
    gpuOffload: "max",
  });
  handle.release();
}

const defaultDeps: EvaluatorDeps = {
  evaluateBook: (s, o) => evaluateBookImpl(s, o),
  pickEvaluatorModel: (opts) => pickEvaluatorModelImpl(opts),
  readFile: (p) => fs.readFile(p, "utf-8"),
  writeFile: (p, c) => fs.writeFile(p, c, "utf-8"),
  readEvaluatorPrefs: defaultReadEvaluatorPrefs,
  ensurePreferredLoaded: defaultEnsurePreferredLoaded,
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
 *   1. Читает books WHERE status IN ('imported', 'evaluating') страницами
 *      по {@link BOOTSTRAP_PAGE_SIZE} -- никаких hardcoded limit'ов на
 *      масштабе 50k.
 *   2. `evaluating` строки сбрасывает в `imported` (значит "процесс упал
 *      во время оценки").
 *   3. Все `imported` ставит в очередь — slots сами разберут.
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

    /* 2b. Pre-scan: regex hints for author/year from frontmatter + filename + full text. */
    const metaHints = extractMetadataHints(md, meta);
    const surrogateWithHints = metaHints.length > 0
      ? `# METADATA HINTS (from filename, frontmatter, and text scan — use these as strong clues)\n${metaHints.join("\n")}\n\n${surrogate.surrogate}`
      : surrogate.surrogate;

    /* 3. Pick model. Приоритеты:
         a) `modelOverride` (выставленный через `setEvaluatorModel`) — явный
            runtime override из IPC.
         b) `prefs.evaluatorModel` + CSV fallbacks из Settings → Models —
            то, что выбрал пользователь в UI. До 2026-04 этот выбор
            игнорировался и `pickEvaluatorModel` шёл в эвристический
            скоринг + автозагрузку — что приводило к выбору «самой мощной»
            модели и попытке догрузить её поверх занятой VRAM
            (вплоть до freeze ОС).
         c) Чистый auto-pick — только если ни a, ни b не сработали и
            хотя бы одна loaded LLM есть.
       `allowAutoLoad: false` запрещает скрытую загрузку моделей с диска. */
    const evaluatorPrefs = await deps.readEvaluatorPrefs();
    /* Pre-load PREFERRED модели ДО pickEvaluatorModel.
     *
     * КРИТИЧЕСКИЙ FIX (Шерлок v0.4.6): pickEvaluatorModel(allowAutoLoad=true)
     * возвращает preferred ТОЛЬКО если она уже в loaded. Иначе — отправляет
     * preferred в общий пул кандидатов и выбирает по СКОРИНГУ. Результат:
     * юзер указал "qwen-3-8b", а picker загрузил "deepseek-r1-32b" с
     * лучшим скором. Это нарушает контракт «выбор пользователя сильнее
     * любой эвристики», заявленный в комментарии к pickEvaluatorModel.
     *
     * Решение: явно загружаем preferred в LM Studio, потом picker найдёт её
     * в loaded и вернёт. allowAutoLoad: false — никакая heuristic не сможет
     * переопределить выбор юзера.
     *
     * Pre-load выполняется только для НЕпустого preferred. При пустом —
     * picker берёт лучшую loaded с allowAutoLoad: false (без скрытой
     * догрузки чужих моделей). */
    const hasPreferred = !!evaluatorPrefs.preferred;
    if (hasPreferred && !modelOverride && evaluatorPrefs.preferred) {
      try {
        await deps.ensurePreferredLoaded(evaluatorPrefs.preferred);
      } catch (err) {
        console.warn(`[evaluator-queue] pre-load "${evaluatorPrefs.preferred}" failed (will fallback to picker scoring):`, err);
        /* НЕ прерываем — picker попробует CSV fallbacks или скорит loaded. */
      }
    }
    const model = modelOverride ?? (await deps.pickEvaluatorModel({
      preferred: evaluatorPrefs.preferred,
      fallbacks: evaluatorPrefs.fallbacks,
      allowAutoLoad: false,
    }));
    if (!model) {
      const reason = evaluatorPrefs.preferred
        ? `evaluator: selected model "${evaluatorPrefs.preferred}" not loaded in LM Studio (auto-load attempted)`
        : "evaluator: no LLM loaded";
      const failed: BookCatalogMeta = { ...meta, status: "failed", warnings: [...(meta.warnings ?? []), reason] };
      upsertBook(failed, meta.mdPath);
      await persistFrontmatter(failed, meta.mdPath, md);
      totalFailed += 1;
      emit({ type: "evaluator.failed", bookId, title: slot.title, error: reason });
      return;
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

/** Локальная обёртка над persistFrontmatter из evaluator-persist:
 *  привязывает caller'а к текущему `deps.writeFile` (DI hook для тестов). */
async function persistFrontmatter(
  meta: BookCatalogMeta,
  mdPath: string,
  md: string,
  reasoning?: string | null,
): Promise<void> {
  return persistFrontmatterImpl(meta, mdPath, md, reasoning, deps.writeFile);
}

/** Тестовый helper: сбрасывает все счётчики и состояние. Только для unit-tests. */
export function _resetEvaluatorForTests(): void {
  queue.length = 0;
  inQueue.clear();
  paused.value = false;
  totalEvaluated = 0;
  totalFailed = 0;
  modelOverride = null;
  /* Сбрасываем bootstrap single-flight — иначе следующий runSlot получит
     старый resolved Promise и не перезапустит bootstrap в новом тесте. */
  _bootstrapOnce = null;
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
