/**
 * dataset-synth — CLI-обёртка над `synthesizeDataset` из основного пайплайна.
 *
 * UI приложения вызывает `synthesizeDataset` напрямую (in-process через
 * `dataset-v2:synthesize` IPC). Этот скрипт нужен только для headless
 * запусков (CI, batch-jobs, ручные эксперименты на серверах без UI).
 *
 * Пример:
 *   npm run dataset:synth -- \
 *     --collection marketing-concepts \
 *     --out release/datasets/marketing \
 *     --pairs-per-concept 2 \
 *     --format sharegpt \
 *     [--model qwen3.6-35b-a3b] [--limit 100]
 *
 * Контракт payload и формат вывода ровно такие же, как у UI: единый модуль
 * `electron/lib/dataset-v2/synthesize.ts`. Выход — train.jsonl + val.jsonl
 * + meta.json + README.md.
 */

import * as path from "path";
import { synthesizeDataset } from "../electron/lib/dataset-v2/synthesize.js";
import { pickEvaluatorModel } from "../electron/lib/library/book-evaluator.js";

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
};

interface Args {
  collection: string;
  out: string;
  pairsPerConcept: number;
  format: "sharegpt" | "chatml";
  model?: string;
  limit?: number;
  trainRatio?: number;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    collection: "delta-knowledge",
    out: "release/datasets/synth",
    pairsPerConcept: 2,
    format: "sharegpt",
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    switch (k) {
      case "--collection":
        a.collection = String(v);
        i++;
        break;
      case "--out":
        a.out = String(v);
        i++;
        break;
      case "--pairs-per-concept":
        a.pairsPerConcept = Math.max(1, Math.min(5, Number(v) || 2));
        i++;
        break;
      case "--format":
        a.format = v === "chatml" ? "chatml" : "sharegpt";
        i++;
        break;
      case "--model":
        a.model = String(v);
        i++;
        break;
      case "--limit":
        a.limit = Math.max(1, Number(v) || 0);
        i++;
        break;
      case "--train-ratio":
        a.trainRatio = Math.max(0.5, Math.min(0.99, Number(v) || 0.9));
        i++;
        break;
      case "--help":
      case "-h":
        a.help = true;
        break;
    }
  }
  return a;
}

function printHelp(): void {
  console.log(`
${C.bold}Bibliary Dataset Synthesis (in-process)${C.reset}

Usage:
  npm run dataset:synth -- --collection <name> --out <dir> [options]

Options:
  --collection <name>          Qdrant collection (default: delta-knowledge)
  --out <dir>                  Output directory (default: release/datasets/synth)
  --pairs-per-concept <1..5>   Q/A pairs per concept (default: 2)
  --format <sharegpt|chatml>   Output format (default: sharegpt)
  --model <modelKey>           LM Studio model (default: pickEvaluatorModel)
  --limit <N>                  Stop after N concepts (default: all)
  --train-ratio <0.5..0.99>    Train/val split (default: 0.9)
  -h, --help                   Show this help
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  let model = args.model;
  if (!model) {
    const picked = await pickEvaluatorModel();
    if (!picked) {
      console.error(
        `${C.red}${C.bold}FATAL:${C.reset} no LLM available; pass --model or load one in LM Studio.`,
      );
      process.exit(3);
    }
    model = picked;
  }

  console.log(`${C.bold}=== Bibliary Dataset Synthesis ===${C.reset}`);
  console.log(`${C.cyan}collection:${C.reset} ${args.collection}`);
  console.log(`${C.cyan}out:${C.reset}        ${path.resolve(args.out)}`);
  console.log(`${C.cyan}format:${C.reset}     ${args.format}`);
  console.log(`${C.cyan}model:${C.reset}      ${model}`);
  console.log(`${C.cyan}pairs:${C.reset}      ${args.pairsPerConcept}`);
  if (args.limit) console.log(`${C.cyan}limit:${C.reset}      ${args.limit}`);
  console.log("");

  const stats = await synthesizeDataset({
    collection: args.collection,
    outputDir: path.resolve(args.out),
    format: args.format,
    pairsPerConcept: args.pairsPerConcept,
    model,
    trainRatio: args.trainRatio,
    limit: args.limit,
    onProgress: (info) => {
      if (info.phase === "generate" && info.conceptsRead % 5 === 0) {
        const tail =
          info.currentEssence?.slice(0, 60) ?? info.currentDomain ?? "";
        process.stdout.write(
          `\r${C.dim}[${info.conceptsRead}]${C.reset} paired=${info.paired} llm-fail=${info.skippedLlmFail} schema-fail=${info.skippedSchemaFail} ${C.dim}${tail}${C.reset}    `,
        );
      }
      if (info.phase === "write") {
        process.stdout.write(`\n${C.cyan}[write]${C.reset} writing JSONL files…\n`);
      }
    },
  });

  const minutes = (stats.durationMs / 60_000).toFixed(1);
  console.log(`\n${C.bold}=== DONE ===${C.reset}`);
  console.log(`Concepts processed   : ${stats.concepts}`);
  console.log(`Training examples    : ${C.green}${stats.totalLines}${C.reset}`);
  console.log(`  train: ${stats.trainLines}`);
  console.log(`  val:   ${stats.valLines}`);
  console.log(`LLM failures         : ${stats.llmFailures > 0 ? C.red : C.dim}${stats.llmFailures}${C.reset}`);
  console.log(`Schema failures      : ${stats.schemaFailures > 0 ? C.yellow : C.dim}${stats.schemaFailures}${C.reset}`);
  console.log(`Empty payloads       : ${C.dim}${stats.emptyPayloadSkips}${C.reset}`);
  console.log(`Elapsed              : ${minutes} min`);
  console.log(`Output               : ${stats.outputDir}`);

  if (Object.keys(stats.byDomain).length > 0) {
    console.log(`\n${C.bold}Examples by domain (top 15):${C.reset}`);
    Object.entries(stats.byDomain)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .forEach(([d, n]) => console.log(`  ${d.padEnd(40)} ${n}`));
  }
}

main().catch((e) => {
  console.error(
    `\n${C.red}${C.bold}FATAL:${C.reset} ${e instanceof Error ? e.message : String(e)}`,
  );
  if (e instanceof Error && e.stack) console.error(e.stack);
  process.exit(1);
});
