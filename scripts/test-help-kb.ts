/**
 * scripts/test-help-kb.ts — unit-тесты для chunker.ts (без сети, без Qdrant).
 *
 * Запуск: npx tsx scripts/test-help-kb.ts
 */

import { chunkMarkdown } from "../electron/lib/help-kb/chunker.js";

let passed = 0;
let failed = 0;

function step(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed += 1;
  } catch (e) {
    console.log(`  FAIL  ${name}`);
    console.log(`        ${e instanceof Error ? e.message : String(e)}`);
    failed += 1;
  }
}

function assertEq<T>(actual: T, expected: T, label: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label}: expected ${e}, got ${a}`);
}

function assert(cond: boolean, label: string): void {
  if (!cond) throw new Error(label);
}

const SAMPLE_MD = `# Fine-tuning

Self-hosted only — никаких облаков.

## Pre-flight check

WSL должен быть установлен. Проверь \`wsl --status\`.

### CUDA setup

Нужен NVIDIA driver 535+.

## Параметры обучения

LoRA rank: 16, alpha: 32 — стандарт для Qwen3.

# Roadmap

Phase 5 — multi-modal книги.
`;

step("chunkMarkdown создаёт чанки по заголовкам", () => {
  const chunks = chunkMarkdown(SAMPLE_MD, "FINE-TUNING");
  assert(chunks.length >= 4, `expected ≥4 chunks, got ${chunks.length}`);
});

step("первый H1 становится docTitle", () => {
  const chunks = chunkMarkdown(SAMPLE_MD, "FINE-TUNING");
  assertEq(chunks[0].docTitle, "Fine-tuning", "docTitle");
});

step("headingPath корректно строится для H3 под H2", () => {
  const chunks = chunkMarkdown(SAMPLE_MD, "FINE-TUNING");
  const cuda = chunks.find((c) => c.headingPath.includes("CUDA setup"));
  assert(cuda !== undefined, "CUDA chunk not found");
  assertEq(cuda!.headingPath, ["Fine-tuning", "Pre-flight check", "CUDA setup"], "headingPath");
});

step("второй H1 сбрасывает path до 1 уровня", () => {
  const chunks = chunkMarkdown(SAMPLE_MD, "FINE-TUNING");
  const roadmap = chunks.find((c) => c.headingPath[0] === "Roadmap");
  assert(roadmap !== undefined, "Roadmap chunk not found");
  assertEq(roadmap!.headingPath, ["Roadmap"], "second H1 path");
});

step("seed уникален для каждого чанка", () => {
  const chunks = chunkMarkdown(SAMPLE_MD, "FINE-TUNING");
  const seeds = new Set(chunks.map((c) => c.seed));
  assertEq(seeds.size, chunks.length, "unique seeds");
});

step("код-блоки не парсятся как заголовки", () => {
  const md = "# Title\n\nLead paragraph.\n\n```bash\n# This is a comment in shell\nls -la\n```\n\n## Real heading\n\nReal section body.";
  const chunks = chunkMarkdown(md, "test");
  const realHeading = chunks.find((c) => c.headingPath.includes("Real heading"));
  assert(realHeading !== undefined, "Real heading not found");
  /* "# This is a comment" внутри ``` не должно создать новый chunk на корневом уровне */
  const fakeHeading = chunks.find((c) => c.headingPath.includes("This is a comment in shell"));
  assertEq(fakeHeading, undefined, "fake heading from code block");
});

step("очень длинный section разбивается по \\n\\n", () => {
  const longPara = "Lorem ipsum dolor sit amet. ".repeat(80); // ~2240 chars
  const md = `# Big\n\n${longPara}\n\n${longPara}\n\n${longPara}`;
  const chunks = chunkMarkdown(md, "big");
  assert(chunks.length > 1, `expected multiple chunks for long section, got ${chunks.length}`);
  for (const c of chunks) {
    assert(c.charCount <= 2200, `chunk too big: ${c.charCount}`);
  }
});

step("маленькие чанки одного раздела склеиваются, разные подразделы — нет", () => {
  /* Один раздел с 3 короткими параграфами — склеить в 1.
     Три разных подраздела — оставить как есть (attribution важнее). */
  const sameSection = `# A\n\nshort1\n\nshort2\n\nshort3`;
  const sameSectionChunks = chunkMarkdown(sameSection, "ss");
  assertEq(sameSectionChunks.length, 1, "same-section merge");

  const diffSections = `# A\n\nshort1\n\n## B\n\nshort2\n\n## C\n\nshort3`;
  const diffChunks = chunkMarkdown(diffSections, "ds");
  assert(diffChunks.length >= 3, `different sections must NOT merge, got ${diffChunks.length}`);
});

console.log("\n--- Summary ---");
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
