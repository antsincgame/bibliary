// Общие константы доменов и лимитов длины для пайплайна Crystallizer (v2)
// и standalone-валидатора batch-файлов. Единственная разрешённая кодировка
// концептов живёт в defaults/prompts/concept-extractor-mechanicus.md
// (для non-thinking моделей) и concept-extractor-cognitive.md (для thinking).
// Legacy v1 dataset-generator вычищен экстерминатусом — см. docs/AUDIT-2026-04.md.

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
]);

export const PRINCIPLE_MIN = 3;
export const PRINCIPLE_MAX = 300;
export const EXPLANATION_MIN = 10;
export const EXPLANATION_MAX = 2000;
