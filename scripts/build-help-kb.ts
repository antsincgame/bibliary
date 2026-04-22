/**
 * scripts/build-help-kb.ts — построить Qdrant collection `bibliary_help`
 * из docs/*.md (Karpathy LLM Wiki Pattern, Phase 4.1).
 *
 * Запуск: npx tsx scripts/build-help-kb.ts
 *
 * Требования: Qdrant запущен на $QDRANT_URL (default http://localhost:6333).
 * Embedding делается локально через @huggingface/transformers (CPU-friendly,
 * ~3-5 секунд на инициализацию + ~80мс на чанк).
 */

import { buildHelpKb } from "../electron/lib/help-kb/index.js";

async function main(): Promise<void> {
  console.log("[help-kb] Building Bibliary help knowledge base...");
  console.log("[help-kb] Source: docs/*.md");
  console.log("[help-kb] Target Qdrant collection: bibliary_help");
  const startedAt = Date.now();

  let lastReportAt = 0;
  const result = await buildHelpKb({
    onProgress: (done, total) => {
      const now = Date.now();
      if (now - lastReportAt > 1500 || done === total) {
        const pct = ((done / total) * 100).toFixed(1);
        console.log(`[help-kb] embed ${done}/${total} (${pct}%)`);
        lastReportAt = now;
      }
    },
  });

  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log("");
  console.log("--- Help KB Build Result ---");
  console.log(`Total chunks:    ${result.totalChunks}`);
  console.log(`Embedded:        ${result.embedded}`);
  console.log(`Upserted:        ${result.upserted}`);
  console.log(`Duration:        ${elapsedSec}s`);
  if (result.warnings.length > 0) {
    console.log(`Warnings (${result.warnings.length}):`);
    for (const w of result.warnings) console.log(`  - ${w}`);
  }
  console.log("");
  console.log("Готово. Агент теперь может отвечать на вопросы про Bibliary через tool search_help.");
}

main().catch((e) => {
  console.error("[help-kb] FAIL:", e instanceof Error ? e.stack : e);
  process.exit(1);
});
