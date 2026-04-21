// @ts-check
import { el, clear } from "../dom.js";
import { t } from "../i18n.js";
import { buildVramCalculator } from "./vram-calc.js";

const STORAGE_KEY = "bibliary_setup_done";

/**
 * Welcome wizard для первого запуска. 4 шага: hero → hardware → preset → done.
 * Открывается только если localStorage["bibliary_setup_done"] != "1".
 *
 * @param {object} [opts]
 * @param {boolean} [opts.force] — открыть даже если уже пройден (через Settings)
 */
export function openWelcomeWizard(opts) {
  if (!opts?.force && isWizardDone()) return;
  if (document.getElementById("welcome-wizard-overlay")) return;

  const overlay = el("div", { id: "welcome-wizard-overlay", class: "ww-overlay", role: "dialog", "aria-modal": "true" });
  const modal = el("div", { class: "ww-modal" });
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  const STATE = {
    step: 0,
    hardware: /** @type {any} */ (null),
    selectedPreset: /** @type {any} */ (null),
  };

  void renderStep();

  async function renderStep() {
    clear(modal);
    modal.appendChild(buildHeader());
    if (STATE.step === 0) modal.appendChild(buildWelcome());
    else if (STATE.step === 1) modal.appendChild(await buildHardware());
    else if (STATE.step === 2) modal.appendChild(await buildPreset());
    else if (STATE.step === 3) modal.appendChild(buildDone());
    modal.appendChild(buildFooter());
  }

  function buildHeader() {
    return el("div", { class: "ww-header" }, [
      el("div", { class: "ww-eyebrow" }, t("ww.eyebrow")),
      el("div", { class: "ww-stepper" }, [
        ...[0, 1, 2, 3].map((i) =>
          el("span", {
            class: "ww-step-dot" + (i === STATE.step ? " ww-step-dot-active" : i < STATE.step ? " ww-step-dot-done" : ""),
            "aria-hidden": "true",
          })
        ),
      ]),
    ]);
  }

  function buildWelcome() {
    return el("div", { class: "ww-step ww-step-hero" }, [
      el("div", { class: "ww-glow", "aria-hidden": "true" }),
      el("div", { class: "ww-hero-inner" }, [
        el("h1", { class: "ww-title" }, t("ww.welcome.title")),
        el("p", { class: "ww-sub" }, t("ww.welcome.sub")),
        el("ul", { class: "ww-features" }, [
          el("li", {}, t("ww.welcome.f1")),
          el("li", {}, t("ww.welcome.f2")),
          el("li", {}, t("ww.welcome.f3")),
          el("li", {}, t("ww.welcome.f4")),
        ]),
      ]),
    ]);
  }

  async function buildHardware() {
    const wrap = el("div", { class: "ww-step" }, [
      el("h2", { class: "ww-h2" }, t("ww.hardware.title")),
      el("p", { class: "ww-p" }, t("ww.hardware.sub")),
    ]);
    const card = el("div", { class: "ww-card ww-card-loading" }, t("ww.hardware.detecting"));
    wrap.appendChild(card);

    try {
      const hw = /** @type {any} */ (await window.api.system.hardware(true));
      STATE.hardware = hw;
      clear(card);
      card.classList.remove("ww-card-loading");
      card.appendChild(buildHardwareCard(hw));
    } catch (e) {
      clear(card);
      card.appendChild(el("div", { class: "ww-error" }, t("ww.hardware.error", { msg: errMsg(e) })));
    }

    return wrap;
  }

  function buildHardwareCard(hw) {
    const grid = el("div", { class: "ww-hw-grid" });
    appendKv(grid, "ww.hw.os", `${hw.os.platform} (${hw.os.arch})`);
    appendKv(grid, "ww.hw.cpu", hw.cpu.model);
    appendKv(grid, "ww.hw.cores", `${hw.cpu.cores} cores · ${hw.cpu.threads} threads`);
    appendKv(grid, "ww.hw.ram", `${hw.ramGB} GB`);
    if (hw.bestGpu) {
      appendKv(grid, "ww.hw.gpu", `${hw.bestGpu.name} (${hw.bestGpu.backend})`);
      appendKv(grid, "ww.hw.vram", hw.bestGpu.vramGB ? `${hw.bestGpu.vramGB} GB` : t("ww.hw.vram_unknown"));
    } else {
      appendKv(grid, "ww.hw.gpu", t("ww.hw.no_gpu"));
    }
    return grid;
  }

  async function buildPreset() {
    const wrap = el("div", { class: "ww-step" }, [
      el("h2", { class: "ww-h2" }, t("ww.preset.title")),
      el("p", { class: "ww-p" }, t("ww.preset.sub")),
    ]);

    /** @type {any} */
    const presetsData = await window.api.system.hardwarePresets();
    const vram = STATE.hardware?.bestGpu?.vramGB ?? 0;
    const platform = STATE.hardware?.os?.platform ?? "win32";

    const candidates = presetsData.presets.filter(
      (p) => vram >= p.vramMin && vram <= p.vramMax && p.platforms.includes(platform)
    );
    const matched = candidates[0] || presetsData.fallback;
    if (!STATE.selectedPreset) STATE.selectedPreset = matched;

    const list = el("div", { class: "ww-preset-list" });

    for (const preset of presetsData.presets) {
      const card = el(
        "div",
        {
          class: "ww-preset-card" + (STATE.selectedPreset?.id === preset.id ? " ww-preset-active" : ""),
          "data-preset-id": preset.id,
        },
        [
          el("div", { class: "ww-preset-head" }, [
            el("span", { class: "ww-preset-label" }, t(preset.labelKey)),
            preset.id === matched.id
              ? el("span", { class: "ww-preset-badge" }, t("ww.preset.recommended"))
              : null,
          ]),
          el("div", { class: "ww-preset-meta" }, t("ww.preset.vram_range", { min: preset.vramMin, max: preset.vramMax === 1024 ? "∞" : preset.vramMax })),
          el(
            "div",
            { class: "ww-preset-models" },
            preset.infer.map((m) => `${m.modelKey} (${m.quant})`).join(", ")
          ),
        ]
      );
      card.addEventListener("click", () => {
        STATE.selectedPreset = preset;
        wrap.querySelectorAll(".ww-preset-card").forEach((node) => node.classList.remove("ww-preset-active"));
        card.classList.add("ww-preset-active");
      });
      list.appendChild(card);
    }
    wrap.appendChild(list);

    if (STATE.hardware && STATE.selectedPreset?.infer?.[0]) {
      const m = STATE.selectedPreset.infer[0];
      // Используем модель из БД YaRN если known
      try {
        const dbList = /** @type {any[]} */ (await window.api.yarn.listModels());
        const arch = dbList.find((d) => d.modelKey === m.modelKey);
        const { params, activeParams } = arch ? guessParams(arch.modelKey) : { params: 7, activeParams: 7 };
        wrap.appendChild(
          buildVramCalculator({
            model: { params, activeParams },
            mode: "inference",
            quant: m.quant?.startsWith("Q4") ? "q4_0" : m.quant === "Q8_0" ? "q8_0" : "fp16",
            contextTokens: m.contextDefault || 8192,
            hardware: { vramGB: STATE.hardware.bestGpu?.vramGB },
          })
        );
      } catch {
        // skip calc if list-models fails
      }
    }

    return wrap;
  }

  function buildDone() {
    return el("div", { class: "ww-step ww-step-done" }, [
      el("div", { class: "ww-glow", "aria-hidden": "true" }),
      el("div", { class: "ww-hero-inner" }, [
        el("h2", { class: "ww-title" }, t("ww.done.title")),
        el("p", { class: "ww-sub" }, t("ww.done.sub")),
        el("ul", { class: "ww-features" }, [
          el("li", {}, t("ww.done.next1")),
          el("li", {}, t("ww.done.next2")),
          el("li", {}, t("ww.done.next3")),
        ]),
      ]),
    ]);
  }

  function buildFooter() {
    const footer = el("div", { class: "ww-footer" });
    const skip = el("button", { class: "btn btn-ghost", type: "button" }, t("ww.skip"));
    skip.addEventListener("click", finish);
    footer.appendChild(skip);

    if (STATE.step > 0) {
      const back = el("button", { class: "btn btn-ghost", type: "button" }, t("ww.back"));
      back.addEventListener("click", () => {
        STATE.step--;
        renderStep();
      });
      footer.appendChild(back);
    }

    if (STATE.step < 3) {
      const next = el("button", { class: "btn btn-gold", type: "button" }, t(STATE.step === 0 ? "ww.start" : "ww.next"));
      next.addEventListener("click", () => {
        STATE.step++;
        renderStep();
      });
      footer.appendChild(next);
    } else {
      const done = el("button", { class: "btn btn-gold", type: "button" }, t("ww.finish"));
      done.addEventListener("click", finish);
      footer.appendChild(done);
    }
    return footer;
  }

  function finish() {
    try {
      localStorage.setItem(STORAGE_KEY, "1");
    } catch {}
    overlay.remove();
  }

  function appendKv(parent, labelKey, value) {
    parent.appendChild(el("div", { class: "ww-kv-label" }, t(labelKey)));
    parent.appendChild(el("div", { class: "ww-kv-value" }, value));
  }
}

function isWizardDone() {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function resetWelcomeWizard() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {}
}

function errMsg(e) {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Извлекает количество параметров из ключа модели.
 * Для MoE-моделей (содержат "-a" суффикс вроде "35b-a3b") возвращает
 * и полный params, и activeParams.
 */
function guessParams(modelKey) {
  const m = modelKey.match(/(\d+(?:\.\d+)?)[bB]/);
  const total = m ? Number(m[1]) : 7;
  const moe = modelKey.match(/[bB]-a(\d+(?:\.\d+)?)[bB]/);
  const active = moe ? Number(moe[1]) : total;
  return { params: total, activeParams: active };
}
