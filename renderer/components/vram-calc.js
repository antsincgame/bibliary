// @ts-check
import { el, clear } from "../dom.js";
import { t } from "../i18n.js";

/**
 * Универсальный VRAM-калькулятор. Используется в:
 *   - Forge wizard Step 3 (Phase 3.2) — показывает влияние max_seq_length / batch
 *   - Models route — показывает «поместится ли модель в ваш GPU»
 *   - Welcome wizard Step 3 (Phase 3.1) — sanity check после выбора preset
 *
 * Формула (источник: modal.com 2026 + flozi.net):
 *   training (full FT, FP16 + 8-bit optimizer):  ≈ 16 GB / B params
 *   training LoRA bf16:                          ≈ 5 GB / B params
 *   training QLoRA 4-bit:                        ≈ 1.3 GB / B params
 *   inference FP16:                              params * 2 GB
 *   inference Q4:                                params * 0.5 GB
 *   plus KV-cache (формула в yarn/engine.ts)
 *
 * Зависимости только от dom + i18n. Работает без IPC.
 *
 * @param {object} opts
 * @param {{ params: number; activeParams?: number }} opts.model — модель для расчёта
 * @param {"inference"|"lora"|"qlora"|"full"} opts.mode
 * @param {"fp16"|"q8_0"|"q4_0"} [opts.quant]
 * @param {number} [opts.contextTokens]
 * @param {number} [opts.kvCacheGb] — если уже посчитан yarn engine'ом
 * @param {{ vramGB?: number }} [opts.hardware]
 * @returns {HTMLElement & { update: (next: Partial<typeof opts>) => void }}
 */
export function buildVramCalculator(opts) {
  let state = { ...opts };

  const root = el("div", { class: "vram-calc" });
  const headline = el("div", { class: "vram-calc-headline" });
  const breakdown = el("ul", { class: "vram-calc-breakdown" });
  const verdict = el("div", { class: "vram-calc-verdict" });

  root.appendChild(headline);
  root.appendChild(breakdown);
  root.appendChild(verdict);

  function recompute() {
    clear(headline);
    clear(breakdown);
    clear(verdict);

    const params = state.model?.params ?? 0;
    const activeParams = state.model?.activeParams ?? params;
    const mode = state.mode || "inference";
    const quant = state.quant || "fp16";
    const ctx = state.contextTokens || 0;

    const weightsGb = computeWeightsGb(params, activeParams, mode, quant);
    const overheadGb = mode === "inference" ? 1.5 : 3.0;
    const kvGb = state.kvCacheGb ?? estimateRoughKv(activeParams, ctx, quant);
    const trainingExtra = mode === "inference" ? 0 : computeTrainingOverhead(params, mode);
    const totalGb = round1(weightsGb + overheadGb + kvGb + trainingExtra);

    headline.textContent = t("vram.headline", { total: totalGb, mode: t(`vram.mode.${mode}`) });

    appendRow("vram.row.weights", weightsGb);
    if (kvGb > 0) appendRow("vram.row.kv", kvGb);
    appendRow("vram.row.overhead", overheadGb);
    if (trainingExtra > 0) appendRow("vram.row.training_extra", trainingExtra);

    const vramAvail = state.hardware?.vramGB;
    if (typeof vramAvail === "number") {
      const fits = totalGb <= vramAvail;
      verdict.textContent = fits
        ? t("vram.verdict.fits", { total: totalGb, avail: vramAvail })
        : t("vram.verdict.no_fit", { total: totalGb, avail: vramAvail });
      verdict.className = fits ? "vram-calc-verdict vram-fits" : "vram-calc-verdict vram-no-fit";
    } else {
      verdict.textContent = t("vram.verdict.unknown_gpu");
      verdict.className = "vram-calc-verdict vram-unknown";
    }
  }

  function appendRow(labelKey, gb) {
    breakdown.appendChild(
      el("li", { class: "vram-row" }, [
        el("span", { class: "vram-row-label" }, t(labelKey)),
        el("span", { class: "vram-row-value" }, `${round1(gb)} GB`),
      ])
    );
  }

  recompute();

  /** @type {any} */
  const api = root;
  api.update = (next) => {
    state = { ...state, ...next };
    recompute();
  };
  return api;
}

// ─────────────────────────────────────────────────────────────────────────────

function computeWeightsGb(params, activeParams, mode, quant) {
  const bytesPerParam = quant === "fp16" ? 2 : quant === "q8_0" ? 1 : 0.5;
  // MoE inference: только активные параметры в VRAM
  const effectiveParams = mode === "inference" ? activeParams : params;
  return effectiveParams * bytesPerParam;
}

function computeTrainingOverhead(params, mode) {
  // Грубая прикидка из modal.com: full = ~12*params, lora = ~3*params, qlora = ~1*params
  if (mode === "full") return params * 12;
  if (mode === "lora") return params * 3;
  if (mode === "qlora") return params * 1;
  return 0;
}

function estimateRoughKv(params, ctx, quant) {
  // Очень грубая прикидка для UI без знания архитектуры:
  // KV-cache ≈ 0.0006 GB на 1B params на 1K tokens FP16
  if (params <= 0 || ctx <= 0) return 0;
  const dtypeFactor = quant === "fp16" ? 1 : quant === "q8_0" ? 0.5 : 0.25;
  return round1((params * (ctx / 1024) * 0.0006 * dtypeFactor));
}

function round1(n) {
  return Math.round(n * 10) / 10;
}
