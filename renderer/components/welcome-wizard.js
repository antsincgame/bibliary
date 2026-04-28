// @ts-check
import { el, clear } from "../dom.js";
import { t } from "../i18n.js";
import { showConfirm } from "./ui-dialog.js";
import { inferGpuOffloadForLmLoad, pickHardwareAutoModel } from "../models/gpu-offload-hint.js";

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

  /** @type {{ step: number, hardware: any, services: any, chatModel: string, chatModelIsDownloaded: boolean, urlsTouched: { lm: boolean, qd: boolean }, prefsHydrated: boolean }} */
  const STATE = {
    step: 0,
    hardware: null,
    services: null,
    chatModel: "",
    chatModelIsDownloaded: false,
    urlsTouched: { lm: false, qd: false },
    prefsHydrated: false,
  };

  /* A3: гидрация существующих preferences. Если пользователь уже настраивал
     wizard и переоткрывает его (Settings → Replay onboarding), селектор
     модели должен предзаполниться его текущим выбором, а не сбрасываться. */
  void hydrateFromPreferences().then(() => void renderStep());

  async function hydrateFromPreferences() {
    try {
      const prefs = /** @type {any} */ (await window.api?.preferences?.getAll());
      if (prefs && typeof prefs.chatModel === "string" && prefs.chatModel.trim().length > 0) {
        STATE.chatModel = prefs.chatModel;
      }
    } catch { /* defaults */ }
    STATE.prefsHydrated = true;
  }

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

    const downloadedOnlyKeys = new Set(downloadedOnly.map((m) => m.modelKey));

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

    /* A3: восстанавливаем сохранённое значение из preferences. Если модель
       всё ещё доступна в LM Studio — селект подсветит её; если её больше
       нет (удалили из LM Studio) — сбрасываем + явно уведомляем (S1.2),
       чтобы пользователь не подумал что выбор сохранился. */
    if (STATE.chatModel) {
      const stillAvailable = loadedKeys.has(STATE.chatModel) || downloadedOnlyKeys.has(STATE.chatModel);
      if (stillAvailable) {
        select.value = STATE.chatModel;
        STATE.chatModelIsDownloaded = downloadedOnlyKeys.has(STATE.chatModel);
      } else {
        const lostModel = STATE.chatModel;
        STATE.chatModel = "";
        STATE.chatModelIsDownloaded = false;
        showWizardToast(t("ww.setup.model_lost", { model: lostModel }), "info");
      }
    }

    select.addEventListener("change", () => {
      STATE.chatModel = select.value;
      STATE.chatModelIsDownloaded = downloadedOnlyKeys.has(select.value);
    });

    /* Авто-подбор под железо (восстановлено из b0a2271 после рефактора d992470,
       но теперь через общий helper pickHardwareAutoModel — без 60 строк
       захардкоженного auto-assign-by-VRAM). */
    const allCandidates = [
      ...loaded.map((m) => ({ modelKey: m.modelKey, sizeBytes: m.sizeBytes })),
      ...downloadedOnly.map((m) => ({ modelKey: m.modelKey, sizeBytes: m.sizeBytes })),
    ];
    const autoBtn = /** @type {HTMLButtonElement} */ (el("button", {
      class: "btn btn-ghost ww-setup-autopick",
      type: "button",
      title: t("ww.setup.autopick_title"),
    }, t("ww.setup.autopick_btn")));
    if (allCandidates.length === 0 || !STATE.hardware) autoBtn.disabled = true;
    autoBtn.addEventListener("click", () => {
      const pick = pickHardwareAutoModel(allCandidates, STATE.hardware);
      if (!pick) {
        showWizardToast(t("ww.setup.autopick_empty"), "info");
        return;
      }
      select.value = pick.modelKey;
      STATE.chatModel = pick.modelKey;
      STATE.chatModelIsDownloaded = downloadedOnlyKeys.has(pick.modelKey);
      showWizardToast(t("ww.setup.autopick_done", { key: pick.modelKey, reason: t(pick.reasonKey) }), "success");
    });

    /* A4 helper: если LM Studio пуст — даём кнопку открыть его внешним
       приложением. S1.1: проверяем результат IPC, fallback на https-сайт,
       при провале обоих — toast. */
    const row = el("div", { class: "ww-setup-model-row" }, [select, autoBtn]);
    if (loaded.length === 0 && downloadedOnly.length === 0) {
      const openBtn = /** @type {HTMLButtonElement} */ (el("button", {
        class: "btn btn-ghost ww-setup-open-lmstudio",
        type: "button",
      }, t("ww.setup.open_lmstudio")));
      openBtn.addEventListener("click", () => {
        void tryOpenLmStudio();
      });
      row.appendChild(openBtn);
    }
    return row;
  }

  /**
   * S1.1: best-effort открытие LM Studio в системном браузере / протокол-хэндлере.
   * Порядок попыток:
   *   1. lmstudio:// (если установлен protocol handler)
   *   2. https://lmstudio.ai/ (страница продукта)
   *   3. toast-ошибка если оба пути провалились
   * Внутри webContents `window.open()` без preload-метода не открывает
   * внешний браузер — поэтому полагаемся на api.system.openExternal.
   */
  async function tryOpenLmStudio() {
    const api = /** @type {any} */ (window.api);
    if (!api?.system?.openExternal) {
      /* Не Electron context (devserver / тест) — фоллбэк на window.open */
      const w = window.open("https://lmstudio.ai/", "_blank");
      if (!w) showWizardToast(t("ww.setup.open_lmstudio_fail"), "error");
      return;
    }
    try {
      const proto = await api.system.openExternal("lmstudio://");
      if (proto?.ok) return;
      const site = await api.system.openExternal("https://lmstudio.ai/");
      if (site?.ok) return;
      showWizardToast(t("ww.setup.open_lmstudio_fail"), "error");
    } catch {
      showWizardToast(t("ww.setup.open_lmstudio_fail"), "error");
    }
  }

  /* ─── Step 3: Done ────────────────────────────────────────────────────── */

  /**
   * Заменили статичный список инструкций на 3 action-карточки.
   * Каждая карточка: finish(persist+autoload) + переход на route через
   * клик по уже существующей sidebar-кнопке (showRoute не экспортирован,
   * но обработчик клика sidebar-icon делает ровно то, что нужно).
   */
  function buildDone() {
    /** @type {Array<{ route: string, primary?: boolean, key: string }>} */
    const actions = [
      { route: "library", primary: true, key: "library" },
      { route: "models", key: "models" },
      { route: "docs", key: "docs" },
    ];
    const grid = el("div", { class: "ww-done-actions" });
    for (const a of actions) {
      const card = /** @type {HTMLButtonElement} */ (el(
        "button",
        {
          type: "button",
          class: "ww-done-action" + (a.primary ? " ww-done-action-primary" : ""),
        },
        [
          el("div", { class: "ww-done-action-title" }, t(`ww.done.action.${a.key}.title`)),
          el("p", { class: "ww-done-action-desc" }, t(`ww.done.action.${a.key}.desc`)),
          el("span", { class: "ww-done-action-cta" }, t(`ww.done.action.${a.key}.cta`)),
        ]
      ));
      card.addEventListener("click", () => void finish({ goto: a.route }));
      grid.appendChild(card);
    }

    return el("div", { class: "ww-step ww-step-done" }, [
      el("div", { class: "ww-glow", "aria-hidden": "true" }),
      el("div", { class: "ww-hero-inner" }, [
        el("h2", { class: "ww-title" }, t("ww.done.title")),
        el("p", { class: "ww-sub" }, t("ww.done.sub")),
        grid,
      ]),
    ]);
  }

  /* ─── Footer ──────────────────────────────────────────────────────────── */

  function buildFooter() {
    const footer = el("div", { class: "ww-footer" });
    const skip = el("button", { class: "btn btn-ghost", type: "button" }, t("ww.skip"));
    /* A10: настоящий skip — confirm если пользователь уходит без модели
       со step >= 2 (значит он реально дошёл до setup). На step 0/1 не
       спрашиваем — там ещё нечего терять. */
    skip.addEventListener("click", async () => {
      if (STATE.step >= 2 && !STATE.chatModel) {
        const confirmed = await showConfirm(t("ww.skip.confirm_no_model"));
        if (!confirmed) return;
      }
      void finish();
    });
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
        /* A4: блок перехода со step 2 (Setup) если модель не выбрана.
           Без модели onboarding бессмыслен — у нас всё держится на
           preferences.chatModel. Показываем toast вместо disable, чтобы
           пользователь понял ПОЧЕМУ кнопка не сработала. */
        if (STATE.step === 2 && !STATE.chatModel) {
          showWizardToast(t("ww.setup.no_model_warn"), "info");
          return;
        }
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

  /**
   * @param {object} [opts]
   * @param {string} [opts.goto] data-route value to switch to after closing
   *                              (chat/library/docs/...). Если undefined —
   *                              просто закрываем wizard.
   */
  async function finish(opts) {
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

    // Авто-загрузка в LM Studio: если пользователь выбрал downloaded модель
    // (не loaded), грузим её фоном — чтобы при переходе в чат она уже
    // была доступна. Без блокировки UI: показываем тост, не ждём результата.
    if (STATE.chatModel && STATE.chatModelIsDownloaded) {
      const modelKey = STATE.chatModel;
      showWizardToast(t("ww.done.toast.loading", { model: modelKey }), "info");
      const offload = inferGpuOffloadForLmLoad(STATE.hardware);
      void window.api.lmstudio
        .load(modelKey, { gpuOffload: offload.gpuOffload ?? "max" })
        .then(() => {
          showGlobalToast(t("ww.done.toast.loaded", { model: modelKey }), "success");
        })
        .catch((e) => {
          showGlobalToast(t("ww.done.toast.load_fail", { model: modelKey, msg: errMsg(e) }), "error");
        });
    }

    overlay.remove();

    if (opts?.goto) {
      // showRoute() в router.js не экспортирован, но кликаем по уже
      // навешанному обработчику sidebar-кнопки — это единственный публичный
      // способ переключить route отсюда, и он вызывает applyI18n + mountRoute.
      const btn = /** @type {HTMLButtonElement | null} */ (
        document.querySelector(`.sidebar-icon[data-route="${opts.goto}"]`)
      );
      if (btn) btn.click();
    }
  }

  /**
   * Локальный toast внутри wizard overlay. Используется только пока wizard
   * ещё видим (например, между установкой preferences и закрытием).
   */
  function showWizardToast(text, kind = "info") {
    const node = el("div", { class: `ww-toast ww-toast-${kind}` }, text);
    overlay.appendChild(node);
    setTimeout(() => node.remove(), 4000);
  }

  /**
   * Глобальный toast в body — для feedback после закрытия wizard
   * (например, результат фоновой автозагрузки модели в LM Studio).
   */
  function showGlobalToast(text, kind = "success") {
    const node = el("div", { class: `ww-global-toast ww-global-toast-${kind}` }, text);
    document.body.appendChild(node);
    setTimeout(() => node.remove(), 5000);
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
