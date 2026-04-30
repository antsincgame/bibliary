/**
 * BM25 sparse vector encoder — multilingual, zero dependencies.
 *
 * Зачем:
 *   Dense E5 embeddings смазывают редкие токены: ISBN, RFC 7235, "qsort",
 *   имена авторов на латинице в кириллическом тексте, версии (TLS 1.3,
 *   HTTP/2). На таких запросах vector-only retrieval часто промахивается.
 *
 *   BM25 (sparse vectors) ловит точные совпадения токенов. Hybrid search
 *   (dense + sparse, fused через RRF) даёт +30-40% recall на технических
 *   корпусах согласно ArXiv 2026 papers (см. отчёт hybrid-search.ts).
 *
 * Архитектура:
 *   Это **client-side** BM25 vectorizer. Он генерирует {indices, values}
 *   для Qdrant sparse vector — а **IDF** считает сам Qdrant через
 *   `modifier: "idf"` в config sparse_vectors. Поэтому здесь только TF,
 *   без IDF.
 *
 *   - Tokenization: Unicode-aware split по `[^\p{L}\p{N}]+` (любые буквы +
 *     цифры из любого языка). Это работает для ru/en/uk/be/de/fr/...
 *     одновременно, без языко-специфичных стеммеров.
 *   - Hashing: FNV-1a 32-bit → детерминированный index. Никакого vocab,
 *     никакого learning. Совпадение токена в query и passage гарантирует
 *     одинаковый index.
 *   - Document length normalization: НЕ применяем здесь. Qdrant с
 *     `modifier: "idf"` при k1=1.2, b=0.75 (defaults) делает это сам
 *     при сравнении. Мы передаём raw TF.
 *
 * Trade-offs:
 *   + Zero deps, multilingual из коробки, детерминирован.
 *   + Работает без Qdrant Cloud Inference (offline-friendly).
 *   - Hash collisions на 2^32 — для библиотеки <100M уникальных токенов
 *     вероятность коллизии <1%. Приемлемо для retrieval.
 *   - Без стемминга: "файл" и "файлы" — разные токены. На русском это
 *     теряет recall на 5-10%. Если станет проблемой — добавим SnowballStemmer
 *     (отдельный модуль, не блокер для MVP).
 */

import { tokenizeForBM25 as unifiedTokenize } from "../text/tokenize.js";

/**
 * Tokenize текст на ru/en/uk/etc — Unicode-aware. Длина 2..64 символов.
 * Lowercase для case-insensitive matching ("RFC" === "rfc").
 *
 * Tonkij wrapper над unified `electron/lib/text/tokenize.ts:tokenizeForBM25`
 * — основная имплементация теперь в одном месте для всех 3 потребителей
 * (BM25, import-candidate-filter, e2e скрипты). Backward-compat имя
 * `tokenizeForBm25` сохранено для существующих импортов.
 */
export function tokenizeForBm25(text: string): string[] {
  return unifiedTokenize(text);
}

/**
 * FNV-1a 32-bit hash. Детерминирован, быстр, нулевые зависимости.
 * Возвращает unsigned int (0 .. 2^32 - 1).
 *
 * Подходит для Qdrant sparse vector indices: они обязаны быть int (uint32).
 */
export function hashTokenFnv1a(token: string): number {
  let h = 2166136261; /* FNV offset basis */
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    /* Math.imul = 32-bit signed multiplication, обходит JS 53-bit number
       precision. FNV prime = 16777619. */
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Sparse vector в формате Qdrant: parallel arrays {indices, values}.
 * indices — uint32 (FNV-hash токена).
 * values — raw term frequency (Qdrant сам применит IDF при scoring,
 * если коллекция создана с `modifier: "idf"`).
 */
export interface BM25SparseVector {
  indices: number[];
  values: number[];
}

/**
 * Вычислить sparse vector для текста.
 *
 * Дубликаты токенов агрегируются в TF (term frequency). Хеш-коллизии
 * (две разные слова → один index) тоже агрегируются — приемлемо при
 * 2^32 indices.
 *
 * Пустой текст → {indices: [], values: []}. Caller сам решает, отправлять
 * ли пустой вектор в Qdrant или скипнуть.
 */
export function bm25SparseVector(text: string): BM25SparseVector {
  const tokens = tokenizeForBm25(text);
  if (tokens.length === 0) return { indices: [], values: [] };

  const tf = new Map<number, number>();
  for (const tok of tokens) {
    const idx = hashTokenFnv1a(tok);
    tf.set(idx, (tf.get(idx) ?? 0) + 1);
  }

  const indices: number[] = [];
  const values: number[] = [];
  for (const [idx, count] of tf.entries()) {
    indices.push(idx);
    values.push(count);
  }
  return { indices, values };
}

/**
 * То же что `bm25SparseVector`, но для query — обычно короче passage.
 * Алгоритм идентичный (одинаковый hash space → совпадение токенов
 * между query и passage). Отдельная функция оставлена для будущих
 * различий (например query expansion / stop-words).
 */
export function bm25SparseQuery(query: string): BM25SparseVector {
  return bm25SparseVector(query);
}
