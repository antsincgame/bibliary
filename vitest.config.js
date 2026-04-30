export default {
  test: {
    include: [
      "tests/qdrant-collection-config.test.ts",
      "tests/illustration-semaphore.test.ts",
      "tests/model-pool.test.ts",
    ],
    testTimeout: 30_000,
  },
};
