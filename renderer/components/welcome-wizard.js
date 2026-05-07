// @ts-check
import { el, clear } from "../dom.js";
import { t } from "../i18n.js";

const LEGACY_STORAGE_KEY = "bibliary_setup_done";
const ONBOARDING_VERSION = 3;
const STEP_COUNT = 4;

/**
 * Onboarding wizard v3 — 4 шага:
 *   0 Hero       → приветствие
 *   1 Connect    → health-check LM Studio + Chroma с visible feedback
 *   2 Setup      → hardware-info + инструкция «настройте модели вручную в Models».
 *                  Выбор моделей — задача страницы Models, не wizard'а.
 *   3 Done       → persist в preferences (onboardingDone) + 3 action-карточки
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

  /** @type {{ step: number, hardware: any, services: any, urlsTouched: { lm: boolean, ch: boolean } }} */
  const STATE = {
    step: 0,
    hardware: null,
    services: null,
    urlsTouched: { lm: false, ch: false },
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
    const chCard = el("div", { class: "ww-conn-card ww-conn-card-loading" }, t("ww.conn.probing"));
    grid.append(lmCard, chCard);
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
      chCard.className = "ww-conn-card ww-conn-card-loading";
      lmCard.textContent = t("ww.conn.probing");
      chCard.textContent = t("ww.conn.probing");
      const startedAt = Date.now();
      try {
        STATE.services = /** @type {any} */ (await window.api.system.probeServices());
        renderConnCard(lmCard, "lm", STATE.services.lmStudio);
        renderConnCard(chCard, "ch", STATE.services.chroma);
      } catch (e) {
        renderConnCard(lmCard, "lm", { online: false, url: "?", error: errMsg(e) });
        renderConnCard(chCard, "ch", { online: false, url: "?", error: errMsg(e) });
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

    const titleKey = kind === "lm" ? "ww.conn.lm.title" : "ww.conn.ch.title";
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
        placeholder: kind === "lm" ? "http://localhost:1234" : "http://localhost:8000",
      })
    );
    urlInput.addEventListener("input", () => {
      STATE.urlsTouched[kind === "lm" ? "lm" : "ch"] = true;
    });
    urlInput.addEventListener("change", async () => {
      const v = urlInput.value.trim().replace(/\/+$/, "");
      const prefKey = kind === "lm" ? "lmStudioUrl" : "chromaUrl";
      try {
        await window.api.preferences.set({ [prefKey]: v });
      } catch { /* ignore */ }
    });
    card.appendChild(urlInput);

    if (!isOnline) {
      const hintKey = kind === "lm" ? "ww.conn.lm.offlineHint" : "ww.conn.ch.offlineHint";
      card.appendChild(el("p", { class: "ww-conn-card-hint" }, t(hintKey)));

      /* Для Chroma: кнопка «Запустить автоматически» — пытается
       * spawn'нуть child-процесс через uvx/python. Если получится,
       * отрисуем cards заново через probeServices. */
      if (kind === "ch") {
        const autoBtn = el("button", {
          class: "ww-conn-auto-btn",
          type: "button",
        }, t("ww.conn.ch.autoStart"));
        autoBtn.addEventListener("click", async () => {
          autoBtn.disabled = true;
          autoBtn.textContent = t("ww.conn.ch.autoStarting");
          try {
            const res = await window.api.chroma.startEmbedded();
            if (res.ok) {
              autoBtn.textContent = res.alreadyRunning
                ? t("ww.conn.ch.autoAlready")
                : t("ww.conn.ch.autoStarted");
              /* Дать пользователю понять что нажать «Перепроверить» — Chroma
               * требует ~1-2 сек чтобы поднять HTTP сервер после spawn. */
            } else {
              autoBtn.disabled = false;
              autoBtn.textContent = t("ww.conn.ch.autoStart");
              const errLine = el("p", { class: "ww-conn-card-error" }, res.reason ?? "spawn failed");
              card.appendChild(errLine);
            }
          } catch (e) {
            autoBtn.disabled = false;
            autoBtn.textContent = t("ww.conn.ch.autoStart");
            const errLine = el("p", { class: "ww-conn-card-error" },
              e instanceof Error ? e.message : String(e));
            card.appendChild(errLine);
          }
        });
        card.appendChild(autoBtn);
      }
    }
  }

  /* ─── Step 2: Setup (Hardware + инструкция «как настроить модели») ────── */

  /**
   * Шаг чисто-информационный: hardware info + ссылка на страницу Models
   * для ручной настройки моделей по ролям.
   */
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

    wrap.appendChild(buildModelsHowto());

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
   * Карточка-инструкция «как настроить модели» — ручной выбор в Models.
   */
  function buildModelsHowto() {
    const block = el("div", { class: "ww-setup-block" }, [
      el("div", { class: "ww-setup-block-label" }, t("ww.setup.howto_label")),
      el("p", { class: "ww-p ww-p-muted ww-setup-model-hint" }, t("ww.setup.howto_hint")),
    ]);
    const row = el("div", { class: "ww-setup-howto" });
    row.appendChild(el("div", { class: "ww-setup-howto-card" }, [
      el("div", { class: "ww-setup-howto-title" }, t("ww.setup.howto.manual.title")),
      el("p", { class: "ww-setup-howto-desc" }, t("ww.setup.howto.manual.desc")),
    ]));
    block.appendChild(row);
    return block;
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
      { route: "settings", key: "settings" },
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
    /* v3: больше не блокируем skip и не спрашиваем «вы не выбрали модель?»,
       т.к. на шаге Setup моделей не выбирают (сноска: модель = Models page). */
    skip.addEventListener("click", () => { void finish(); });
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
          ? !STATE.services.lmStudio?.online && !STATE.services.chroma?.online
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
    /* URLs пишутся отдельно через urlInput.change handler.
       chatModel НЕ пишется в prefs — поле удалено из PreferencesSchema (Иt 8А);
       в v3 wizard вообще не выбирает модель (см. STATE / buildSetup). */
    try {
      await window.api.preferences.set(patch);
    } catch { /* ignore */ }
    try { localStorage.removeItem(LEGACY_STORAGE_KEY); } catch { /* ignore */ }

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
