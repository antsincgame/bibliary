// @ts-check
import { el, clear } from "../dom.js";
import { t } from "../i18n.js";

const LEGACY_STORAGE_KEY = "bibliary_setup_done";
const ONBOARDING_VERSION = 2;
const STEP_COUNT = 4;

/**
 * Onboarding wizard v2 — 4 шага (был 5):
 *   0 Hero       → приветствие
 *   1 Connect    → health-check LM Studio + Qdrant с visible feedback
 *   2 Setup      → железо (auto-detect) + дефолтная модель чата (single picker)
 *                  Блок "кураторские рекомендации" удалён по требованию:
 *                  пользователь умеет качать модели в LM Studio сам.
 *   3 Done       → persist в preferences (onboardingDone, chatModel, URLs)
 *
 * Визуально — /2666 HUD-нотация: моноширинный шрифт, кислотный акцент,
 * угловые скобки, статус-бейджи [OK] / [ERR] / [..].
 *
 * @param {object} [opts]
 * @param {boolean} [opts.force]
 */
export function openWelcomeWizard(opts) {
  if (document.getElementById("welcome-wizard-overlay")) return;
  if (opts?.force !== true && isLegacyDone()) return;

  const overlay = el("div", {
    id: "welcome-wizard-overlay",
    class: "ww-overlay",
    role: "dialog",
    "aria-modal": "true",
  });
  const modal = el("div", { class: "ww-modal" });
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  /** @type {{ step: number, hardware: any, services: any, chatModel: string, urlsTouched: { lm: boolean, qd: boolean } }} */
  const STATE = {
    step: 0,
    hardware: null,
    services: null,
    chatModel: "",
    urlsTouched: { lm: false, qd: false },
  };

  void renderStep();

  async function renderStep() {
    clear(modal);
    modal.appendChild(buildHeader());
    if (STATE.step === 0) modal.appendChild(buildHero());
    else if (STATE.step === 1) modal.appendChild(await buildConnectivity());
    else if (STATE.step === 2) modal.appendChild(await buildSetup());
    else if (STATE.step === 3) modal.appendChild(buildDone());
    modal.appendChild(buildFooter());
  }

  function buildHeader() {
    return el("div", { class: "ww-header" }, [
      el("div", { class: "ww-eyebrow" }, t("ww.eyebrow")),
      el(
        "div",
        { class: "ww-stepper" },
        Array.from({ length: STEP_COUNT }, (_, i) =>
          el("span", {
            class:
              "ww-step-dot" +
              (i === STATE.step ? " ww-step-dot-active" : i < STATE.step ? " ww-step-dot-done" : ""),
            "aria-hidden": "true",
          })
        )
      ),
    ]);
  }

  function buildHero() {
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

  /* ─── Step 1: Connectivity ────────────────────────────────────────────── */

  async function buildConnectivity() {
    const wrap = el("div", { class: "ww-step ww-step-conn" }, [
      el("h2", { class: "ww-h2" }, t("ww.conn.title")),
      el("p", { class: "ww-p" }, t("ww.conn.sub")),
    ]);
    const grid = el("div", { class: "ww-conn-grid" });
    const lmCard = el("div", { class: "ww-conn-card ww-conn-card-loading" }, t("ww.conn.probing"));
    const qdCard = el("div", { class: "ww-conn-card ww-conn-card-loading" }, t("ww.conn.probing"));
    grid.append(lmCard, qdCard);
    wrap.appendChild(grid);

    const retryBtn = /** @type {HTMLButtonElement} */ (el(
      "button",
      { class: "btn btn-ghost ww-conn-retry", type: "button" },
      t("ww.conn.retry"),
    ));
    let isProbing = false;

    async function doProbe() {
      if (isProbing) return;
      isProbing = true;
      retryBtn.disabled = true;
      retryBtn.textContent = t("ww.conn.probing");
      retryBtn.setAttribute("aria-busy", "true");
      lmCard.className = "ww-conn-card ww-conn-card-loading";
      qdCard.className = "ww-conn-card ww-conn-card-loading";
      lmCard.textContent = t("ww.conn.probing");
      qdCard.textContent = t("ww.conn.probing");
      const startedAt = Date.now();
      try {
        STATE.services = /** @type {any} */ (await window.api.system.probeServices());
        renderConnCard(lmCard, "lm", STATE.services.lmStudio);
        renderConnCard(qdCard, "qd", STATE.services.qdrant);
      } catch (e) {
        renderConnCard(lmCard, "lm", { online: false, url: "?", error: errMsg(e) });
        renderConnCard(qdCard, "qd", { online: false, url: "?", error: errMsg(e) });
      } finally {
        const elapsed = Date.now() - startedAt;
        if (elapsed < 250) await new Promise((r) => setTimeout(r, 250 - elapsed));
        retryBtn.disabled = false;
        retryBtn.textContent = t("ww.conn.retry");
        retryBtn.removeAttribute("aria-busy");
        isProbing = false;
      }
    }

    retryBtn.addEventListener("click", () => { void doProbe(); });
    wrap.appendChild(retryBtn);
    wrap.appendChild(
      el("p", { class: "ww-p ww-p-muted ww-conn-skip-note" }, t("ww.conn.skipNote"))
    );

    void doProbe();
    return wrap;
  }

  function renderConnCard(card, kind, status) {
    clear(card);
    const isOnline = status?.online === true;
    card.className = "ww-conn-card " + (isOnline ? "ww-conn-card-ok" : "ww-conn-card-off");

    const titleKey = kind === "lm" ? "ww.conn.lm.title" : "ww.conn.qd.title";
    const head = el("div", { class: "ww-conn-card-head" }, [
      el("span", { class: "ww-conn-card-title" }, t(titleKey)),
      el(
        "span",
        { class: "ww-conn-card-status" },
        isOnline
          ? "[OK] " + (status.version ? `v${status.version}` : t("ww.conn.online"))
          : "[ERR] " + t("ww.conn.offline")
      ),
    ]);
    card.appendChild(head);

    const url = String(status?.url ?? "");
    const urlInput = /** @type {HTMLInputElement} */ (
      el("input", {
        type: "url",
        class: "ww-conn-card-url",
        value: url,
        placeholder: kind === "lm" ? "http://localhost:1234" : "http://localhost:6333",
      })
    );
    urlInput.addEventListener("input", () => {
      STATE.urlsTouched[kind === "lm" ? "lm" : "qd"] = true;
    });
    urlInput.addEventListener("change", async () => {
      const v = urlInput.value.trim().replace(/\/+$/, "");
      const prefKey = kind === "lm" ? "lmStudioUrl" : "qdrantUrl";
      try {
        await window.api.preferences.set({ [prefKey]: v });
      } catch { /* ignore */ }
    });
    card.appendChild(urlInput);

    if (!isOnline) {
      const hintKey = kind === "lm" ? "ww.conn.lm.offlineHint" : "ww.conn.qd.offlineHint";
      card.appendChild(el("p", { class: "ww-conn-card-hint" }, t(hintKey)));
    }
  }

  /* ─── Step 2: Setup (Hardware + Default Model в одном шаге) ────────────── */

  async function buildSetup() {
    const wrap = el("div", { class: "ww-step ww-step-setup" }, [
      el("h2", { class: "ww-h2" }, t("ww.setup.title")),
      el("p", { class: "ww-p" }, t("ww.setup.sub")),
    ]);

    const hwBlock = el("div", { class: "ww-setup-block" }, [
      el("div", { class: "ww-setup-block-label" }, t("ww.setup.hw_label")),
    ]);
    const hwCard = el("div", { class: "ww-card ww-card-loading" }, t("ww.hardware.detecting"));
    hwBlock.appendChild(hwCard);
    wrap.appendChild(hwBlock);

    try {
      const hw = /** @type {any} */ (await window.api.system.hardware(true));
      STATE.hardware = hw;
      clear(hwCard);
      hwCard.classList.remove("ww-card-loading");
      hwCard.appendChild(buildHardwareCard(hw));
    } catch (e) {
      clear(hwCard);
      hwCard.appendChild(el("div", { class: "ww-error" }, t("ww.hardware.error", { msg: errMsg(e) })));
    }

    const modelBlock = el("div", { class: "ww-setup-block" }, [
      el("div", { class: "ww-setup-block-label" }, t("ww.setup.model_label")),
      el("p", { class: "ww-p ww-p-muted ww-setup-model-hint" }, t("ww.setup.model_hint")),
    ]);
    modelBlock.appendChild(await buildDefaultModelPicker());
    wrap.appendChild(modelBlock);

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

  /**
   * Один селектор default chat model. Показывает union loaded + downloaded,
   * downloaded помечены префиксом ↓. Persist в preferences.chatModel при
   * выборе. Никаких ролевых селекторов / smart-кнопки / curated-блока.
   */
  async function buildDefaultModelPicker() {
    /** @type {any[]} */
    let loaded = [];
    /** @type {any[]} */
    let downloaded = [];
    try { loaded = /** @type {any[]} */ (await window.api.lmstudio.listLoaded()); } catch { loaded = []; }
    try { downloaded = /** @type {any[]} */ (await window.api.lmstudio.listDownloaded()); } catch { downloaded = []; }

    const loadedKeys = new Set(loaded.map((m) => m.modelKey));
    const downloadedOnly = downloaded.filter((m) => m.modelKey && !loadedKeys.has(m.modelKey));

    const select = /** @type {HTMLSelectElement} */ (el("select", { class: "ww-role-select" }));
    if (loaded.length === 0 && downloadedOnly.length === 0) {
      select.appendChild(el("option", { value: "" }, t("ww.setup.model_empty")));
      select.disabled = true;
    } else {
      select.appendChild(el("option", { value: "" }, t("ww.setup.model_placeholder")));
      if (loaded.length > 0) {
        const grp = el("optgroup", { label: t("modelSelect.group.loaded") });
        for (const m of loaded) {
          grp.appendChild(el("option", { value: m.modelKey }, m.modelKey));
        }
        select.appendChild(grp);
      }
      if (downloadedOnly.length > 0) {
        const grp = el("optgroup", { label: t("modelSelect.group.downloaded") });
        for (const m of downloadedOnly) {
          grp.appendChild(el("option", { value: m.modelKey }, `↓ ${m.modelKey}`));
        }
        select.appendChild(grp);
      }
    }

    select.addEventListener("change", () => {
      STATE.chatModel = select.value;
    });

    return el("div", { class: "ww-setup-model-row" }, [select]);
  }

  /* ─── Step 3: Done ────────────────────────────────────────────────────── */

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

  /* ─── Footer ──────────────────────────────────────────────────────────── */

  function buildFooter() {
    const footer = el("div", { class: "ww-footer" });
    const skip = el("button", { class: "btn btn-ghost", type: "button" }, t("ww.skip"));
    skip.addEventListener("click", () => void finish());
    footer.appendChild(skip);

    if (STATE.step > 0) {
      const back = el("button", { class: "btn btn-ghost", type: "button" }, t("ww.back"));
      back.addEventListener("click", () => {
        STATE.step--;
        void renderStep();
      });
      footer.appendChild(back);
    }

    if (STATE.step < STEP_COUNT - 1) {
      const isConn = STATE.step === 1;
      const bothOffline =
        isConn && STATE.services
          ? !STATE.services.lmStudio?.online && !STATE.services.qdrant?.online
          : false;
      const nextLabel =
        STATE.step === 0
          ? t("ww.start")
          : bothOffline
            ? t("ww.conn.skipBtn")
            : t("ww.next");
      const next = el(
        "button",
        { class: bothOffline ? "btn btn-ghost" : "btn btn-gold", type: "button" },
        nextLabel
      );
      next.addEventListener("click", () => {
        STATE.step++;
        void renderStep();
      });
      footer.appendChild(next);
    } else {
      const done = el("button", { class: "btn btn-gold", type: "button" }, t("ww.finish"));
      done.addEventListener("click", () => void finish());
      footer.appendChild(done);
    }
    return footer;
  }

  /* ─── Persist + close ─────────────────────────────────────────────────── */

  async function finish() {
    /** @type {Record<string, unknown>} */
    const patch = {
      onboardingDone: true,
      onboardingVersion: ONBOARDING_VERSION,
    };
    if (STATE.chatModel) patch.chatModel = STATE.chatModel;
    try {
      await window.api.preferences.set(patch);
    } catch { /* ignore */ }
    try { localStorage.removeItem(LEGACY_STORAGE_KEY); } catch { /* ignore */ }
    overlay.remove();
  }

  function appendKv(parent, labelKey, value) {
    parent.appendChild(el("div", { class: "ww-kv-label" }, t(labelKey)));
    parent.appendChild(el("div", { class: "ww-kv-value" }, value));
  }
}

function isLegacyDone() {
  try {
    return localStorage.getItem(LEGACY_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export async function resetWelcomeWizard() {
  try { localStorage.removeItem(LEGACY_STORAGE_KEY); } catch { /* ignore */ }
  try {
    await window.api.preferences.set({ onboardingDone: false, onboardingVersion: 0 });
  } catch { /* ignore */ }
}

function errMsg(e) {
  return e instanceof Error ? e.message : String(e);
}
