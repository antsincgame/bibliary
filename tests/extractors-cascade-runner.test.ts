/**
 * Cascade Runner — Tier 0 → 1 → 2 оркестрация.
 *
 * Тесты используют моки для всех трёх Tier'ов чтобы проверить:
 *   - порядок вызова
 *   - остановку на достижении acceptableQuality
 *   - graceful skip null-результатов
 *   - graceful обработку throw в одном Tier'е (продолжение в следующий)
 *   - disabledTiers фильтрацию
 *   - выбор лучшего из неуспешных попыток
 */

import { describe, it } from "node:test";
import { expect } from "./helpers/expect-shim.ts";
import { runExtractionCascade } from "../electron/lib/scanner/extractors/cascade-runner.js";
import type {
  ExtractionAttempt,
  ExtractOptions,
  TextExtractor,
} from "../electron/lib/scanner/extractors/types.js";

interface CallLog {
  tier0Calls: number;
  tier1Calls: number;
  tier2Calls: number;
}

function makeMockExtractor(
  results: Partial<{
    tier0: ExtractionAttempt | null | "throw";
    tier1: ExtractionAttempt | null | "throw";
    tier2: ExtractionAttempt | null | "throw";
  }>,
  log: CallLog,
): TextExtractor {
  return {
    tryTextLayer: results.tier0 === undefined
      ? undefined
      : async (_src: string, _opts: ExtractOptions) => {
          log.tier0Calls += 1;
          if (results.tier0 === "throw") throw new Error("tier0 boom");
          return results.tier0;
        },
    tryOsOcr: results.tier1 === undefined
      ? undefined
      : async () => {
          log.tier1Calls += 1;
          if (results.tier1 === "throw") throw new Error("tier1 boom");
          return results.tier1;
        },
    tryVisionLlm: results.tier2 === undefined
      ? undefined
      : async () => {
          log.tier2Calls += 1;
          if (results.tier2 === "throw") throw new Error("tier2 boom");
          return results.tier2;
        },
  };
}

describe("Cascade Runner — happy paths", () => {
  it("Tier 0 quality >= threshold → останавливается, Tier 1/2 не вызываются", async () => {
    const log: CallLog = { tier0Calls: 0, tier1Calls: 0, tier2Calls: 0 };
    const ex = makeMockExtractor({
      tier0: { tier: 0, engine: "text-layer", quality: 0.9, text: "good", warnings: [] },
      tier1: { tier: 1, engine: "system-ocr", quality: 0.9, text: "n/a", warnings: [] },
      tier2: { tier: 2, engine: "vision-llm", quality: 0.9, text: "n/a", warnings: [] },
    }, log);

    const result = await runExtractionCascade(ex, "file.djvu");

    expect(result.attempt?.tier).toBe(0);
    expect(result.attempt?.text).toBe("good");
    expect(log.tier0Calls).toBe(1);
    expect(log.tier1Calls).toBe(0);
    expect(log.tier2Calls).toBe(0);
  });

  it("Tier 0 не справился → Tier 1 вызывается; Tier 1 ОК → Tier 2 не вызывается", async () => {
    const log: CallLog = { tier0Calls: 0, tier1Calls: 0, tier2Calls: 0 };
    const ex = makeMockExtractor({
      tier0: { tier: 0, engine: "text-layer", quality: 0.2, text: "noise", warnings: [] },
      tier1: { tier: 1, engine: "system-ocr", quality: 0.7, text: "ocr ok", warnings: [] },
      tier2: { tier: 2, engine: "vision-llm", quality: 0.95, text: "n/a", warnings: [] },
    }, log);

    const result = await runExtractionCascade(ex, "file.djvu");

    expect(result.attempt?.tier).toBe(1);
    expect(result.attempt?.text).toBe("ocr ok");
    expect(log.tier1Calls).toBe(1);
    expect(log.tier2Calls).toBe(0);
  });

  it("Tier 0 и Tier 1 не справились → Tier 2 принимается", async () => {
    const log: CallLog = { tier0Calls: 0, tier1Calls: 0, tier2Calls: 0 };
    const ex = makeMockExtractor({
      tier0: null,
      tier1: { tier: 1, engine: "system-ocr", quality: 0.3, text: "weak", warnings: [] },
      tier2: { tier: 2, engine: "vision-llm", quality: 0.9, text: "vision good", warnings: [] },
    }, log);

    const result = await runExtractionCascade(ex, "file.djvu");

    expect(result.attempt?.tier).toBe(2);
    expect(log.tier2Calls).toBe(1);
  });
});

describe("Cascade Runner — error paths", () => {
  it("Tier бросил исключение → следующий Tier пробуется", async () => {
    const log: CallLog = { tier0Calls: 0, tier1Calls: 0, tier2Calls: 0 };
    const ex = makeMockExtractor({
      tier0: "throw",
      tier1: { tier: 1, engine: "system-ocr", quality: 0.8, text: "saved", warnings: [] },
    }, log);

    const result = await runExtractionCascade(ex, "file.djvu");

    expect(result.attempt?.tier).toBe(1);
    expect(result.attempts.length).toBe(2);
    /* Throw записан в attempts с warnings */
    expect(result.attempts[0]?.warnings[0]).toContain("tier 0");
    expect(result.attempts[0]?.warnings[0]).toContain("boom");
  });

  it("все Tier'ы вернули мусор → выбирает лучшее из имеющегося", async () => {
    const log: CallLog = { tier0Calls: 0, tier1Calls: 0, tier2Calls: 0 };
    const ex = makeMockExtractor({
      tier0: { tier: 0, engine: "text-layer", quality: 0.1, text: "a", warnings: [] },
      tier1: { tier: 1, engine: "system-ocr", quality: 0.4, text: "b", warnings: [] },
      tier2: { tier: 2, engine: "vision-llm", quality: 0.3, text: "c", warnings: [] },
    }, log);

    const result = await runExtractionCascade(ex, "file.djvu");

    /* Лучший — Tier 1 (0.4 quality) */
    expect(result.attempt?.tier).toBe(1);
    expect(result.attempt?.quality).toBe(0.4);
    expect(result.attempts.length).toBe(3);
  });

  it("все Tier'ы вернули null → result.attempt === null", async () => {
    const log: CallLog = { tier0Calls: 0, tier1Calls: 0, tier2Calls: 0 };
    const ex = makeMockExtractor({ tier0: null, tier1: null, tier2: null }, log);

    const result = await runExtractionCascade(ex, "file.djvu");

    expect(result.attempt).toBe(null);
    expect(result.attempts.length).toBe(0);
  });
});

describe("Cascade Runner — disabledTiers", () => {
  it("disabledTiers=[2] → Tier 2 пропускается даже если 0/1 не справились", async () => {
    const log: CallLog = { tier0Calls: 0, tier1Calls: 0, tier2Calls: 0 };
    const ex = makeMockExtractor({
      tier0: { tier: 0, engine: "text-layer", quality: 0.1, text: "weak", warnings: [] },
      tier1: { tier: 1, engine: "system-ocr", quality: 0.2, text: "weak", warnings: [] },
      tier2: { tier: 2, engine: "vision-llm", quality: 0.9, text: "would help", warnings: [] },
    }, log);

    const result = await runExtractionCascade(ex, "file.djvu", { disabledTiers: [2] });

    expect(log.tier2Calls).toBe(0);
    /* Лучший из 0/1 */
    expect(result.attempt?.tier).toBe(1);
  });

  it("disabledTiers=[0, 1] → только Tier 2 пытается", async () => {
    const log: CallLog = { tier0Calls: 0, tier1Calls: 0, tier2Calls: 0 };
    const ex = makeMockExtractor({
      tier0: { tier: 0, engine: "text-layer", quality: 0.9, text: "ignored", warnings: [] },
      tier1: { tier: 1, engine: "system-ocr", quality: 0.9, text: "ignored", warnings: [] },
      tier2: { tier: 2, engine: "vision-llm", quality: 0.7, text: "vision only", warnings: [] },
    }, log);

    const result = await runExtractionCascade(ex, "file.djvu", { disabledTiers: [0, 1] });

    expect(log.tier0Calls).toBe(0);
    expect(log.tier1Calls).toBe(0);
    expect(log.tier2Calls).toBe(1);
    expect(result.attempt?.text).toBe("vision only");
  });
});

describe("Cascade Runner — abort", () => {
  it("AbortSignal прерывает цепочку между Tier'ами", async () => {
    const log: CallLog = { tier0Calls: 0, tier1Calls: 0, tier2Calls: 0 };
    const ctl = new AbortController();
    const ex = makeMockExtractor({
      tier0: { tier: 0, engine: "text-layer", quality: 0.2, text: "weak", warnings: [] },
      tier1: { tier: 1, engine: "system-ocr", quality: 0.9, text: "n/a", warnings: [] },
    }, log);

    /* Прерываем сразу — Tier 0 запустится (signal.aborted check ДО, не во время) */
    ctl.abort();
    const result = await runExtractionCascade(ex, "file.djvu", { signal: ctl.signal });

    /* Tier 0 не вызывался (signal.aborted проверяется ДО первого вызова) */
    expect(log.tier0Calls).toBe(0);
    expect(log.tier1Calls).toBe(0);
    expect(result.attempt).toBe(null);
  });
});
