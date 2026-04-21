// Общие константы доменов и лимитов длины для пайплайна Crystallizer (v2)
// и валидатора legacy v1 (validate-line). Старая константа MECHANICUS_SYSTEM_PROMPT
// удалена в рамках Inquisitor-зачистки конкурирующих кодировок: единственная
// разрешённая кодировка теперь живёт в defaults/prompts/concept-extractor-mechanicus.md
// (для non-thinking моделей) и concept-extractor-cognitive.md (для thinking).
// Legacy v1 dataset-generator держит свою кодировку inline (изолировано).

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
