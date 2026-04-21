/**
 * Phase 2.5R.1 — Token Economy unit tests.
 * Run: `npx tsx scripts/test-token.ts`
 *
 * Тестирует:
 *  - TokenBudgetManager.estimate, fits, trimFewShot, splitByTokens
 *  - buildMechanicusSchema (сравнивает с дефолтами)
 *  - Overflow guard: register/assertFits/fitOrTrim cycle
 *  - ChunkTooLargeError при невозможности уменьшения
 */
import {
  TokenBudgetManager,
  ChunkTooLargeError,
  buildMechanicusSchema,
  buildMechanicusResponseFormat,
  registerModelContext,
  unregisterModelContext,
  getModelContext,
  assertFits,
  fitOrTrim,
  ContextOverflowError,
  resetOverflowGuard,
} from "../electron/lib/token/index.js";

let passed = 0;
let failed = 0;

async function step(name: string, fn: () => Promise<void>): Promise<void> {
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

async function testBudget(): Promise<void> {
  console.log("\n[token-budget]");
  const budget = new TokenBudgetManager({ modelContext: 2048, safetyMargin: 0.08 });
  await budget.ensureReady();

  await step("estimate is positive integer", async () => {
    const n = budget.estimate("Hello world!");
    assert(Number.isInteger(n) && n > 0, `unexpected: ${n}`);
  });

  await step("budget = floor(context * (1 - margin))", async () => {
    assert(budget.budget() === Math.floor(2048 * 0.92), `got ${budget.budget()}`);
  });

  await step("fits returns true for short messages", async () => {
    const msgs = [
      { role: "system" as const, content: "You are a helpful assistant." },
      { role: "user" as const, content: "Hi" },
    ];
    assert(budget.fits(msgs, 256), "should fit");
  });

  await step("fits returns false for huge messages", async () => {
    const huge = "word ".repeat(5000);
    const msgs = [
      { role: "system" as const, content: "system" },
      { role: "user" as const, content: huge },
    ];
    assert(!budget.fits(msgs, 256), "should not fit");
  });

  await step("trimFewShot drops EXAMPLE blocks", async () => {
    const userText = `Some intro.

FEW-SHOT EXAMPLES:
EXAMPLE 1:
${"alpha beta gamma ".repeat(200)}

EXAMPLE 2:
${"delta epsilon zeta ".repeat(200)}

EXAMPLE 3:
${"eta theta iota ".repeat(200)}

Final task line.`;
    const msgs = [
      { role: "system" as const, content: "system " + "x ".repeat(200) },
      { role: "user" as const, content: userText },
    ];
    const before = budget.estimateMessages(msgs);
    const trimmed = budget.trimFewShot(msgs, 512);
    const after = budget.estimateMessages(trimmed);
    assert(trimmed.length === 2, "should keep 2 messages");
    assert(after < before, `should be shorter: before=${before} after=${after}`);
  });

  await step("splitByTokens splits long text", async () => {
    const text = "lorem ipsum dolor sit amet ".repeat(500);
    const parts = budget.splitByTokens(text, 256, 32);
    assert(parts.length > 1, `expected multiple parts, got ${parts.length}`);
    for (const p of parts) {
      const tokens = budget.estimate(p);
      assert(tokens <= 256 + 8, `part exceeds limit: ${tokens} > 256`);
    }
  });

  await step("splitByTokens throws below min", async () => {
    let threw = false;
    try {
      budget.splitByTokens("text", 16, 0);
    } catch (e) {
      threw = e instanceof ChunkTooLargeError;
    }
    assert(threw, "should throw ChunkTooLargeError");
  });
}

async function testSchema(): Promise<void> {
  console.log("\n[gbnf-mechanicus]");

  await step("buildMechanicusSchema with no grammar uses fallback", async () => {
    const schema = buildMechanicusSchema(null);
    assert(schema.type === "object", "should be object");
    assert(schema.properties.domain.enum.length === 9, `domains: ${schema.properties.domain.enum.length}`);
    assert(schema.required.includes("principle"), "principle required");
  });

  await step("buildMechanicusSchema honors custom domains", async () => {
    const schema = buildMechanicusSchema({
      domains: ["alpha", "beta"],
      operators: {},
      abbreviations: {},
      principle: { minLength: 5, maxLength: 100 },
      explanation: { minLength: 10, maxLength: 500 },
    });
    assert(schema.properties.domain.enum.length === 2, "should have 2 domains");
    assert(schema.properties.principle.minLength === 5, "principle min");
    assert(schema.properties.explanation.maxLength === 500, "explanation max");
  });

  await step("buildMechanicusResponseFormat wraps schema", async () => {
    const fmt = buildMechanicusResponseFormat();
    assert(fmt.type === "json_schema", "type");
    assert(fmt.json_schema.strict === true, "strict");
    assert(fmt.json_schema.schema.required.length === 4, "required count");
  });
}

async function testOverflowGuard(): Promise<void> {
  console.log("\n[overflow-guard]");
  resetOverflowGuard();

  await step("unregistered model: assertFits is noop", async () => {
    await assertFits("nonexistent-model", [{ role: "user", content: "x" }], 100);
  });

  await step("register + getModelContext", async () => {
    registerModelContext("test-model", 2048);
    assert(getModelContext("test-model") === 2048, "context registered");
  });

  await step("assertFits passes for small message", async () => {
    await assertFits("test-model", [{ role: "user", content: "Hi" }], 256);
  });

  await step("assertFits throws for overflow", async () => {
    let threw = false;
    try {
      await assertFits(
        "test-model",
        [{ role: "user", content: "word ".repeat(3000) }],
        256
      );
    } catch (e) {
      threw = e instanceof ContextOverflowError;
    }
    assert(threw, "should throw ContextOverflowError");
  });

  await step("fitOrTrim trims few-shot to fit", async () => {
    registerModelContext("trim-test", 1024);
    const userText = `Question.

FEW-SHOT EXAMPLES:
EXAMPLE 1:
${"alpha bravo charlie ".repeat(150)}

EXAMPLE 2:
${"delta echo foxtrot ".repeat(150)}

Task: do something.`;
    const original = [
      { role: "system" as const, content: "system" },
      { role: "user" as const, content: userText },
    ];
    const result = await fitOrTrim("trim-test", original, 256);
    assert(result.length === 2, "kept 2 messages");
    assert(result[1].content.length < userText.length, `trimmed: orig=${userText.length} got=${result[1].content.length}`);
    unregisterModelContext("trim-test");
  });

  await step("unregister clears context", async () => {
    unregisterModelContext("test-model");
    assert(getModelContext("test-model") === null, "should be null");
  });
}

async function main(): Promise<void> {
  console.log("Phase 2.5R.1 — Token Economy tests");
  await testBudget();
  await testSchema();
  await testOverflowGuard();

  console.log(`\n--- Summary ---\nPassed: ${passed}\nFailed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
