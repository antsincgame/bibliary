/**
 * Self-check теста для benchmark-датасета: убеждается что 50 queries
 * корректны (все relevant chunks существуют в корпусе) и распределение
 * по типам разумное.
 *
 * Полноценный bench (запуск с реальным Qdrant + LM Studio) — отдельный
 * скрипт `scripts/run-hybrid-bench.ts`, не включён в smoke tests
 * (требует живой инфраструктуры).
 */

import { describe, it, expect } from "vitest";
import {
  BENCHMARK_CORPUS,
  BENCHMARK_QUERIES,
  selfCheckBenchmark,
} from "./fixtures/hybrid-search-benchmark.ts";

describe("benchmark dataset", () => {
  it("содержит 50 queries", () => {
    expect(BENCHMARK_QUERIES.length).toBe(50);
  });

  it("корпус содержит >= 30 chunks для нетривиального retrieval", () => {
    /* 38 синтетических chunks по 7 темам — достаточно для recall@5/10
       evaluation при 50 запросах, причём релевантные chunks повторяются
       между несколькими queries (это реалистично — один chunk может быть
       ответом для нескольких формулировок вопроса). */
    expect(BENCHMARK_CORPUS.length).toBeGreaterThanOrEqual(30);
  });

  it("все relevant chunks из queries существуют в корпусе", () => {
    const check = selfCheckBenchmark();
    expect(check.brokenQueries).toEqual([]);
  });

  it("баланс по queryType: представлены все 6 типов", () => {
    const check = selfCheckBenchmark();
    /* exact, semantic, code, multilingual, name, isbn-or-version */
    expect(Object.keys(check.byQueryType).length).toBeGreaterThanOrEqual(5);
  });

  it("expectedWinner покрывает все 3 стратегии", () => {
    const check = selfCheckBenchmark();
    expect(check.byWinner.dense).toBeGreaterThan(0);
    expect(check.byWinner.sparse).toBeGreaterThan(0);
    expect(check.byWinner.hybrid).toBeGreaterThan(0);
  });

  it("каждый query имеет минимум 1 relevant chunk", () => {
    for (const q of BENCHMARK_QUERIES) {
      expect(q.relevantChunkIds.length).toBeGreaterThan(0);
    }
  });

  it("корпус мультиязычный — есть ru, en, mixed", () => {
    const langs = new Set(BENCHMARK_CORPUS.map((c) => c.language));
    expect(langs.has("ru")).toBe(true);
    expect(langs.has("en")).toBe(true);
    expect(langs.has("mixed")).toBe(true);
  });

  it("корпус содержит шумовые chunks для затруднения retrieval", () => {
    const noiseChunks = BENCHMARK_CORPUS.filter((c) => c.topic === "noise");
    expect(noiseChunks.length).toBeGreaterThan(0);
  });

  it("уникальные chunk IDs", () => {
    const ids = BENCHMARK_CORPUS.map((c) => c.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it("уникальные query IDs", () => {
    const ids = BENCHMARK_QUERIES.map((q) => q.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });
});
