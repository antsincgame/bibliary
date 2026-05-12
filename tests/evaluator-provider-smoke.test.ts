/**
 * Phase 6c core — server-side evaluator поверх LLMProvider abstraction.
 *
 * Тестируем без реального LLM через `providerOverride` (DI). Покрываем:
 *   - happy path: provider возвращает валидный JSON → BookEvaluation
 *   - reasoning отделён от text (Anthropic thinking-style)
 *   - bad JSON → repair retry → восстановление
 *   - repair тоже падает → evaluation: null + accumulated warnings
 *   - schema violation (например tags=[] вместо 8-12) → repair retry
 *   - provider.chat throws → null + warnings, не throw наружу
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

const ENV_SNAPSHOT: Record<string, string | undefined> = {};

before(() => {
  ENV_SNAPSHOT["APPWRITE_ENDPOINT"] = process.env["APPWRITE_ENDPOINT"];
  ENV_SNAPSHOT["APPWRITE_PROJECT_ID"] = process.env["APPWRITE_PROJECT_ID"];
  ENV_SNAPSHOT["APPWRITE_API_KEY"] = process.env["APPWRITE_API_KEY"];
  ENV_SNAPSHOT["BIBLIARY_ENCRYPTION_KEY"] = process.env["BIBLIARY_ENCRYPTION_KEY"];
  process.env["APPWRITE_ENDPOINT"] = "http://localhost/v1";
  process.env["APPWRITE_PROJECT_ID"] = "test-project";
  process.env["APPWRITE_API_KEY"] = "test-key";
  if (!process.env["BIBLIARY_ENCRYPTION_KEY"]) {
    process.env["BIBLIARY_ENCRYPTION_KEY"] = "x".repeat(32);
  }
});

after(() => {
  for (const [k, v] of Object.entries(ENV_SNAPSHOT)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function validEvaluationJson(): string {
  return JSON.stringify({
    title_ru: "Методы конечных элементов",
    author_ru: "Иваненко П.К.",
    title_en: "Finite Element Methods",
    author_en: "Ivanenko P.K.",
    year: 2011,
    domain: "finite element analysis",
    tags: [
      "finite element method",
      "numerical methods",
      "variational calculus",
      "continuum mechanics",
      "convergence analysis",
      "discretization",
      "Ukrainian mathematics",
      "engineering simulation",
    ],
    tags_ru: [
      "метод конечных элементов",
      "численные методы",
      "вариационное исчисление",
      "механика сплошных сред",
      "анализ сходимости",
      "дискретизация",
      "украинская математика",
      "инженерное моделирование",
    ],
    is_fiction_or_water: false,
    conceptual_density: 88,
    originality: 72,
    quality_score: 84,
    verdict_reason:
      "Rigorous Ukrainian monograph on FEM with formal convergence proofs and continuum mechanics applications. Authorship confirmed from colophon.",
  });
}

interface FakeProviderCall {
  systemContainsRepair: boolean;
}

function makeFakeProvider(responder: (call: FakeProviderCall) => { text: string; reasoning?: string }) {
  /** @type {Array<FakeProviderCall>} */
  const calls: FakeProviderCall[] = [];
  return {
    id: "lmstudio" as const,
    isVisionCapable: () => false,
    listAvailable: async () => [],
    chat: async (req: { system?: string }) => {
      const call: FakeProviderCall = {
        systemContainsRepair: (req.system ?? "").includes("You repair book evaluation"),
      };
      calls.push(call);
      const r = responder(call);
      return {
        text: r.text,
        ...(r.reasoning ? { reasoning: r.reasoning } : {}),
      };
    },
    _calls: calls,
  };
}

describe("server-side evaluator (Phase 6c core)", () => {
  it("happy path: provider returns valid JSON → BookEvaluation", async () => {
    const { evaluateBook } = await import("../server/lib/llm/evaluator.ts");
    const provider = makeFakeProvider(() => ({
      text: validEvaluationJson(),
    }));
    const result = await evaluateBook("user-1", "surrogate text here", {
      providerOverride: { provider: provider as never, model: "fake-model" },
    });
    assert.equal(result.evaluation?.quality_score, 84);
    assert.equal(result.evaluation?.is_fiction_or_water, false);
    assert.equal(result.evaluation?.tags.length, 8);
    assert.equal(result.model, "fake-model");
    assert.equal(provider._calls.length, 1, "should not retry on success");
    assert.equal(provider._calls[0]?.systemContainsRepair, false);
  });

  it("reasoning passed through from provider.chat response", async () => {
    const { evaluateBook } = await import("../server/lib/llm/evaluator.ts");
    const provider = makeFakeProvider(() => ({
      text: validEvaluationJson(),
      reasoning: "Step-by-step bibliographic forensics: found year in colophon...",
    }));
    const result = await evaluateBook("user-1", "surrogate", {
      providerOverride: { provider: provider as never, model: "fake-model" },
    });
    assert.ok(result.reasoning?.includes("bibliographic forensics"));
  });

  it("markdown-wrapped JSON: ```json ... ``` stripped successfully", async () => {
    const { evaluateBook } = await import("../server/lib/llm/evaluator.ts");
    const provider = makeFakeProvider(() => ({
      text: "```json\n" + validEvaluationJson() + "\n```",
    }));
    const result = await evaluateBook("user-1", "surrogate", {
      providerOverride: { provider: provider as never, model: "fake-model" },
    });
    assert.ok(result.evaluation, "should parse stripped JSON");
  });

  it("bad JSON → repair retry → recovery", async () => {
    const { evaluateBook } = await import("../server/lib/llm/evaluator.ts");
    const provider = makeFakeProvider((call) => {
      if (!call.systemContainsRepair) {
        return { text: "{ this is not: valid json " };
      }
      return { text: validEvaluationJson() };
    });
    const result = await evaluateBook("user-1", "surrogate", {
      providerOverride: { provider: provider as never, model: "fake-model" },
    });
    assert.ok(result.evaluation, "repair retry should recover");
    assert.equal(provider._calls.length, 2);
    assert.equal(provider._calls[1]?.systemContainsRepair, true);
    assert.ok(result.warnings.some((w) => w.includes("attempting JSON repair retry")));
  });

  it("repair also fails → evaluation: null + warnings", async () => {
    const { evaluateBook } = await import("../server/lib/llm/evaluator.ts");
    const provider = makeFakeProvider(() => ({ text: "garbage{[" }));
    const result = await evaluateBook("user-1", "surrogate", {
      providerOverride: { provider: provider as never, model: "fake-model" },
    });
    assert.equal(result.evaluation, null);
    assert.equal(provider._calls.length, 2, "should attempt repair once");
    assert.ok(result.warnings.some((w) => w.includes("repair retry also failed")));
  });

  it("schema violation (tags too few) → repair retry", async () => {
    const { evaluateBook } = await import("../server/lib/llm/evaluator.ts");
    const responses = [
      /* First attempt: only 3 tags. Schema requires 8-12 → repair triggered. */
      JSON.stringify({
        title_ru: "Тест",
        author_ru: "Автор",
        title_en: "Test",
        author_en: "Author",
        year: 2020,
        domain: "testing",
        tags: ["a", "b", "c"],
        tags_ru: ["а", "б", "в"],
        is_fiction_or_water: false,
        conceptual_density: 50,
        originality: 50,
        quality_score: 50,
        verdict_reason: "A reasonable test verdict reason with more than thirty characters of content.",
      }),
      /* Repair attempt: valid. */
      validEvaluationJson(),
    ];
    let idx = 0;
    const provider = makeFakeProvider(() => ({ text: responses[idx++] ?? "" }));
    const result = await evaluateBook("user-1", "surrogate", {
      providerOverride: { provider: provider as never, model: "fake-model" },
    });
    assert.ok(result.evaluation, "repair should recover schema-mismatched output");
    assert.equal(provider._calls.length, 2);
    assert.ok(result.warnings.some((w) => w.includes("schema mismatch")));
  });

  it("provider.chat throws → null result + warning, no throw out", async () => {
    const { evaluateBook } = await import("../server/lib/llm/evaluator.ts");
    const provider = {
      id: "lmstudio" as const,
      isVisionCapable: () => false,
      listAvailable: async () => [],
      chat: async () => {
        throw new Error("network exploded");
      },
    };
    const result = await evaluateBook("user-1", "surrogate", {
      providerOverride: { provider: provider as never, model: "fake-model" },
    });
    assert.equal(result.evaluation, null);
    assert.equal(result.raw, "");
    assert.ok(result.warnings.some((w) => w.includes("network exploded")));
  });
});
