/**
 * Stage 4 — LLM-as-Judge + Cross-Library Dedup.
 *
 * Перед LLM (дёшево):
 *   - embed principle → Qdrant search в коллекции `dataset-accepted-concepts`
 *     с filter по `domain`. Если top-1 score > 0.85 → автодубликат, отбросить.
 *
 * Если прошёл — LLM-судья оценивает по 3 осям:
 *   - novelty (для опытного практика)
 *   - actionability (можно применить?)
 *   - domain_fit (соответствие заявленному domain)
 *
 * weighted score = 0.5*novelty + 0.3*actionability + 0.2*domain_fit
 * Threshold 0.6 (configurable).
 *
 * Принятые → upsert в Qdrant (positive feedback loop для следующих книг).
 */

import { promises as fs } from "fs";
import * as path from "path";
import { embedQuery } from "../rag/index.js";
import { fetchQdrantJson, QDRANT_URL } from "../qdrant/http-client.js";
import { EMBEDDING_DIM } from "../scanner/embedding.js";
import { isAbortError } from "../resilience/lm-request-policy.js";
import { JudgeResultSchema, type AcceptedConcept, type DedupedConcept, type JudgeResult } from "./types.js";
import { extractJsonObjectFromReasoning } from "./reasoning-decoder.js";
import type { LlmCallResult } from "./concept-extractor.js";

export const ACCEPTED_COLLECTION = "dataset-accepted-concepts";
const CROSS_LIB_DUPE_THRESHOLD = 0.85;
const DEFAULT_SCORE_THRESHOLD = 0.6;

export interface JudgeCallbacks {
  /** Возвращает либо просто строку (старый контракт), либо
   *  {content, reasoningContent} — для thinking-моделей через reasoning-decoder. */
  llm: (args: {
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
    temperature?: number;
    maxTokens?: number;
  }) => Promise<LlmCallResult>;
  onEvent?: (e: JudgeEvent) => void;
}

export type JudgeEvent =
  | { type: "judge.crossdupe"; principle: string; existingId: string; sim: number }
  | { type: "judge.score"; principle: string; score: number; novelty: number; actionability: number; domain_fit: number }
  | { type: "judge.reject.lowscore"; principle: string; score: number; reason: string }
  | { type: "judge.reject.error"; principle: string; reason: string }
  | { type: "judge.accept"; conceptId: string; principle: string; domain: string; score: number };

const PROMPT_CACHE: { template: string | null } = { template: null };

function bundledJudgeCandidates(): string[] {
  const candidates: string[] = [];
  if (process.env.BIBLIARY_PROMPTS_DEFAULT_DIR) {
    candidates.push(path.join(process.env.BIBLIARY_PROMPTS_DEFAULT_DIR, "concept-judge.md"));
  }
  if (typeof __dirname !== "undefined") {
    candidates.push(path.resolve(__dirname, "..", "..", "defaults", "prompts", "concept-judge.md"));
  }
  candidates.push(path.resolve(process.cwd(), "electron", "defaults", "prompts", "concept-judge.md"));
  return candidates;
}

async function loadPromptTemplate(promptsDir: string | null): Promise<string> {
  if (PROMPT_CACHE.template) return PROMPT_CACHE.template;
  if (promptsDir) {
    try {
      const userText = await fs.readFile(path.join(promptsDir, "concept-judge.md"), "utf8");
      if (userText.trim().length > 50) {
        PROMPT_CACHE.template = userText;
        return userText;
      }
    } catch {
      /* fallback */
    }
  }
  for (const candidate of bundledJudgeCandidates()) {
    try {
      const text = await fs.readFile(candidate, "utf8");
      if (text.trim().length > 50) {
        PROMPT_CACHE.template = text;
        return text;
      }
    } catch {
      /* try next */
    }
  }
  throw new Error("concept-judge.md not found in any default location");
}

export function clearJudgePromptCache(): void {
  PROMPT_CACHE.template = null;
}

/* ────────────────── Cross-library check + collection management ────────────────── */

/**
 * Валидация имени Qdrant-коллекции на стороне judge.
 *
 * Why: контракт `targetCollection` — string, но у нас 4 слоя (judge → IPC →
 * preload → renderer/UI), любой может прислать пустую строку или мусор.
 * Раньше при пустой строке URL превращался в `/collections//points/search`
 * и Qdrant отвечал 404 — ошибка была понятна только глядя на сетевой лог.
 * Теперь падаем явным сообщением в judgeAndAccept(), не дойдя до HTTP.
 *
 * Правила Qdrant: 1-255 символов, только латиница/цифры/подчёркивание/дефис.
 * Совместимо с UI-валидатором в qdrant.ipc.ts:create-collection (если пользователь
 * сможет создать коллекцию, имя точно пройдёт здесь).
 */
const COLLECTION_NAME_RE = /^[A-Za-z0-9_-]{1,255}$/;
export function assertValidCollectionName(name: string): void {
  if (typeof name !== "string" || !COLLECTION_NAME_RE.test(name)) {
    throw new Error(
      `invalid Qdrant collection name "${name}": expected 1-255 chars [A-Za-z0-9_-]`
    );
  }
}

async function ensureAcceptedCollection(collection: string): Promise<void> {
  assertValidCollectionName(collection);
  try {
    await fetchQdrantJson(`${QDRANT_URL}/collections/${collection}`);
    return;
  } catch {
    /* probe failed — try create (404 ловится в catch как HTTP, не differentiation) */
  }
  try {
    await fetchQdrantJson(`${QDRANT_URL}/collections/${collection}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vectors: { size: EMBEDDING_DIM, distance: "Cosine" } }),
    });
    /* best-effort indexes */
    for (const field of ["domain", "tags", "bookSourcePath"]) {
      await fetchQdrantJson(`${QDRANT_URL}/collections/${collection}/index`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ field_name: field, field_schema: "keyword" }),
      }).catch(() => undefined);
    }
  } catch (e) {
    /* Если не смогли создать — это критично, пробрасываем */
    throw new Error(
      `failed to ensure accepted collection "${collection}": ${e instanceof Error ? e.message : e}`
    );
  }
}

interface CrossSearchHit {
  id: string;
  score: number;
}

async function crossLibrarySearch(
  domain: string,
  vector: number[],
  collection: string
): Promise<CrossSearchHit | null> {
  await ensureAcceptedCollection(collection);
  const data = await fetchQdrantJson<{ result: Array<{ id: string | number; score: number }> }>(
    `${QDRANT_URL}/collections/${collection}/points/search`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        vector,
        limit: 1,
        with_payload: false,
        filter: { must: [{ key: "domain", match: { value: domain } }] },
      }),
    }
  );
  if (data.result.length === 0) return null;
  const top = data.result[0];
  return { id: String(top.id), score: top.score };
}

/**
 * AUDIT MED-5: ранее upsert шёл голым `fetch()` без timeout — зависший
 * Qdrant вешал весь job (judge ждал бесконечно, signal не обрывал HTTP).
 * fetchQdrantJson даёт QDRANT_TIMEOUT_MS и единые headers с API-ключом.
 * Upsert с `wait=true` может занимать дольше search'а — даём 15s.
 */
async function upsertAccepted(
  concept: AcceptedConcept,
  vector: number[],
  collection: string
): Promise<void> {
  await ensureAcceptedCollection(collection);
  /* Payload собираем по slot'ам, чтобы reasoning-поля не появлялись
     ключами с undefined value (Qdrant их хранит как null -- мусорит индексы). */
  const payload: Record<string, unknown> = {
    principle: concept.principle,
    explanation: concept.explanation,
    domain: concept.domain,
    tags: concept.tags,
    noveltyHint: concept.noveltyHint,
    sourceQuote: concept.sourceQuote,
    bookSourcePath: concept.bookSourcePath,
    bookTitle: concept.bookTitle,
    chapterIndex: concept.chapterIndex,
    chapterTitle: concept.chapterTitle,
    judgeScore: concept.judgeScore,
    judgeReasoning: concept.judgeReasoning,
    scoreBreakdown: concept.scoreBreakdown,
    acceptedAt: concept.acceptedAt,
  };
  if (concept.extractorReasoning) payload.extractorReasoning = concept.extractorReasoning;
  if (concept.judgeReasoningTrace) payload.judgeReasoningTrace = concept.judgeReasoningTrace;
  await fetchQdrantJson(`${QDRANT_URL}/collections/${collection}/points?wait=true`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      points: [{ id: concept.id, vector, payload }],
    }),
    timeoutMs: 15_000,
  });
}

/* ────────────────── Judge LLM call ────────────────── */

function tryParseJudgeJson(raw: string): unknown {
  let cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "");
  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) cleaned = cleaned.slice(first, last + 1);
  return JSON.parse(cleaned);
}

function normalizeJudgeLlmResult(r: LlmCallResult): { content: string; reasoningContent?: string } {
  if (typeof r === "string") return { content: r };
  return { content: r.content ?? "", reasoningContent: r.reasoningContent };
}

async function llmJudge(
  concept: DedupedConcept,
  template: string,
  cb: JudgeCallbacks
): Promise<{ result: JudgeResult; reasoningTrace: string | null } | null> {
  const conceptForLlm = {
    principle: concept.principle,
    explanation: concept.explanation,
    domain: concept.domain,
    tags: concept.tags,
    noveltyHint: concept.noveltyHint,
  };
  const prompt = template.replace("{{CONCEPT_JSON}}", JSON.stringify(conceptForLlm, null, 2));
  let lm: { content: string; reasoningContent?: string };
  try {
    lm = normalizeJudgeLlmResult(
      await cb.llm({
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2,
        /* AUDIT: 800 токенов было мало для chain-of-thought reasoning у quality-моделей —
           они начинали JSON, не успевали закрыть → schema parse fail → judge-error.
           1500 даёт безопасный запас на 200-400 токенов размышления + структурированный
           ответ. Caller hint всё равно перекрывается профилем модели в makeLlm
           (thinking-моделям дадут больше). */
        maxTokens: 1500,
      }),
    );
  } catch (e) {
    /* Cancel job'а != "judge не смог оценить". Без re-throw'а отмена выглядит
       как rejected concept и судья продолжает прожаривать следующие.
       Закрывает AUDIT HIGH-2. */
    if (isAbortError(e)) throw e;
    cb.onEvent?.({ type: "judge.reject.error", principle: concept.principle.slice(0, 60), reason: e instanceof Error ? e.message : String(e) });
    return null;
  }

  /* Двухисточниковый парсинг: content → reasoning_content fallback.
     Thinking-модели часто кладут JudgeResult в reasoning при response_format=json_schema. */
  let parsed: unknown = null;
  if (lm.content.trim().length > 0) {
    try {
      parsed = tryParseJudgeJson(lm.content);
    } catch {
      /* fallthrough на reasoning */
    }
  }
  if (parsed === null && lm.reasoningContent) {
    const decoded = extractJsonObjectFromReasoning(lm.reasoningContent);
    if (decoded) {
      try {
        parsed = JSON.parse(decoded);
      } catch {
        /* остаётся null, ниже отрапортуем */
      }
    }
  }
  if (parsed === null) {
    cb.onEvent?.({
      type: "judge.reject.error",
      principle: concept.principle.slice(0, 60),
      reason: lm.content.trim().length === 0 && !lm.reasoningContent ? "empty-response" : "parse-failed-in-content-and-reasoning",
    });
    return null;
  }

  const result = JudgeResultSchema.safeParse(parsed);
  if (!result.success) {
    cb.onEvent?.({ type: "judge.reject.error", principle: concept.principle.slice(0, 60), reason: `schema: ${result.error.message.slice(0, 100)}` });
    return null;
  }
  /* Reasoning trace -- приоритет: отдельное поле, иначе <think> в content. */
  let reasoningTrace: string | null = null;
  if (lm.reasoningContent && lm.reasoningContent.trim().length > 0) {
    reasoningTrace = lm.reasoningContent.trim();
  } else {
    const m = lm.content.match(/<think>([\s\S]*?)<\/think>/i);
    if (m && m[1].trim().length > 0) reasoningTrace = m[1].trim();
  }
  return { result: result.data, reasoningTrace };
}

function weightedScore(j: JudgeResult): number {
  return 0.5 * j.novelty + 0.3 * j.actionability + 0.2 * j.domain_fit;
}

/**
 * Косинус для нормализованных E5-векторов (единичная длина → достаточно
 * скалярного произведения, без деления на нормы). Используется для
 * in-batch dedup'а — экономит лишнюю перенормировку.
 */
function cosineNormalised(a: number[], b: number[]): number {
  let dot = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) dot += a[i] * b[i];
  return dot;
}

/* ────────────────── Main entry ────────────────── */

export interface JudgeBatchArgs {
  concepts: DedupedConcept[];
  promptsDir?: string | null;
  callbacks: JudgeCallbacks;
  scoreThreshold?: number;
  crossLibDupeThreshold?: number;
  /** Если signal aborted — выходим между концептами без следующего LLM/Qdrant call. */
  signal?: AbortSignal;
  /**
   * Имя Qdrant-коллекции для cross-library check + upsert принятых концептов.
   *
   * По умолчанию — `ACCEPTED_COLLECTION` (back-compat для e2e-скриптов и
   * существующего UI без collection-picker'а). Передавайте explicit имя
   * для тематических коллекций (marketing, ux, seo и т.д.) -- так у LoRA
   * датасета будет thematic isolation: cross-library dedup ищет дубликаты
   * только внутри той же темы, без шума из других доменов.
   *
   * Имя валидируется по `/^[A-Za-z0-9_-]{1,255}$/` (правила Qdrant).
   */
  targetCollection?: string;
}

export interface JudgeBatchResult {
  accepted: AcceptedConcept[];
  rejected: Array<{ concept: DedupedConcept; reason: string }>;
}

export async function judgeAndAccept(args: JudgeBatchArgs): Promise<JudgeBatchResult> {
  const template = await loadPromptTemplate(args.promptsDir ?? null);
  const threshold = args.scoreThreshold ?? DEFAULT_SCORE_THRESHOLD;
  const crossTh = args.crossLibDupeThreshold ?? CROSS_LIB_DUPE_THRESHOLD;
  /* Единственная точка резолва дефолта коллекции в этом модуле.
     Все internal helpers требуют explicit collection -- так невозможно
     случайно записать в дефолт из глубины пайплайна. Валидация имени
     происходит при первом вызове ensureAcceptedCollection. */
  const collection = args.targetCollection ?? ACCEPTED_COLLECTION;

  const accepted: AcceptedConcept[] = [];
  const rejected: Array<{ concept: DedupedConcept; reason: string }> = [];

  /* AUDIT MED-7: между upsertAccepted (с wait=true) и следующим
     crossLibrarySearch по той же batch есть микро-окно, когда Qdrant
     уже принял точку, но search-индекс ещё её не видит (особенно при
     высокой нагрузке). Локальный кэш уже принятых в ЭТОЙ batch
     закрывает race без лишних round-trip'ов: если новый concept
     слишком похож на уже принятый в той же сессии — отбрасываем как
     in-batch duplicate. Группируем по domain, потому что cross-search
     тоже фильтрует по domain.
     AUDIT δ-6.3: cap на 200 per domain — без него batch=1000 в одном
     domain даёт 10⁶ cosine-сравнений (O(N²)). FIFO eviction: старые
     концепты уже индексированы в Qdrant и catchable через cross-search. */
  const MAX_INBATCH_PER_DOMAIN = 200;
  const inBatchCache = new Map<string, Array<{ id: string; vector: number[] }>>();

  for (const concept of args.concepts) {
    if (args.signal?.aborted) {
      throw new Error("aborted: judge cancelled between concepts");
    }
    const vector = await embedQuery(concept.principle);

    /* 1a. In-batch check (мгновенно, в памяти) */
    const sameDomain = inBatchCache.get(concept.domain) ?? [];
    let inBatchHit: { id: string; sim: number } | null = null;
    for (const prev of sameDomain) {
      const sim = cosineNormalised(vector, prev.vector);
      if (sim > crossTh) {
        inBatchHit = { id: prev.id, sim };
        break;
      }
    }
    if (inBatchHit) {
      args.callbacks.onEvent?.({
        type: "judge.crossdupe",
        principle: concept.principle.slice(0, 60),
        existingId: inBatchHit.id,
        sim: inBatchHit.sim,
      });
      rejected.push({
        concept,
        reason: `in-batch duplicate of ${inBatchHit.id} (sim=${inBatchHit.sim.toFixed(3)})`,
      });
      continue;
    }

    /* 1b. Cross-library check (Qdrant search, бесплатно без LLM) */
    let crossHit: CrossSearchHit | null = null;
    try {
      crossHit = await crossLibrarySearch(concept.domain, vector, collection);
    } catch (e) {
      /* Qdrant timeout/down — пропускаем cross-check, доверяем LLM.
         Но если Qdrant прервался по abort'у — всё равно выходим. */
      if (isAbortError(e)) throw e;
    }
    if (crossHit && crossHit.score > crossTh) {
      args.callbacks.onEvent?.({
        type: "judge.crossdupe",
        principle: concept.principle.slice(0, 60),
        existingId: crossHit.id,
        sim: crossHit.score,
      });
      rejected.push({ concept, reason: `cross-library duplicate of ${crossHit.id} (sim=${crossHit.score.toFixed(3)})` });
      continue;
    }

    /* 2. LLM judge */
    const judgeOutcome = await llmJudge(concept, template, args.callbacks);
    if (!judgeOutcome) {
      rejected.push({ concept, reason: "judge-error" });
      continue;
    }
    const judgeResult = judgeOutcome.result;
    const score = weightedScore(judgeResult);
    args.callbacks.onEvent?.({
      type: "judge.score",
      principle: concept.principle.slice(0, 60),
      score,
      novelty: judgeResult.novelty,
      actionability: judgeResult.actionability,
      domain_fit: judgeResult.domain_fit,
    });

    if (score < threshold) {
      args.callbacks.onEvent?.({
        type: "judge.reject.lowscore",
        principle: concept.principle.slice(0, 60),
        score,
        reason: judgeResult.reasoning,
      });
      rejected.push({ concept, reason: `low score ${score.toFixed(3)} < ${threshold}: ${judgeResult.reasoning}` });
      continue;
    }

    /* 3. Accept + upsert */
    const acceptedConcept: AcceptedConcept = {
      ...concept,
      judgeScore: score,
      judgeReasoning: judgeResult.reasoning,
      acceptedAt: new Date().toISOString(),
      scoreBreakdown: {
        novelty: judgeResult.novelty,
        actionability: judgeResult.actionability,
        domain_fit: judgeResult.domain_fit,
      },
      ...(judgeOutcome.reasoningTrace ? { judgeReasoningTrace: judgeOutcome.reasoningTrace } : {}),
    };
    try {
      await upsertAccepted(acceptedConcept, vector, collection);
    } catch (e) {
      if (isAbortError(e)) throw e;
      rejected.push({ concept, reason: `upsert-error: ${e instanceof Error ? e.message : e}` });
      continue;
    }
    /* Регистрируем в локальном кэше — следующий concept этой batch'а
       увидит дубликат даже если Qdrant ещё не обновил search-индекс. */
    const slot = inBatchCache.get(concept.domain) ?? [];
    slot.push({ id: concept.id, vector });
    if (slot.length > MAX_INBATCH_PER_DOMAIN) {
      slot.shift();
    }
    inBatchCache.set(concept.domain, slot);

    args.callbacks.onEvent?.({
      type: "judge.accept",
      conceptId: concept.id,
      principle: concept.principle.slice(0, 60),
      domain: concept.domain,
      score,
    });
    accepted.push(acceptedConcept);
  }

  return { accepted, rejected };
}
