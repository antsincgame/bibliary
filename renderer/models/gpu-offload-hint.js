// @ts-check
/**
 * Heuristic GPU layer offload for LM Studio `llm.load` — tuned from detected VRAM.
 * When unknown, returns {} so LM Studio keeps its own defaults.
 */

/**
 * @param {unknown} hw — hardware snapshot from `system.hardware()`, or null
 * @returns {{ gpuOffload?: "max" | number }}
 */
export function inferGpuOffloadForLmLoad(hw) {
  const h = /** @type {{ bestGpu?: { vramGB?: number | null } | null } | null} */ (hw);
  const v = h?.bestGpu?.vramGB;
  if (v == null || typeof v !== "number" || Number.isNaN(v)) return {};
  if (v >= 18) return { gpuOffload: "max" };
  if (v >= 12) return { gpuOffload: 0.92 };
  if (v >= 8) return { gpuOffload: 0.78 };
  if (v >= 6) return { gpuOffload: 0.55 };
  if (v >= 4) return { gpuOffload: 0.38 };
  return { gpuOffload: 0.22 };
}

/**
 * @param {unknown} hw
 * @param {(k: string, p?: Record<string, string | number>) => string} tr
 */
export function hardwareSummaryLine(hw, tr) {
  if (!hw || typeof hw !== "object") return tr("models.hardware.unknown");
  const h = /** @type {{
    bestGpu?: { name?: string; vramGB?: number | null; backend?: string } | null;
    cpu?: { model?: string };
    ramGB?: number;
  }} */ (hw);
  const g = h.bestGpu;
  if (!g?.name) {
    const cpu = (h.cpu?.model ?? "?").toString().slice(0, 56);
    const ram = h.ramGB != null && !Number.isNaN(h.ramGB) ? String(Math.round(h.ramGB * 10) / 10) : "?";
    return tr("models.hardware.cpu_only", { cpu, ram });
  }
  const vram = typeof g.vramGB === "number" && !Number.isNaN(g.vramGB)
    ? String(Math.round(g.vramGB * 10) / 10)
    : "?";
  const be = g.backend ? String(g.backend) : "?";
  return tr("models.hardware.summary", { gpu: g.name, vram, be });
}

/**
 * @param {unknown} hw
 * @param {(k: string, p?: Record<string, string | number>) => string} tr
 */
export function offloadHintLine(hw, tr) {
  const o = inferGpuOffloadForLmLoad(hw);
  if (o.gpuOffload === undefined) return tr("models.hardware.offload_auto");
  if (o.gpuOffload === "max") return tr("models.hardware.offload_max");
  return tr("models.hardware.offload_ratio", { ratio: String(Math.round(o.gpuOffload * 100)) });
}

/**
 * Suggested KV-cache context length for a given VRAM budget. Conservative —
 * we keep room for activations and (in CPU-only mode) for system RAM swap.
 *
 * @param {unknown} hw
 * @returns {number}
 */
export function suggestedContextLength(hw) {
  const h = /** @type {{ bestGpu?: { vramGB?: number | null } | null } | null} */ (hw);
  const v = h?.bestGpu?.vramGB ?? 0;
  if (v >= 24) return 65536;
  if (v >= 16) return 32768;
  if (v >= 12) return 16384;
  if (v >= 8) return 8192;
  if (v >= 4) return 4096;
  return 2048;
}

const GB = 1024 ** 3;

/**
 * Pick the heaviest downloaded LLM that comfortably fits the hardware budget.
 *
 * Strategy:
 *   - If we know `vramGB`: keep weights ≤ 78 % of VRAM (room for KV-cache + activations).
 *   - If no GPU: keep weights ≤ min(0.5 × RAM, 12 GB) so chats stay responsive on CPU.
 *   - Among candidates that fit, return the heaviest (proxy for capability).
 *   - If none fit, return the smallest available model so the user still gets *something*.
 *
 * @param {Array<{ modelKey: string; sizeBytes?: number; paramsString?: string }>} downloaded
 * @param {unknown} hw
 * @returns {{ modelKey: string; sizeBytes?: number; reasonKey: string } | null}
 */
export function pickHardwareAutoModel(downloaded, hw) {
  if (!Array.isArray(downloaded) || downloaded.length === 0) return null;
  const sized = downloaded.filter((m) => typeof m.sizeBytes === "number" && m.sizeBytes > 0);
  const list = sized.length > 0 ? sized : downloaded.map((m) => ({ ...m, sizeBytes: m.sizeBytes ?? 0 }));

  const h = /** @type {{ bestGpu?: { vramGB?: number | null } | null; ramGB?: number } | null} */ (hw);
  const vramGB = h?.bestGpu?.vramGB ?? null;
  const ramGB = h?.ramGB ?? null;

  const cpuOnlyBudgetGB = Math.min((ramGB ?? 16) * 0.5, 12);
  const budgetGB = vramGB && vramGB > 0 ? vramGB * 0.78 : cpuOnlyBudgetGB;
  const budgetBytes = budgetGB * GB;

  const fits = list.filter((m) => (m.sizeBytes ?? 0) <= budgetBytes);
  if (fits.length > 0) {
    fits.sort((a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0));
    const best = fits[0];
    return {
      modelKey: best.modelKey,
      sizeBytes: best.sizeBytes,
      reasonKey: vramGB && vramGB > 0 ? "models.autoconf.reason.vram" : "models.autoconf.reason.cpu",
    };
  }

  list.sort((a, b) => (a.sizeBytes ?? 0) - (b.sizeBytes ?? 0));
  const smallest = list[0];
  return {
    modelKey: smallest.modelKey,
    sizeBytes: smallest.sizeBytes,
    reasonKey: "models.autoconf.reason.tight",
  };
}
