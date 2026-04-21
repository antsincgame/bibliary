// @ts-check
import { el, clear } from "../dom.js";
import { t } from "../i18n.js";

const LEGACY_STORAGE_KEY = "bibliary_setup_done";
const ONBOARDING_VERSION = 1;
const STEP_COUNT = 5;

/**
 * Smart Onboarding Wizard — 5 шагов:
 *   0 Hero          → приветствие
 *   1 Connectivity  → health-check LM Studio + Qdrant с soft-skip
 *   2 Hardware      → CPU/RAM/GPU/VRAM (детект через system.hardware)
 *   3 Models        → реальные loaded + downloaded + кураторские
 *                     рекомендации + 4 ролевых селектора (chat/agent/extractor/judge)
 *   4 Done          → persist в preferences (onboardingDone, *Model, URLs)
 *
 * Открывается:
 *   - На первом запуске (если preferences.onboardingDone !== true)
 *   - Через Settings → "Пройти setup заново" (opts.force)
 *
 * @param {object} [opts]
 * @param {boolean} [opts.force] - открыть даже если уже пройден
 */
export function openWelcomeWizard(opts) {
  if (document.getElementById("welcome-wizard-overlay")) return;
  /* Force-режим обходит проверку; иначе caller (router.js) уже проверил prefs. */
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

  /** @type {{ step: number, hardware: any, services: any, curated: any, selected: { chat: string, agent: string, extractor: string, judge: string }, urlsTouched: { lm: boolean, qd: boolean } }} */
  const STATE = {
    step: 0,
    hardware: null,
    services: null,
    curated: null,
    selected: { chat: "", agent: "", extractor: "", judge: "" },
    urlsTouched: { lm: false, qd: false },
  };

  void renderStep();

  async function renderStep() {
    clear(modal);
    modal.appendChild(buildHeader());
    if (STATE.step === 0) modal.appendChild(buildHero());
    else if (STATE.step === 1) modal.appendChild(await buildConnectivity());
    else if (STATE.step === 2) modal.appendChild(await buildHardware());
    else if (STATE.step === 3) modal.appendChild(await buildModels());
    else if (STATE.step === 4) modal.appendChild(buildDone());
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

  /* ─── Шаг 1: Connectivity ─────────────────────────────────────────────── */

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

    const retryBtn = el(
      "button",
      { class: "btn btn-ghost ww-conn-retry", type: "button" },
      t("ww.conn.retry")
    );
    retryBtn.addEventListener("click", () => {
      void doProbe();
    });
    wrap.appendChild(retryBtn);

    /* soft-skip note — всегда показываем, даже если оба online */
    wrap.appendChild(
      el("p", { class: "ww-p ww-p-muted ww-conn-skip-note" }, t("ww.conn.skipNote"))
    );

    async function doProbe() {
      lmCard.className = "ww-conn-card ww-conn-card-loading";
      qdCard.className = "ww-conn-card ww-conn-card-loading";
      lmCard.textContent = t("ww.conn.probing");
      qdCard.textContent = t("ww.conn.probing");
      try {
        STATE.services = /** @type {any} */ (await window.api.system.probeServices());
        renderConnCard(lmCard, "lm", STATE.services.lmStudio);
        renderConnCard(qdCard, "qd", STATE.services.qdrant);
      } catch (e) {
        renderConnCard(lmCard, "lm", { online: false, url: "?", error: errMsg(e) });
        renderConnCard(qdCard, "qd", { online: false, url: "?", error: errMsg(e) });
      }
    }

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
          ? "✓ " + (status.version ? `v${status.version}` : t("ww.conn.online"))
          : "✗ " + t("ww.conn.offline")
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

  /* ─── Шаг 2: Hardware (как раньше) ────────────────────────────────────── */

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

  /* ─── Шаг 3: Models — реальные loaded + downloaded + кураторские ──────── */

  async function buildModels() {
    const wrap = el("div", { class: "ww-step ww-step-models" }, [
      el("h2", { class: "ww-h2" }, t("ww.models.title")),
      el("p", { class: "ww-p" }, t("ww.models.sub")),
    ]);

    /** @type {any[]} */
    let loaded = [];
    /** @type {any[]} */
    let downloaded = [];
    try {
      loaded = /** @type {any[]} */ (await window.api.lmstudio.listLoaded());
    } catch { loaded = []; }
    try {
      downloaded = /** @type {any[]} */ (await window.api.lmstudio.listDownloaded());
    } catch { downloaded = []; }

    if (!STATE.curated) {
      try {
        STATE.curated = /** @type {any} */ (await window.api.system.curatedModels());
      } catch { STATE.curated = { models: [] }; }
    }

    /* Загруженные модели */
    wrap.appendChild(
      buildModelSection("ww.models.loaded.title", loaded, (m) => m.modelKey, true)
    );

    /* Скачанные но не активные */
    const loadedKeys = new Set(loaded.map((m) => m.modelKey));
    const onlyDownloaded = downloaded.filter((m) => !loadedKeys.has(m.modelKey));
    wrap.appendChild(
      buildModelSection("ww.models.downloaded.title", onlyDownloaded, (m) => m.modelKey, false)
    );

    /* Кураторский список под VRAM */
    const vram = STATE.hardware?.bestGpu?.vramGB ?? 0;
    const fitting = (STATE.curated?.models ?? []).filter((m) => vram === 0 || m.minVramGB <= vram);
    wrap.appendChild(buildCuratedSection(fitting));

    /* 4 ролевых селектора + smart-кнопка */
    wrap.appendChild(buildRolePickers(loaded));

    return wrap;
  }

  function buildModelSection(titleKey, models, getKey, isLoaded) {
    const sec = el("div", { class: "ww-models-sec" }, [
      el("h3", { class: "ww-h3" }, t(titleKey) + ` (${models.length})`),
    ]);
    if (models.length === 0) {
      sec.appendChild(el("div", { class: "ww-models-empty" }, t("ww.models.empty")));
      return sec;
    }
    const list = el("div", { class: "ww-models-list" });
    for (const m of models) {
      const key = getKey(m);
      const ctx = m.contextLength ? ` · ${(m.contextLength / 1024).toFixed(0)}K ctx` : "";
      const quant = m.quantization ? ` · ${m.quantization}` : "";
      list.appendChild(
        el("div", { class: "ww-model-row" + (isLoaded ? " ww-model-row-loaded" : "") }, [
          el("span", { class: "ww-model-key" }, key),
          el("span", { class: "ww-model-meta" }, `${quant}${ctx}`),
        ])
      );
    }
    sec.appendChild(list);
    return sec;
  }

  function buildCuratedSection(fitting) {
    const sec = el("div", { class: "ww-models-sec ww-models-sec-curated" }, [
      el("h3", { class: "ww-h3" }, t("ww.models.curated.title") + ` (${fitting.length})`),
      el("p", { class: "ww-p ww-p-muted" }, t("ww.models.curated.sub")),
    ]);
    if (fitting.length === 0) {
      sec.appendChild(el("div", { class: "ww-models-empty" }, t("ww.models.curated.empty")));
      return sec;
    }
    const list = el("div", { class: "ww-models-list" });
    for (const m of fitting) {
      const card = el("div", { class: "ww-curated-card" }, [
        el("div", { class: "ww-curated-head" }, [
          el("span", { class: "ww-curated-name" }, m.displayName),
          el("span", { class: "ww-curated-vram" }, `${m.minVramGB}-${m.recommendedVramGB} GB VRAM`),
        ]),
        el("div", { class: "ww-curated-desc" }, m.description),
        el("div", { class: "ww-curated-meta" }, `${m.modelKey} · ${m.quant} · ${m.sizeGB} GB`),
      ]);
      const openBtn = el(
        "button",
        { class: "btn btn-ghost ww-curated-btn", type: "button" },
        t("ww.models.curated.open")
      );
      openBtn.addEventListener("click", () => {
        const url = `https://huggingface.co/${m.hfQuantRepo}`;
        try {
          window.open(url, "_blank", "noopener,noreferrer");
        } catch { /* popup blocker — игнорируем */ }
      });
      card.appendChild(openBtn);
      list.appendChild(card);
    }
    sec.appendChild(list);
    return sec;
  }

  function buildRolePickers(loaded) {
    const sec = el("div", { class: "ww-models-sec ww-models-sec-roles" }, [
      el("h3", { class: "ww-h3" }, t("ww.models.roles.title")),
      el("p", { class: "ww-p ww-p-muted" }, t("ww.models.roles.sub")),
    ]);

    /** @type {Array<{role: "chat"|"agent"|"extractor"|"judge", labelKey: string}>} */
    const roles = [
      { role: "chat", labelKey: "ww.models.role.chat" },
      { role: "agent", labelKey: "ww.models.role.agent" },
      { role: "extractor", labelKey: "ww.models.role.extractor" },
      { role: "judge", labelKey: "ww.models.role.judge" },
    ];

    const grid = el("div", { class: "ww-roles-grid" });
    /** @type {Record<string, HTMLSelectElement>} */
    const selects = {};
    for (const r of roles) {
      const select = /** @type {HTMLSelectElement} */ (el("select", { class: "ww-role-select" }));
      if (loaded.length === 0) {
        select.appendChild(el("option", { value: "" }, t("ww.models.role.noLoaded")));
        select.disabled = true;
      } else {
        select.appendChild(el("option", { value: "" }, "—"));
        for (const m of loaded) {
          select.appendChild(el("option", { value: m.modelKey }, m.modelKey));
        }
      }
      select.addEventListener("change", () => {
        STATE.selected[r.role] = select.value;
      });
      selects[r.role] = select;
      grid.appendChild(
        el("div", { class: "ww-role-row" }, [
          el("label", { class: "ww-role-label" }, t(r.labelKey)),
          select,
        ])
      );
    }
    sec.appendChild(grid);

    /* Smart-кнопка "Назначить под железо" */
    const smartBtn = el(
      "button",
      { class: "btn btn-gold ww-smart-btn", type: "button" },
      t("ww.models.smart.btn")
    );
    smartBtn.addEventListener("click", () => {
      const auto = autoAssignByVram(loaded);
      for (const r of roles) {
        STATE.selected[r.role] = auto[r.role] || "";
        selects[r.role].value = auto[r.role] || "";
      }
    });
    sec.appendChild(smartBtn);

    return sec;
  }

  /**
   * Smart auto-assignment: подбирает по одной модели на роль из loaded,
   * учитывая VRAM и приоритет подсказок.
   * @param {any[]} loaded
   * @returns {{ chat: string, agent: string, extractor: string, judge: string }}
   */
  function autoAssignByVram(loaded) {
    if (loaded.length === 0) return { chat: "", agent: "", extractor: "", judge: "" };
    const vram = STATE.hardware?.bestGpu?.vramGB ?? 0;
    const keys = loaded.map((m) => String(m.modelKey).toLowerCase());

    /** @param {string[]} hints */
    const pick = (hints) => {
      for (const h of hints) {
        const idx = keys.findIndex((k) => k.includes(h));
        if (idx !== -1) return loaded[idx].modelKey;
      }
      return loaded[0].modelKey;
    };

    /* < 8GB → одна лёгкая модель на все роли (qwen3-4b или llama-3.2-3b) */
    if (vram > 0 && vram < 8) {
      const small = pick(["qwen3-4b", "llama-3.2-3b", "qwen3", "llama"]);
      return { chat: small, agent: small, extractor: small, judge: small };
    }
    /* 8-16GB → среднее: qwen3.6 или 14b на chat/agent, любая на extractor/judge */
    if (vram > 0 && vram < 16) {
      const mid = pick(["qwen3.6", "qwen3-14b", "qwen3", "mistral-small"]);
      const ext = pick(["qwen3-4b", "qwen3", "llama"]);
      return { chat: mid, agent: mid, extractor: ext, judge: ext };
    }
    /* 16+ или unknown → топ на chat/agent, средняя на extractor/judge */
    const top = pick(["qwen3.6", "qwen3-coder", "mistral-small", "qwen3"]);
    const mid = pick(["qwen3-4b", "qwen3-14b", "llama"]);
    return { chat: top, agent: top, extractor: mid, judge: mid };
  }

  /* ─── Шаг 4: Done ─────────────────────────────────────────────────────── */

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

  /* ─── Footer / навигация ──────────────────────────────────────────────── */

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
      /* Соft-skip на Connectivity: Next всегда активен; если оба сервиса offline,
         текст становится "Продолжить без подключения" с предупреждающим стилем. */
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
    /* Записываем выбор моделей только если пользователь явно выбрал (не пусто) */
    if (STATE.selected.chat) patch.chatModel = STATE.selected.chat;
    if (STATE.selected.agent) patch.agentModel = STATE.selected.agent;
    if (STATE.selected.extractor) patch.extractorModel = STATE.selected.extractor;
    if (STATE.selected.judge) patch.judgeModel = STATE.selected.judge;
    try {
      await window.api.preferences.set(patch);
    } catch { /* ignore — wizard всё равно закроется */ }
    /* Чистим legacy localStorage чтобы не было двух источников истины */
    try { localStorage.removeItem(LEGACY_STORAGE_KEY); } catch { /* ignore */ }
    overlay.remove();
  }

  function appendKv(parent, labelKey, value) {
    parent.appendChild(el("div", { class: "ww-kv-label" }, t(labelKey)));
    parent.appendChild(el("div", { class: "ww-kv-value" }, value));
  }
}

/**
 * Legacy localStorage-флаг от старой версии wizard'а. Используется только
 * как дополнительная страховка от повторного показа при свежей установке
 * новой версии — основной источник истины это preferences.onboardingDone
 * (проверяется в router.js до вызова openWelcomeWizard).
 */
function isLegacyDone() {
  try {
    return localStorage.getItem(LEGACY_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Сбросить wizard — Settings вызывает это перед openWelcomeWizard({force:true})
 * чтобы пользователь мог пройти заново.
 */
export async function resetWelcomeWizard() {
  try { localStorage.removeItem(LEGACY_STORAGE_KEY); } catch { /* ignore */ }
  try {
    await window.api.preferences.set({ onboardingDone: false, onboardingVersion: 0 });
  } catch { /* ignore — пользователь увидит wizard если router заметит false */ }
}

function errMsg(e) {
  return e instanceof Error ? e.message : String(e);
}
