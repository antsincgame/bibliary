import { describe, it } from "node:test";
import { expect } from "./helpers/expect-shim.ts";
import {
  classifyByVramMB,
  describeWeight,
  evictionPriority,
  LIGHT_MAX_MB,
  MEDIUM_MAX_MB,
} from "../electron/lib/llm/model-size-classifier.js";

describe("model-size-classifier", () => {
  it("light: <= 8 GB → light", () => {
    expect(classifyByVramMB(1024)).toBe("light");
    expect(classifyByVramMB(4096)).toBe("light");
    expect(classifyByVramMB(LIGHT_MAX_MB)).toBe("light");
  });

  it("medium: 8..16 GB → medium", () => {
    expect(classifyByVramMB(LIGHT_MAX_MB + 1)).toBe("medium");
    expect(classifyByVramMB(10 * 1024)).toBe("medium");
    expect(classifyByVramMB(MEDIUM_MAX_MB)).toBe("medium");
  });

  it("heavy: > 16 GB → heavy", () => {
    expect(classifyByVramMB(MEDIUM_MAX_MB + 1)).toBe("heavy");
    expect(classifyByVramMB(22 * 1024)).toBe("heavy");
    expect(classifyByVramMB(70 * 1024)).toBe("heavy");
  });

  it("invalid input → medium (консервативный fallback)", () => {
    expect(classifyByVramMB(0)).toBe("medium");
    expect(classifyByVramMB(-1)).toBe("medium");
    expect(classifyByVramMB(NaN)).toBe("medium");
    expect(classifyByVramMB(Infinity)).toBe("medium");
  });

  it("real-world: PROFILE.SMALL (4.28 GB) → light", () => {
    /* qwen3-4b: 4.28 GB × 1.3 ≈ 5.5 GB → light */
    expect(classifyByVramMB(Math.round(4.28 * 1024 * 1.3))).toBe("light");
  });

  it("real-world: PROFILE.BIG (22.07 GB) → heavy", () => {
    /* qwen3.6-35b-a3b: 22.07 GB × 1.3 ≈ 28.7 GB → heavy */
    expect(classifyByVramMB(Math.round(22.07 * 1024 * 1.3))).toBe("heavy");
  });

  it("describeWeight возвращает читаемую строку", () => {
    expect(describeWeight("light")).toContain("light");
    expect(describeWeight("medium")).toContain("medium");
    expect(describeWeight("heavy")).toContain("heavy");
    expect(describeWeight("light")).toContain("8 GB");
    expect(describeWeight("heavy")).toContain("16 GB");
  });

  it("evictionPriority: heavy > medium > light", () => {
    expect(evictionPriority("heavy")).toBeGreaterThan(evictionPriority("medium"));
    expect(evictionPriority("medium")).toBeGreaterThan(evictionPriority("light"));
  });
});
