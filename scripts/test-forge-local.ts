/**
 * Phase 3.3 — WSL detector + eval-harness + parseMetric tests.
 * Run: `npx tsx scripts/test-forge-local.ts`
 */
import { detectWSL, toWslPath, parseMetric, rougeL, runEval, chatMLToEvalCases } from "../electron/lib/forge/index.js";

let passed = 0;
let failed = 0;

async function step(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (e) {
    console.error(`  FAIL  ${name}: ${e instanceof Error ? e.message : e}`);
    failed++;
  }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

async function main(): Promise<void> {
  console.log("Phase 3.3 — Local launcher + eval tests\n");

  console.log("[wsl]");
  await step("detectWSL не падает", async () => {
    const info = await detectWSL();
    assert(typeof info.installed === "boolean", "installed bool");
    assert(Array.isArray(info.distros), "distros array");
  });
  await step("toWslPath правильно конвертит C:\\foo", () => {
    const out = toWslPath("C:\\Users\\me\\file.py");
    assert(/^\/mnt\/c\/Users\/me\/file\.py$/i.test(out), `got: ${out}`);
  });
  await step("toWslPath не падает на не-Windows пути", () => {
    const out = toWslPath("/usr/bin/python");
    assert(typeof out === "string", "string returned");
  });

  console.log("\n[parseMetric]");
  await step("парсит loss из строки Trainer", () => {
    const line = "{'loss': 1.234, 'grad_norm': 0.567, 'learning_rate': 0.0002, 'epoch': 0.42}";
    const m = parseMetric(line);
    assert(m !== null, "metric parsed");
    assert(m!.loss === 1.234, `loss=1.234, got ${m!.loss}`);
    assert(m!.gradNorm === 0.567, `grad_norm=0.567, got ${m!.gradNorm}`);
  });
  await step("извлекает step из 12/100 prefix", () => {
    const line = "Step 12/100: {'loss': 0.5}";
    const m = parseMetric(line);
    assert(m?.step === 12, `step=12, got ${m?.step}`);
  });
  await step("возвращает null если не метрика", () => {
    assert(parseMetric("just some log line") === null, "non-metric line");
    assert(parseMetric("") === null, "empty line");
  });

  console.log("\n[rougeL]");
  await step("identical strings → f1=1", () => {
    const r = rougeL("hello world", "hello world");
    assert(r.f1 === 1, `f1=1, got ${r.f1}`);
  });
  await step("zero overlap → f1=0", () => {
    const r = rougeL("apple banana", "xyz qrs");
    assert(r.f1 === 0, `f1=0, got ${r.f1}`);
  });
  await step("partial overlap reasonable", () => {
    const r = rougeL("the quick brown fox", "the brown fox jumps");
    assert(r.f1 > 0.5 && r.f1 < 1, `f1 should be 0.5-1, got ${r.f1}`);
  });
  await step("empty input → all zero", () => {
    const r = rougeL("", "anything");
    assert(r.f1 === 0, "f1=0 for empty ref");
  });

  console.log("\n[runEval]");
  await step("runEval с mock chat работает", async () => {
    const cases = [
      { prompt: "what is 2+2?", expected: "4" },
      { prompt: "capital of France?", expected: "paris" },
    ];
    const summary = await runEval({
      cases,
      baseModel: "base",
      tunedModel: "tuned",
      chat: async (modelKey) => (modelKey === "tuned" ? cases[0]!.expected : "wrong"),
    });
    assert(summary.cases.length === 2, "2 cases");
    assert(summary.delta !== undefined, "delta defined");
  });
  await step("runEval с judge возвращает win counts", async () => {
    const cases = [{ prompt: "x", expected: "y" }];
    const summary = await runEval({
      cases,
      baseModel: "base",
      tunedModel: "tuned",
      judgeModel: "judge",
      chat: async (modelKey) => {
        if (modelKey === "judge") return JSON.stringify({ a: 0, b: 2, winner: "b" });
        return modelKey === "tuned" ? "y" : "z";
      },
    });
    assert(summary.judgeWins.tuned === 1, `tuned wins=1, got ${summary.judgeWins.tuned}`);
  });

  console.log("\n[chatMLToEvalCases]");
  await step("извлекает user→assistant пары", () => {
    const lines = [
      {
        messages: [
          { role: "system" as const, content: "S" },
          { role: "user" as const, content: "Q1" },
          { role: "assistant" as const, content: "A1" },
        ],
      },
      {
        messages: [
          { role: "user" as const, content: "Q2" },
          { role: "assistant" as const, content: "A2" },
        ],
      },
    ];
    const cases = chatMLToEvalCases(lines);
    assert(cases.length === 2, `2 cases, got ${cases.length}`);
    assert(cases[0]!.prompt === "Q1", "prompt");
    assert(cases[0]!.expected === "A1", "expected");
    assert(cases[0]!.systemPrompt === "S", "system propagated");
  });
  await step("maxCases ограничивает", () => {
    const lines = Array.from({ length: 100 }, (_, i) => ({
      messages: [
        { role: "user" as const, content: `Q${i}` },
        { role: "assistant" as const, content: `A${i}` },
      ],
    }));
    const cases = chatMLToEvalCases(lines, 5);
    assert(cases.length === 5, `5 cases, got ${cases.length}`);
  });

  console.log("\n--- Summary ---");
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
