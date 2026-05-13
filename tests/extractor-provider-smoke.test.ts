/**
 * Phase 6d core — server-side delta-knowledge extractor (crystallizer)
 * поверх LLMProvider abstraction.
 *
 * Покрываем:
 *   - happy path: valid DeltaKnowledge JSON → parsed delta
 *   - explicit null → rejectReason="filler"
 *   - bad JSON → repair retry → recovery
 *   - copula predicate refine: {predicate:"is"} → schema_failed even
 *     если остальное valid
 *   - extractChapter ledger: 2nd chunk видит ledEssence из 1-го
 *   - per-chunk failure isolated в chapter pipeline
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

function validDelta(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    domain: "engineering",
    chapterContext: "Discussion of finite-element discretization error bounds.",
    essence:
      "Mesh refinement reduces FEM approximation error quadratically when basis functions are linear and the mesh is uniform.",
    cipher: "FEM_error = O(h^2) under uniform linear mesh",
    proof:
      "Error analysis derives ||u - u_h|| ≤ C h^2 ||u''|| for linear FEM on uniform meshes (Brenner-Scott Ch.2).",
    applicability:
      "Use as a baseline expectation; nonuniform mesh or higher-order basis change the exponent.",
    auraFlags: ["specialization", "causality"],
    tags: ["fem", "convergence", "numerical-methods"],
    relations: [
      { subject: "FEM_error", predicate: "decreases_as", object: "O(h^2)" },
      { subject: "uniform_mesh", predicate: "enables", object: "quadratic_convergence" },
    ],
    ...overrides,
  };
}

interface FakeCall {
  isRepair: boolean;
}

function makeFakeProvider(responder: (call: FakeCall, idx: number) => { text: string; reasoning?: string }) {
  const calls: FakeCall[] = [];
  return {
    id: "lmstudio" as const,
    isVisionCapable: () => false,
    listAvailable: async () => [],
    chat: async (req: { system?: string }) => {
      const isRepair = (req.system ?? "").includes("You repair delta-knowledge");
      const call: FakeCall = { isRepair };
      calls.push(call);
      const r = responder(call, calls.length - 1);
      return { text: r.text, ...(r.reasoning ? { reasoning: r.reasoning } : {}) };
    },
    _calls: calls,
  };
}

const sampleChunk = { partN: 1, text: "Sample chunk text describing FEM discretization..." };
const sampleCtx = { chapterThesis: "Numerical methods for PDEs: error analysis." };

describe("server-side extractor (Phase 6d core)", () => {
  it("happy path: valid delta JSON → DeltaKnowledge", async () => {
    const { extractDeltaForChunk } = await import("../server/lib/llm/extractor.ts");
    const provider = makeFakeProvider(() => ({ text: JSON.stringify(validDelta()) }));
    const result = await extractDeltaForChunk("u-1", sampleChunk, sampleCtx, {
      providerOverride: { provider: provider as never, model: "fake-model" },
    });
    assert.ok(result.delta);
    assert.equal(result.delta.domain, "engineering");
    assert.equal(result.delta.relations.length, 2);
    assert.equal(provider._calls.length, 1, "no retry on success");
  });

  it("explicit null response → rejectReason='filler'", async () => {
    const { extractDeltaForChunk } = await import("../server/lib/llm/extractor.ts");
    const provider = makeFakeProvider(() => ({ text: "null" }));
    const result = await extractDeltaForChunk("u-1", sampleChunk, sampleCtx, {
      providerOverride: { provider: provider as never, model: "fake-model" },
    });
    assert.equal(result.delta, null);
    assert.equal(result.rejectReason, "filler");
    assert.equal(provider._calls.length, 1, "no retry on explicit null");
  });

  it("bad JSON → repair retry → recovery", async () => {
    const { extractDeltaForChunk } = await import("../server/lib/llm/extractor.ts");
    const provider = makeFakeProvider((call) => {
      if (!call.isRepair) return { text: "{ this is not valid json " };
      return { text: JSON.stringify(validDelta()) };
    });
    const result = await extractDeltaForChunk("u-1", sampleChunk, sampleCtx, {
      providerOverride: { provider: provider as never, model: "fake-model" },
    });
    assert.ok(result.delta);
    assert.equal(provider._calls.length, 2);
    assert.equal(provider._calls[1]?.isRepair, true);
  });

  it("copula predicate refine: predicate='is' → schema_failed (after repair fail)", async () => {
    const { extractDeltaForChunk } = await import("../server/lib/llm/extractor.ts");
    const badDelta = validDelta({
      relations: [{ subject: "Apollo", predicate: "is", object: "mission" }],
    });
    const provider = makeFakeProvider(() => ({ text: JSON.stringify(badDelta) }));
    const result = await extractDeltaForChunk("u-1", sampleChunk, sampleCtx, {
      providerOverride: { provider: provider as never, model: "fake-model" },
    });
    assert.equal(result.delta, null);
    assert.equal(result.rejectReason, "schema_failed");
    assert.ok(result.warnings.some((w) => w.includes("predicate must be concrete")));
  });

  it("provider.chat throws → rejectReason='provider_error'", async () => {
    const { extractDeltaForChunk } = await import("../server/lib/llm/extractor.ts");
    const provider = {
      id: "lmstudio" as const,
      isVisionCapable: () => false,
      listAvailable: async () => [],
      chat: async () => {
        throw new Error("network exploded");
      },
    };
    const result = await extractDeltaForChunk("u-1", sampleChunk, sampleCtx, {
      providerOverride: { provider: provider as never, model: "fake-model" },
    });
    assert.equal(result.delta, null);
    assert.equal(result.rejectReason, "provider_error");
    assert.ok(result.warnings.some((w) => w.includes("network exploded")));
  });

  it("extractChapter: ledger карmит каждый последующий chunk", async () => {
    const { extractChapter } = await import("../server/lib/llm/extractor.ts");
    /* Записываем passed-ledger в response чтобы проверить что 2-й chunk
     * видит essence от 1-го. */
    const seenLedgers: string[] = [];
    const provider = {
      id: "lmstudio" as const,
      isVisionCapable: () => false,
      listAvailable: async () => [],
      chat: async (req: { messages: Array<{ content?: string }> }) => {
        const userMsg = req.messages[0]?.content ?? "";
        seenLedgers.push(userMsg);
        return {
          text: JSON.stringify(
            validDelta({
              essence:
                "Chunk-specific insight about discretization with sufficient length to pass schema validation here please.",
            }),
          ),
        };
      },
    };
    const chapter = {
      chapterThesis: "FEM convergence analysis.",
      chunks: [
        { partN: 1, text: "First chunk content." },
        { partN: 2, text: "Second chunk content." },
        { partN: 3, text: "Third chunk content." },
      ],
    };
    const result = await extractChapter("u-1", chapter, {
      providerOverride: { provider: provider as never, model: "fake-model" },
    });
    assert.equal(result.stats.total, 3);
    assert.equal(result.stats.extracted, 3);
    assert.equal(result.accepted.length, 3);

    /* 1-й chunk не должен видеть ledger (пустой). */
    assert.ok(!seenLedgers[0]?.includes("Prior essences"));
    /* 2-й и 3-й — должны. */
    assert.ok(seenLedgers[1]?.includes("Prior essences"));
    assert.ok(seenLedgers[2]?.includes("Prior essences"));
  });

  it("extractChapter: per-chunk failure isolated, не блокирует rest", async () => {
    const { extractChapter } = await import("../server/lib/llm/extractor.ts");
    let callIdx = 0;
    const provider = makeFakeProvider(() => {
      const i = callIdx++;
      /* Чанк 0: valid. Чанк 1 (две попытки: original + repair): обе ломаются.
       * Чанк 2: explicit null. */
      if (i === 0) return { text: JSON.stringify(validDelta()) };
      if (i === 1 || i === 2) return { text: "broken response without JSON" };
      return { text: "null" };
    });
    const chapter = {
      chapterThesis: "Mixed chunk types.",
      chunks: [
        { partN: 1, text: "Insightful chunk." },
        { partN: 2, text: "Broken chunk." },
        { partN: 3, text: "Filler chunk." },
      ],
    };
    const result = await extractChapter("u-1", chapter, {
      providerOverride: { provider: provider as never, model: "fake-model" },
    });
    assert.equal(result.stats.total, 3);
    assert.equal(result.stats.extracted, 1);
    assert.equal(result.stats.failed, 1);
    assert.equal(result.stats.filler, 1);
  });
});
