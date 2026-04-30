export default {
  test: {
    include: [
      "tests/bm25-sparse.test.ts",
      "tests/qdrant-collection-config.test.ts",
      "tests/rag-reranker.test.ts",
      "tests/illustration-semaphore.test.ts",
      "tests/model-pool.test.ts",
      "tests/hybrid-search-benchmark-self-check.test.ts",
    ],
    testTimeout: 30_000,
  },
};
