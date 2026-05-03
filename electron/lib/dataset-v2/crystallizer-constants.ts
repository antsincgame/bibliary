/**
 * Shared constants for the Delta-Knowledge pipeline.
 * Domains are intentionally broad — the LLM picks the best fit.
 *
 * Расположение: рядом с delta-extractor.ts и extraction-runner.ts —
 * чтобы соответствовать domain-colocation (раньше лежал на уровне electron/).
 */

export const ALLOWED_DOMAINS = new Set([
  "ui",
  "web",
  "mobile",
  "ux",
  "perf",
  "arch",
  "copy",
  "seo",
  "research",
  "data",
  "security",
  "devops",
  "ai",
  "business",
  "science",
  "psychology",
  "philosophy",
  "engineering",
  "medicine",
  "economics",
  "other",
]);
