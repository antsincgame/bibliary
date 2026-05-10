/**
 * Evaluator slot worker — основной body одной evaluation в slot'е.
 *
 * Вынесено из `evaluator-queue.ts` (раньше inline-функция `evaluateOneInSlot`
 * на ~280 строк внутри 885-строчного god-object'а). Контракт чистый:
 *   - Принимает bookId + slot + deps (всё внешнее — через injected deps).
 *   - Никаких side-effect'ов на module-level state evaluator-queue (счётчики
 *     totalEvaluated/totalFailed мутируются через callback'и `incrementEvaluated`
 *     / `incrementFailed`).
 *   - Никогда не throw'ает наружу — все ошибки идут в emit + cache-db status.
 *
 * Pipeline:
 *   1. Загрузить markdown + распарсить главы
 *   2. Построить Structural Surrogate (TOC + intro/outro + nodal slices)
 *   3. Подобрать модель (modelOverride > preferred from prefs > pickEvaluatorModel)
 *   4. LLM вызов через scheduler.enqueue("medium") для observability
 *   5. Persist quality result в cache-db + frontmatter
 *   6. Uniqueness step (отдельный модуль, graceful skip)
 *   7. Emit `evaluator.done`
 *
 * Все retry/abort/error paths сохранены 1-в-1 с оригиналом — контракт UI
 * (events на renderer) и persistence не меняется.
 */

import { getBookById, upsertBook } from "./cache-db.js";
import { buildSurrogate } from "./surrogate-builder.js";
import { parseBookMarkdownChapters } from "./md-converter.js";
import { extractMetadataHints } from "./evaluator-persist.js";
import { isAbortError } from "../resilience/lm-request-policy.js";
import { getImportScheduler } from "./import-task-scheduler.js";
import { logModelAction } from "../llm/lmstudio-actions-log.js";
import { runUniquenessStep } from "./evaluator-uniqueness-step.js";
import { getModelContext } from "../token/overflow-guard.js";
import type { BookCatalogMeta, EvaluationResult } from "./types.js";
import { buildEvaluatedMeta, buildEvaluatorDoneEvent } from "./evaluator-mapping.js";
import type { EvaluatorEvent } from "./evaluator-queue.js";
import type { PickEvaluatorModelOptions } from "./book-evaluator.js";

/**
 * v1.1.2 surrogate truncate — защита от LM Studio HTTP 400
 * `n_keep >= n_ctx`. До этого фикса большие книги (Polars ~111k слов)
 * генерировали surrogate ~11k токенов, а evaluator-модель часто загружена
 * с n_ctx=4096 — запрос валился без оценки.
 *
 * Стратегия: после сборки surrogate + metadata hints оцениваем размер
 * в токенах char-heuristic (3.0 chars/token для mixed Cyr/Lat), если
 * превышает доступный budget модели — обрезаем по границе слова и
 * приписываем технический маркер. Truncation отражается в warnings,
 * чтобы пользователь видел что оценка проводилась по урезанному тексту.
 *
 * Conservative fallback (4096) применяется когда `getModelContext`
 * не знает n_ctx модели (она загружена не через model-pool, либо до
 * этой сессии). Это старое поведение «грузим как есть, надеемся».
 *
 * RESERVED_TOKENS покрывает system prompt (~1500 для Chief Epistemologist)
 * + JSON output reserve (~1000) + structured output overhead. */
const TOKEN_ESTIMATE_CHARS_PER_TOKEN = 3.0;
const SURROGATE_RESERVED_TOKENS = 2500;
const SURROGATE_SAFETY_FACTOR = 0.9;
const SURROGATE_FALLBACK_NCTX = 4096;

interface SurrogateBudgetResult {
  /** Готовый текст для evaluator (truncated если нужно). */
  text: string;
  /** Если truncate был применён — описание для warnings. */
  truncationWarning: string | null;
}

interface SurrogateComposition {
  tocChapters: number;
  introWords: number;
  outroWords: number;
  totalWords: number;
  /** Сколько nodal-срезов было в полном surrogate (до truncation). */
  nodalCount: number;
}

/**
 * Truncate surrogate под model context window. Когда срез происходит,
 * **prepend'им [COMPOSITION] блок наверх** — он переживает обрезание (cut
 * только с хвоста) и явно сообщает LLM что:
 *   - Исходная книга имела N слов
 *   - Surrogate структура: TOC + intro(W1) + outro(W2) + K nodal slices
 *   - Часть текста была обрезана
 *
 * Без этого блока LLM на small-n_ctx моделях видит обрезанный intro/middle
 * и оценивает книгу как структурно неполную, хотя дело только в budget'е.
 */
function applySurrogateTokenBudget(
  text: string,
  modelKey: string,
  composition?: SurrogateComposition,
): SurrogateBudgetResult {
  const ctx = getModelContext(modelKey) ?? SURROGATE_FALLBACK_NCTX;
  const tokenBudget = Math.max(
    500,
    Math.floor(ctx * SURROGATE_SAFETY_FACTOR) - SURROGATE_RESERVED_TOKENS,
  );
  const estimatedTokens = Math.ceil(text.length / TOKEN_ESTIMATE_CHARS_PER_TOKEN);
  if (estimatedTokens <= tokenBudget) {
    return { text, truncationWarning: null };
  }
  /* Composition annotation block — prepend перед truncation, чтобы пережил
   * cut. Если composition не передана, остаётся generic message. */
  const compHeader = composition
    ? `# SURROGATE COMPOSITION (truncated below)\n` +
      `Original book: ${composition.totalWords} words across ${composition.tocChapters} chapters.\n` +
      `Surrogate normally contains: TOC(${composition.tocChapters} ch) + ` +
      `intro(~${composition.introWords}w) + outro(~${composition.outroWords}w) + ` +
      `${composition.nodalCount} nodal slices.\n` +
      `Due to small model context (n_ctx=${ctx}), only the head fits below.\n` +
      `Evaluate based on what's available — don't penalize structural completeness.\n\n`
    : "";

  const targetChars = Math.max(1, Math.floor(tokenBudget * TOKEN_ESTIMATE_CHARS_PER_TOKEN) - compHeader.length);
  const head = text.slice(0, targetChars);
  const lastSpace = head.lastIndexOf(" ");
  const cutAt = lastSpace > targetChars * 0.95 ? lastSpace : targetChars;
  const truncated = `${compHeader}${head.slice(0, cutAt).trimEnd()}\n\n[...surrogate truncated to fit model context window (n_ctx=${ctx})...]`;
  const truncationWarning = `surrogate truncated: ~${estimatedTokens}→~${tokenBudget} tokens (model n_ctx=${ctx})`;
  return { text: truncated, truncationWarning };
}

/** Per-slot mutable state — owned and reset by evaluator-queue. */
export interface SlotState {
  active: boolean;
  bookId: string | null;
  title: string | null;
  controller: AbortController | null;
}

/** Dependencies + callbacks injected by evaluator-queue. */
export interface SlotWorkerDeps {
  /** Read book.md from disk (DI hook for tests). */
  readFile: (mdPath: string) => Promise<string>;
  /** Run quality evaluator LLM call. */
  evaluateBook: (
    surrogate: string,
    opts: { model: string; signal: AbortSignal },
  ) => Promise<EvaluationResult>;
  /** Resolve model from preferred/fallbacks/auto-load. */
  pickEvaluatorModel: (opts: PickEvaluatorModelOptions) => Promise<string | null>;
  /** Read evaluator-related prefs (preferred model, fallbacks, allowFallback). */
  readEvaluatorPrefs: () => Promise<{
    preferred?: string;
    fallbacks?: string[];
    allowFallback: boolean;
  }>;

  /** Emit lifecycle event to subscribers (single source of EventEmitter). */
  emit: (event: EvaluatorEvent) => void;
  /** Append a warning to meta.warnings if not already present. */
  appendWarning: (meta: BookCatalogMeta, warning: string) => string[];
  /** Persist `meta` to frontmatter atomically (with book-md mutex). */
  persistFrontmatter: (
    meta: BookCatalogMeta,
    mdPath: string,
    md: string,
    reasoning?: string | null,
  ) => Promise<void>;
  /** Classify error message as retryable (network blip, circuit open, ...). */
  isRetryableEvaluatorIssue: (message: string) => boolean;
  /** Push book back to queue with status=imported + warning. */
  deferEvaluationRetry: (
    meta: BookCatalogMeta & { mdPath: string },
    md: string,
    reason: string,
    bookId: string,
    title: string | null,
  ) => Promise<void>;
  /** Pause the queue (called from catch when retry path runs out). */
  pauseEvaluator: () => void;

  /**
   * Read-and-clear per-book autoLoad permission. v1.0.7 contract:
   * cold-start resume не должен грузить модель с диска без явного запроса.
   */
  consumeAutoLoadAllowed: (bookId: string) => boolean;
  /** Get current modelOverride (set via setEvaluatorModel IPC). */
  getModelOverride: () => string | null;
  /** Bump totalEvaluated counter shown in EvaluatorStatus. */
  incrementEvaluated: () => void;
  /** Bump totalFailed counter shown in EvaluatorStatus. */
  incrementFailed: () => void;
}

/**
 * Один прогон evaluation для книги в данном slot'е. Idempotent на повторе:
 * при `meta.status !== "imported"` — skip (защита от race с rerun).
 */
export async function evaluateOneInSlot(
  bookId: string,
  slot: SlotState,
  deps: SlotWorkerDeps,
): Promise<void> {
  /* Считываем + СРАЗУ удаляем разрешение на autoLoad (одноразовое).
     Если книга вернётся в очередь через deferEvaluationRetry — она
     попадёт уже без права грузить с диска (что и нужно для cold-start). */
  const allowAutoLoadForThisBook = deps.consumeAutoLoadAllowed(bookId);

  let meta = getBookById(bookId);
  if (!meta) {
    deps.emit({ type: "evaluator.skipped", bookId, error: "book not in cache-db" });
    return;
  }
  /* Уже оценена? Тогда пропускаем (на случай race). */
  if (meta.status !== "imported") {
    deps.emit({ type: "evaluator.skipped", bookId, title: meta.title });
    return;
  }

  slot.bookId = bookId;
  slot.title = meta.titleEn ?? meta.title;
  slot.controller = new AbortController();
  deps.emit({ type: "evaluator.started", bookId, title: slot.title });

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
        warnings: deps.appendWarning(meta, reason),
      };
      upsertBook(failed, meta.mdPath);
      await deps.persistFrontmatter(failed, meta.mdPath, md);
      deps.incrementFailed();
      deps.emit({ type: "evaluator.failed", bookId, title: slot.title, error: "no chapters" });
      return;
    }

    /* 2. Surrogate. */
    const surrogate = buildSurrogate(chapters);

    /* 2b. Pre-scan: regex hints for author/year from frontmatter + filename + full text. */
    const metaHints = extractMetadataHints(md, meta);
    let surrogateWithHints = metaHints.length > 0
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
    /* allowAnyLoadedFallback: если preferred задан → false: не подменяем на
       произвольную LLM, а загружаем нужную (если разрешено флагом). */
    const allowFallback = evaluatorPrefs.allowFallback;
    const allowAnyLoadedFallbackEffective = evaluatorPrefs.preferred ? false : allowFallback;
    const model = deps.getModelOverride() ?? (await deps.pickEvaluatorModel({
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
      await deps.deferEvaluationRetry(meta, md, reason, bookId, slot.title);
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

    /* 3b. v1.1.2: truncate surrogate под n_ctx модели. До этого фикса большие
       книги (≥ ~2k слов на surrogate × 3 toks/word) валили LM Studio с HTTP 400
       n_keep ≥ n_ctx. Теперь ориентируемся на зарегистрированный n_ctx
       (overflow-guard) либо safe fallback 4096. Truncation отражается в
       warnings, чтобы пользователь видел что оценка проводилась по
       обрезанному surrogate. */
    const surrogateBudget = applySurrogateTokenBudget(surrogateWithHints, model, {
      tocChapters: surrogate.composition.tocChapters,
      introWords: surrogate.composition.introWords,
      outroWords: surrogate.composition.outroWords,
      totalWords: surrogate.composition.totalWords,
      nodalCount: surrogate.composition.nodalSlices.length,
    });
    if (surrogateBudget.truncationWarning) {
      surrogateWithHints = surrogateBudget.text;
      meta = {
        ...meta,
        warnings: [...(meta.warnings ?? []), surrogateBudget.truncationWarning],
      };
      logModelAction("EVALUATOR-SURROGATE-TRUNCATE", {
        role: "evaluator",
        modelKey: model,
        reason: surrogateBudget.truncationWarning,
        meta: { bookId, title: slot.title ?? meta.title },
      });
    }

    /* 4. LLM call. Используем signal этого слота — параллельные слоты
       имеют независимые AbortController'ы, cancel одного не валит других.

       Iter 7: оборачиваем вызов в scheduler.enqueue("medium") для observability —
       UI widget видит счётчик medium-lane (running/queued) во время evaluation. */
    const slotSignal = slot.controller!.signal;
    const result = await getImportScheduler().enqueue("medium", () =>
      deps.evaluateBook(surrogateWithHints, { model, signal: slotSignal }),
    );
    if (!result.evaluation) {
      const reason = result.warnings.join("; ") || "evaluation returned null";
      if (deps.isRetryableEvaluatorIssue(reason)) {
        await deps.deferEvaluationRetry(meta, md, reason, bookId, slot.title);
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
      await deps.persistFrontmatter(failed, meta.mdPath, md, result.reasoning);
      deps.incrementFailed();
      deps.emit({
        type: "evaluator.failed", bookId, title: slot.title,
        error: result.warnings.join("; ") || "evaluation returned null",
        warnings: result.warnings,
      });
      return;
    }

    /* 5. Build updated meta — pure mapping (см. evaluator-mapping.ts +
       tests/evaluator-mapping.test.ts). */
    const updated: BookCatalogMeta = buildEvaluatedMeta({
      baseMeta: meta,
      result,
      evaluatedAt: new Date().toISOString(),
    });
    upsertBook(updated, meta.mdPath);
    await deps.persistFrontmatter(updated, meta.mdPath, md, result.reasoning);
    deps.incrementEvaluated();

    /* 6. Uniqueness pass — отдельный модуль; никогда не throw'ает наружу,
     * quality result уже сохранён выше — uniqueness не валит pipeline. */
    await runUniquenessStep({
      baseMeta: updated,
      chapters,
      mdPath: meta.mdPath,
      md,
      reasoning: result.reasoning,
      signal: slotSignal,
      persistFrontmatter: deps.persistFrontmatter,
      upsertBook,
    });

    /* 7. Emit done — payload собирается тем же helper'ом, что и meta,
       чтобы schema контракт был в одном месте. */
    deps.emit(buildEvaluatorDoneEvent(bookId, result));
  } catch (err) {
    /* Сверяем abort через единый helper (проверяет ABORT_SENTINEL или
       /aborted/i) -- консистентно с lm-request-policy. */
    const msg = err instanceof Error ? err.message : String(err);
    if (isAbortError(err) || slot.controller?.signal.aborted) {
      upsertBook({ ...meta, status: "imported" }, meta.mdPath);
      deps.emit({ type: "evaluator.skipped", bookId, title: slot.title, error: "aborted" });
    } else {
      if (deps.isRetryableEvaluatorIssue(msg)) {
        try {
          const md = await deps.readFile(meta.mdPath);
          await deps.deferEvaluationRetry(meta, md, msg, bookId, slot.title);
        } catch {
          const warning = `evaluator deferred: ${msg}`;
          upsertBook({
            ...meta,
            status: "imported",
            lastError: warning,
            warnings: deps.appendWarning(meta, warning),
          }, meta.mdPath);
          deps.pauseEvaluator();
          deps.emit({ type: "evaluator.skipped", bookId, title: slot.title, error: warning });
        }
        return;
      }
      const reason = `evaluator: ${msg}`;
      const failed: BookCatalogMeta = {
        ...meta,
        status: "failed",
        lastError: reason,
        warnings: deps.appendWarning(meta, reason),
      };
      upsertBook(failed, meta.mdPath);
      try {
        const md = await deps.readFile(meta.mdPath);
        await deps.persistFrontmatter(failed, meta.mdPath, md);
      } catch {
        /* tolerate */
      }
      deps.incrementFailed();
      deps.emit({ type: "evaluator.failed", bookId, title: slot.title, error: msg });
    }
  }
}
