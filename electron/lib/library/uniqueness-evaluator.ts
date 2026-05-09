/**
 * Uniqueness Evaluator — оценка книги на наличие УНИКАЛЬНЫХ идей по сравнению
 * с уже накопленным корпусом в vectordb.
 *
 * Текущий quality-evaluator оценивает книгу как объект (структура, density,
 * originality по описанию). Он не знает: «эту книгу уже читали раньше в
 * другом источнике?». Без этого две книги по одной теме оба пройдут с
 * близкими score'ами, при ingest вторая забьёт vectordb дубликатами концептов
 * первой — датасет загрязняется.
 *
 * Pipeline (4 фазы):
 *   1. extractIdeasPerChapter   — reader LLM выдаёт 3-7 ключевых идей на главу
 *   2. dedupeIdeasWithinBook    — greedy clustering по cosine ≥ merge threshold
 *   3. cross-library novelty    — vectorQueryNearest, серая зона → LLM judge
 *   4. score                    — round(100 × novel / total), undefined при total=0
 *
 * Эмбеддинги идей (multilingual-e5-small, 384-dim) уже L2-нормализованы.
 * Центроиды кластеров пере-нормализуем после mean (см. l2Normalize), иначе
 * cosine с vectordb-векторами получается заниженным.
 *
 * Никогда не throw'ает: caller получает либо score, либо `undefined` +
 * `error` — uniqueness не должен ломать import pipeline.
 */

import { chatWithPolicy } from "../../lmstudio-client.js";
import { embedPassage, l2Normalize } from "../embedder/shared.js";
import { vectorQueryNearest, type VectorNearestNeighbor } from "../vectordb/index.js";
import { parseReasoningResponse, stripProseReasoning } from "./reasoning-parser.js";
import { logModelAction } from "../llm/lmstudio-actions-log.js";
import type { ConvertedChapter } from "./types.js";

/* ─── Public types ──────────────────────────────────────────────────── */

export interface BookIdea {
  title: string;
  essence: string;
  /** Индекс главы для логов / debug. */
  chapterIndex: number;
}

export interface IdeaCluster {
  /** L2-нормализованный центроид (||v||=1). */
  centroid: number[];
  /** Сколько исходных идей в кластере. */
  count: number;
  /** Любая идея из кластера для UI/debug (берём первую). */
  sampleEssence: string;
}

export interface UniquenessResult {
  /** 0..100, undefined при totalIdeas=0 (НЕ 0 — это «оценка не проводилась»). */
  score: number | undefined;
  novelCount: number;
  totalIdeas: number;
  /** Если процесс упал — текст ошибки для UI tooltip. */
  error?: string;
}

export interface EvaluateBookUniquenessOptions {
  /** Какую LLM использовать для extract+judge. Если не задана — caller должен передать. */
  modelKey: string;
  /** Имя vectordb коллекции для cross-library check. */
  targetCollection: string;
  /** Cosine ≥ high ⇒ DERIVATIVE без LLM-judge. */
  similarityHigh: number;
  /** Cosine < low ⇒ NOVEL без LLM-judge. */
  similarityLow: number;
  /** Hard cap на число идей из главы. */
  ideasPerChapterMax: number;
  /** Параллелизм LLM по главам. */
  chapterParallel: number;
  /** Within-book merge threshold (cosine). */
  mergeThreshold: number;
  /** Прерывание долгих операций. */
  signal?: AbortSignal;
}

/* ─── Phase 1 — per-chapter idea extraction ────────────────────────── */

const EXTRACT_SYSTEM_PROMPT = `You extract the central ideas from a book chapter.

Output strictly this valid JSON structure (no markdown fences, no comments,
no <think> blocks):
{"ideas": [{"title": "Short title", "essence": "Clear, verifiable claim"}]}

Rules:
  - 3 to 7 ideas per chapter (pick most distinctive, not exhaustive list)
  - Each idea = a self-contained insight, not a topic name
  - "essence" must be a complete claim that could be verified
  - "title" <= 60 chars; "essence" <= 240 chars

Example for a chapter about loop optimization:
{"ideas":[
  {"title":"Hoist invariants","essence":"Move loop-invariant computations outside the loop body to reduce per-iteration cost."},
  {"title":"Cache locality wins","essence":"Iterating arrays in row-major order matches CPU cache lines and is 3-10x faster than column-major."}
]}`;

/* Cap chapter text — first ~6K chars + last ~2K дают хороший охват для
 * большинства книг (intro + conclusion); чистый prefix-cut теряет concluding
 * ideas. Если глава короче — используем весь текст. */
const CHAPTER_HEAD_CHARS = 6000;
const CHAPTER_TAIL_CHARS = 2000;

function compressChapterText(text: string): string {
  if (text.length <= CHAPTER_HEAD_CHARS + CHAPTER_TAIL_CHARS) return text;
  return text.slice(0, CHAPTER_HEAD_CHARS) + "\n\n[…]\n\n" + text.slice(-CHAPTER_TAIL_CHARS);
}

interface IdeaExtractDeps {
  callLlm: (model: string, systemPrompt: string, userText: string, signal?: AbortSignal) => Promise<string>;
  embed: (text: string) => Promise<number[]>;
}

const defaultDeps: IdeaExtractDeps = {
  embed: (text) => embedPassage(text),
  callLlm: async (model, systemPrompt, userText, signal) => {
    const response = await chatWithPolicy(
      {
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userText },
        ],
        sampling: {
          temperature: 0.2,
          top_p: 0.9,
          top_k: 40,
          min_p: 0,
          presence_penalty: 0,
          max_tokens: 2048,
        },
        chatTemplateKwargs: { enable_thinking: false },
        signal,
      },
      { externalSignal: signal },
    );
    return response.content ?? "";
  },
};

let deps: IdeaExtractDeps = defaultDeps;

/** Test-only: подменить LLM call. */
export function _setUniquenessDepsForTesting(overrides: Partial<IdeaExtractDeps>): void {
  deps = { ...defaultDeps, ...overrides };
}

/** Test-only: вернуть дефолты. */
export function _resetUniquenessDepsForTesting(): void {
  deps = defaultDeps;
}

interface RawIdea {
  title?: unknown;
  essence?: unknown;
}

interface RawIdeasPayload {
  ideas?: RawIdea[];
}

/**
 * Извлечь идеи из главы через reader LLM. Никогда не throw'ает: при сбое
 * парсинга возвращает пустой массив (caller трактует как «глава не дала
 * идей», что по семантике корректно).
 */
export async function extractIdeasPerChapter(
  chapter: ConvertedChapter,
  modelKey: string,
  ideasMax: number,
  signal?: AbortSignal,
): Promise<BookIdea[]> {
  const text = compressChapterText(chapter.paragraphs.join("\n\n"));
  if (!text.trim()) return [];

  let raw: string;
  try {
    raw = await deps.callLlm(
      modelKey,
      EXTRACT_SYSTEM_PROMPT,
      `Chapter title: ${chapter.title}\n\n${text}`,
      signal,
    );
  } catch (err) {
    console.warn(`[uniqueness] extractIdeasPerChapter ch${chapter.index} failed:`, err instanceof Error ? err.message : err);
    return [];
  }

  /* Сначала strip prose-CoT (модели без <think> теги пишут CoT в content),
   * потом полноценный parser <think> + JSON. */
  const stripped = stripProseReasoning(raw);
  const parsed = parseReasoningResponse<RawIdeasPayload>(stripped || raw);
  if (!parsed.json || !Array.isArray(parsed.json.ideas)) return [];

  const out: BookIdea[] = [];
  for (const it of parsed.json.ideas) {
    const title = typeof it.title === "string" ? it.title.trim() : "";
    const essence = typeof it.essence === "string" ? it.essence.trim() : "";
    if (!essence) continue;
    out.push({ title, essence, chapterIndex: chapter.index });
    if (out.length >= ideasMax) break;
  }
  return out;
}

/* ─── Phase 2 — within-book dedup (greedy clustering) ─────────────── */

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot; /* оба вектора L2-нормализованы → cosine = dot product */
}

function meanVector(vectors: number[][]): number[] {
  if (vectors.length === 0) return [];
  const dim = vectors[0].length;
  const sum = new Array<number>(dim).fill(0);
  for (const v of vectors) {
    for (let i = 0; i < dim; i++) sum[i] += v[i];
  }
  for (let i = 0; i < dim; i++) sum[i] /= vectors.length;
  return sum;
}

/**
 * Greedy clustering идей по cosine ≥ merge threshold. Эмбеддит каждую идею,
 * присоединяет к ближайшему кластеру если sim ≥ threshold, иначе создаёт
 * новый. Центроид пересчитывается как arithmetic mean всех векторов кластера
 * И ОБЯЗАТЕЛЬНО L2-перенормализуется (без этого ||centroid|| < 1, и cosine с
 * vectordb-векторами получается заниженным — false NOVEL'ы в Phase 3).
 */
export async function dedupeIdeasWithinBook(
  ideas: BookIdea[],
  mergeThreshold: number,
  signal?: AbortSignal,
): Promise<IdeaCluster[]> {
  if (ideas.length === 0) return [];

  /* Embed sequentially — параллелим на уровне chapter'ов, не идей. */
  const clusters: { centroid: number[]; vectors: number[][]; sampleEssence: string }[] = [];

  for (const idea of ideas) {
    if (signal?.aborted) throw new Error("uniqueness aborted");
    let vector: number[];
    try {
      vector = await deps.embed(idea.essence);
    } catch (err) {
      console.warn(`[uniqueness] embedPassage failed for idea "${idea.title}":`, err instanceof Error ? err.message : err);
      continue;
    }

    let bestIdx = -1;
    let bestSim = -1;
    for (let i = 0; i < clusters.length; i++) {
      const s = cosine(vector, clusters[i].centroid);
      if (s > bestSim) {
        bestSim = s;
        bestIdx = i;
      }
    }

    if (bestIdx >= 0 && bestSim >= mergeThreshold) {
      clusters[bestIdx].vectors.push(vector);
      clusters[bestIdx].centroid = l2Normalize(meanVector(clusters[bestIdx].vectors));
    } else {
      /* Новый кластер: один вектор, центроид = сам вектор (уже нормализован). */
      clusters.push({
        centroid: Array.from(vector),
        vectors: [vector],
        sampleEssence: idea.essence,
      });
    }
  }

  return clusters.map((c) => ({
    centroid: c.centroid,
    count: c.vectors.length,
    sampleEssence: c.sampleEssence,
  }));
}

/* ─── Phase 3 — LLM judge для серой зоны ─────────────────────────── */

const JUDGE_SYSTEM_PROMPT = `You are a research librarian deciding if a new idea duplicates one already in our knowledge base.

Output strictly this JSON (no markdown fences, no <think> blocks):
{"verdict": "SAME" | "DIFFERENT"}

Rules:
  - "SAME" if the new idea expresses essentially the same claim as ANY of the existing items (paraphrase, restatement, generalization that adds no new information).
  - "DIFFERENT" if the new idea makes a distinct claim, even if related to the same topic.
  - When in doubt, prefer DIFFERENT (we want to keep distinct knowledge).`;

interface RawVerdict {
  verdict?: unknown;
}

/**
 * Решить: новая идея == одна из соседей? Используется в серой зоне
 * cosine ∈ [low, high]. Возвращает SAME или DIFFERENT. На parse error /
 * abort — DIFFERENT (предпочитаем потерять precision, чем терять кандидатов).
 */
export async function judgeIdeaSameness(
  idea: BookIdea,
  neighbors: VectorNearestNeighbor[],
  modelKey: string,
  signal?: AbortSignal,
): Promise<"SAME" | "DIFFERENT"> {
  if (neighbors.length === 0) return "DIFFERENT";

  const neighborsBlock = neighbors
    .slice(0, 3)
    .map((n, i) => `[${i + 1}] ${n.document}`)
    .join("\n");
  const userMessage =
    `New idea:\n${idea.essence}\n\nExisting items:\n${neighborsBlock}\n\nIs the new idea SAME or DIFFERENT?`;

  let raw: string;
  try {
    raw = await deps.callLlm(modelKey, JUDGE_SYSTEM_PROMPT, userMessage, signal);
  } catch (err) {
    console.warn(`[uniqueness] judgeIdeaSameness LLM failed:`, err instanceof Error ? err.message : err);
    return "DIFFERENT";
  }

  const stripped = stripProseReasoning(raw);
  const parsed = parseReasoningResponse<RawVerdict>(stripped || raw);
  const verdict = typeof parsed.json?.verdict === "string" ? parsed.json.verdict.toUpperCase().trim() : "";
  const result: "SAME" | "DIFFERENT" = verdict === "SAME" ? "SAME" : "DIFFERENT";

  /* Debug log для тюнинга порогов: какие идеи серой зоны и как разрешились. */
  logModelAction("UNIQUENESS-JUDGE", {
    modelKey,
    role: "uniqueness-judge",
    reason: result,
    meta: {
      idea: idea.essence.slice(0, 200),
      topNeighbor: neighbors[0]?.document.slice(0, 200) ?? "",
      topSimilarity: neighbors[0]?.similarity ?? 0,
    },
  });

  return result;
}

/* ─── Phase 4 — orchestrator + score ──────────────────────────────── */

async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const workers: Promise<void>[] = [];
  const lanes = Math.max(1, Math.min(concurrency, items.length));
  for (let lane = 0; lane < lanes; lane++) {
    workers.push((async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        results[i] = await worker(items[i]);
      }
    })());
  }
  await Promise.all(workers);
  return results;
}

/**
 * Полный пайплайн uniqueness для одной книги. Никогда не throw'ает:
 * при любом сбое возвращает `{score: undefined, error}`.
 */
export async function evaluateBookUniqueness(
  chapters: ConvertedChapter[],
  opts: EvaluateBookUniquenessOptions,
): Promise<UniquenessResult> {
  try {
    if (chapters.length === 0) {
      return { score: undefined, novelCount: 0, totalIdeas: 0, error: "no chapters" };
    }

    /* Phase 1 — extract ideas из всех глав параллельно. */
    const perChapter = await runWithConcurrency(
      chapters,
      opts.chapterParallel,
      (chapter) => extractIdeasPerChapter(chapter, opts.modelKey, opts.ideasPerChapterMax, opts.signal),
    );
    const ideas: BookIdea[] = perChapter.flat();
    if (ideas.length === 0) {
      return { score: undefined, novelCount: 0, totalIdeas: 0, error: "no ideas extracted" };
    }
    if (opts.signal?.aborted) throw new Error("uniqueness aborted");

    /* Phase 2 — within-book dedup. */
    const clusters = await dedupeIdeasWithinBook(ideas, opts.mergeThreshold, opts.signal);
    if (clusters.length === 0) {
      return { score: undefined, novelCount: 0, totalIdeas: 0, error: "no clusters" };
    }
    if (opts.signal?.aborted) throw new Error("uniqueness aborted");

    /* Phase 3 — cross-library novelty per cluster. */
    let novel = 0;
    for (const cluster of clusters) {
      if (opts.signal?.aborted) throw new Error("uniqueness aborted");

      let neighbors: VectorNearestNeighbor[] = [];
      try {
        neighbors = await vectorQueryNearest(opts.targetCollection, cluster.centroid, 3, { signal: opts.signal });
      } catch (err) {
        /* Коллекция отсутствует / vectordb недоступна → трактуем как пустую. */
        const msg = err instanceof Error ? err.message : String(err);
        if (!/does not exist|no records|empty/i.test(msg)) {
          console.warn(`[uniqueness] vectorQueryNearest failed:`, msg);
        }
        neighbors = [];
      }

      if (neighbors.length === 0) {
        novel++;
        continue;
      }
      const top = neighbors[0].similarity;

      if (top < opts.similarityLow) {
        novel++;
        continue;
      }
      if (top > opts.similarityHigh) {
        /* DERIVATIVE — пропускаем без LLM. */
        continue;
      }

      /* Серая зона — спросим LLM. */
      const fakeIdea: BookIdea = { title: "", essence: cluster.sampleEssence, chapterIndex: -1 };
      const verdict = await judgeIdeaSameness(fakeIdea, neighbors, opts.modelKey, opts.signal);
      if (verdict === "DIFFERENT") novel++;
    }

    const total = clusters.length;
    /* Smoothing для маленьких выборок: на total < 3 кластеров score
     * становится экстремальным (0%/50%/100%) и UX-шумит. Возвращаем
     * undefined — UI рендерит «—» вместо «100% unique» для книг где
     * крем сигнал слишком тонок. total=0 (нет кластеров) — то же самое. */
    const MIN_CLUSTERS_FOR_SCORE = 3;
    const score = total < MIN_CLUSTERS_FOR_SCORE
      ? undefined
      : Math.round((100 * novel) / total);
    const error = total === 0
      ? "no clusters"
      : total < MIN_CLUSTERS_FOR_SCORE
        ? `insufficient clusters (${total} < ${MIN_CLUSTERS_FOR_SCORE})`
        : undefined;
    return { score, novelCount: novel, totalIdeas: total, error };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { score: undefined, novelCount: 0, totalIdeas: 0, error: msg };
  }
}
