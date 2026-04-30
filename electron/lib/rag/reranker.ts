/**
 * Cross-encoder reranker — BGE-reranker-large via Transformers.js (ONNX).
 *
 * Зачем:
 *   Bi-encoder (E5) кодирует query и chunk НЕЗАВИСИМО, потом cosine. Быстро,
 *   но не видит взаимодействия слов. Cross-encoder получает (query, chunk)
 *   как ПАРУ и предсказывает релевантность напрямую — на 20-30% точнее на
 *   технических запросах с редкими токенами (RFC 7235, ISBN, qsort vs mergesort).
 *
 * Стратегия retrieval с rerank (best practice 2026):
 *   1. Vector search top-N кандидатов (over-fetch, обычно N = topK × 4).
 *   2. Cross-encoder скорит каждую пару (query, candidate).
 *   3. Возвращаем topK с новым рейтингом.
 *
 * Модель: `Xenova/bge-reranker-large` (~280 MB ONNX).
 *   - Multilingual (XLM-RoBERTa base) — отлично работает на ru/en/uk корпусе Bibliary.
 *   - Apache 2.0 license — можно паковать в portable build.
 *   - Output: logit (большее = более релевантно). Применяем sigmoid для score 0..1.
 *
 * Cold start: ~5-15 сек на первый вызов (download + ONNX init).
 * Per-pair latency: ~30-60 ms на CPU. Для top-50 candidates ≈ 2-3 сек total.
 *
 * Реализация: отдельный worker thread (`reranker-worker.ts`). В первом
 * варианте BGE грузился в main thread и реальный bench показал зависания
 * cold-start >4 минут. Promise-timeout не спасает, если ONNX/WASM блокирует
 * event loop. Worker можно terminate() по timeout, не подвешивая приложение.
 *
 * Graceful degradation:
 *   Если модель не загрузилась (нет интернета, OOM, поломанный кэш) —
 *   функция бросает, caller (rag/index.ts) возвращает результат **без**
 *   rerank. Поиск не ломается из-за reranker'а.
 */

import { Worker } from "worker_threads";
import { randomUUID } from "crypto";
import * as path from "path";
import { existsSync } from "fs";

const RERANKER_MODEL = "Xenova/bge-reranker-large";

const RERANK_WORKER_TIMEOUT_MS = 180_000; /* includes cold-start + tokenize + inference */

export interface RerankCandidate {
  /** Текст для скоринга. Обычно chunk.payload.text. */
  text: string;
  /** Любые данные caller'а — score не трогает их. */
  meta?: unknown;
}

export interface RerankResult<T extends RerankCandidate> {
  candidate: T;
  /** Cross-encoder logit (raw, до sigmoid). Большее = более релевантно. */
  rerankScore: number;
  /** Новая позиция (0-based), после сортировки по rerankScore desc. */
  rank: number;
  /** Старая позиция до rerank — позволяет видеть «насколько reranker подвинул». */
  originalRank: number;
}

let worker: Worker | null = null;
let disabledUntil = 0;
const CIRCUIT_BREAKER_MS = 5 * 60 * 1000;

let invokeForTests: ((query: string, passages: string[]) => Promise<number[]>) | null = null;

function getWorker(): Worker {
  if (worker) return worker;
  const jsWorker = path.join(__dirname, "reranker-worker.js");
  const tsWorker = path.join(__dirname, "reranker-worker.ts");
  if (existsSync(jsWorker)) {
    worker = new Worker(jsWorker, { workerData: { baseDir: __dirname } });
  } else {
    /* Dev / tsx scripts: dist file is not compiled yet. Run TS worker through
       the same tsx loader. Packaged Electron uses jsWorker branch above. */
    worker = new Worker(tsWorker, { execArgv: ["--import", "tsx"], workerData: { baseDir: __dirname } });
  }
  worker.on("exit", () => {
    worker = null;
  });
  return worker;
}

async function terminateWorker(): Promise<void> {
  const w = worker;
  worker = null;
  if (w) await w.terminate().catch(() => undefined);
}

function invokeWorker(query: string, passages: string[]): Promise<number[]> {
  if (invokeForTests) return invokeForTests(query, passages);
  const w = getWorker();
  const id = randomUUID();
  return new Promise<number[]>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      void terminateWorker();
      reject(new Error(`[reranker] worker timed out after ${RERANK_WORKER_TIMEOUT_MS}ms`));
    }, RERANK_WORKER_TIMEOUT_MS);
    const onMessage = (msg: { id?: string; ok?: boolean; logits?: number[]; error?: string }) => {
      if (msg.id !== id) return;
      cleanup();
      if (msg.ok && Array.isArray(msg.logits)) resolve(msg.logits);
      else {
        void terminateWorker();
        reject(new Error(msg.error ?? "[reranker] worker failed"));
      }
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const cleanup = () => {
      clearTimeout(timer);
      w.off("message", onMessage);
      w.off("error", onError);
    };
    w.on("message", onMessage);
    w.on("error", onError);
    w.postMessage({ id, query, passages });
  });
}

/**
 * Перенумеровать список кандидатов по relevance к query через cross-encoder.
 *
 * Возвращает НОВЫЙ массив того же размера что и `candidates`,
 * отсортированный по убыванию rerankScore. Каждый элемент содержит
 * исходный candidate + новый rank + старый rank.
 *
 * Если `topK` задан — возвращаем только top-K. Иначе все candidates.
 *
 * Контракт ошибок: бросает если модель не загрузилась или inference упал.
 * Caller должен ловить и продолжать с не-rerank результатами (graceful
 * degradation в rag/index.ts).
 */
export async function rerankPassages<T extends RerankCandidate>(
  query: string,
  candidates: T[],
  topK?: number,
): Promise<RerankResult<T>[]> {
  if (!query || candidates.length === 0) return [];
  if (candidates.length === 1) {
    /* Один кандидат — rerank не нужен, экономим cold-start если модель
       ещё не загружена. */
    return [{ candidate: candidates[0]!, rerankScore: 0, rank: 0, originalRank: 0 }];
  }
  if (Date.now() < disabledUntil) {
    throw new Error(`[reranker] circuit breaker active until ${new Date(disabledUntil).toISOString()}`);
  }

  const passages = candidates.map((c) => c.text);

  let logitsData: number[];
  try {
    logitsData = await invokeWorker(query, passages);
  } catch (e) {
    disabledUntil = Date.now() + CIRCUIT_BREAKER_MS;
    throw e;
  }

  /* logits — это [batch_size, num_classes]. Для cross-encoder reranker
     обычно num_classes=1, поэтому logits.data — это просто массив скоров
     длины batch_size. Если num_classes>1 (BGE может выдать [neg, pos]),
     берём последний (positive class). */
  const numClasses = logitsData.length / candidates.length;
  if (!Number.isInteger(numClasses) || numClasses < 1) {
    throw new Error(
      `[reranker] logits shape mismatch: ${logitsData.length} values for ${candidates.length} candidates`,
    );
  }

  const annotated = candidates.map((c, i) => {
    /* numClasses=1 → logitsData[i]. Иначе — последний класс ([neg, pos]). */
    const start = i * numClasses;
    const score = logitsData[start + numClasses - 1] ?? 0;
    return { candidate: c, rerankScore: score, originalRank: i };
  });

  annotated.sort((a, b) => b.rerankScore - a.rerankScore);

  const sliced = typeof topK === "number" && topK > 0 ? annotated.slice(0, topK) : annotated;
  return sliced.map((a, rank) => ({
    candidate: a.candidate,
    rerankScore: a.rerankScore,
    rank,
    originalRank: a.originalRank,
  }));
}

/** Сбросить кэш модели — нужен только в тестах. */
export function _resetRerankerCache(): void {
  void terminateWorker();
  disabledUntil = 0;
}

/** Имя активной модели — для логов и UI. */
export function getRerankerModelName(): string {
  return RERANKER_MODEL;
}

/** Информация для UI: загружена ли модель в память. */
export function isRerankerWarm(): boolean {
  return worker !== null && Date.now() >= disabledUntil;
}

/** Test-only injection. Production never calls this. */
export function _setRerankerInvokerForTests(fn: ((query: string, passages: string[]) => Promise<number[]>) | null): void {
  invokeForTests = fn;
}
