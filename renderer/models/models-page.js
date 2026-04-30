// @ts-check
import { el, clear } from "../dom.js";
import { t, onLocaleChange } from "../i18n.js";
import {
  hardwareSummaryLine,
  inferGpuOffloadForLmLoad,
  offloadHintLine,
  pickHardwareAutoModel,
  suggestedContextLength,
} from "./gpu-offload-hint.js";

const REFRESH_MS = 8000;
const TOAST_TTL_MS = 5000;

/** Роли, отображаемые на странице моделей.
 * judge удалён — delta-extractor заменил отдельный judge-шаг 2 месяца назад.
 * Сама дисциплина judge-bst остаётся в Olympics как sanity check. */
const PIPELINE_ROLES = [
  "crystallizer",
  "evaluator",
  "translator",
  "ukrainian_specialist",
  "lang_detector",
  "vision_meta",
  "vision_ocr",
  "vision_illustration",
];

let pageRoot = null;
let refreshTimer = null;
let busy = false;
let preferencesUnsubscribe = null;
let localeUnsubscribe = null;

/** @type {unknown | null} */
let hardwareSnap = null;

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------

function showToast(msg, kind = "error") {
  const area = pageRoot?.querySelector(".mp-toast-area");
  if (!area) return;
  const div = el("div", { class: `toast toast-${kind}`, role: "status", "aria-live": "polite" }, msg);
  area.appendChild(div);
  setTimeout(() => div.remove(), TOAST_TTL_MS);
}

function errMsg(e) {
  return e instanceof Error ? e.message : String(e);
}

// ---------------------------------------------------------------------------
// Busy wrapper
// ---------------------------------------------------------------------------

async function withBusy(fn, errKey) {
  if (busy) {
    showToast(t("models.toast.busy"));
    return;
  }
  busy = true;
  setControlsDisabled(true);
  try {
    await fn();
    await refresh();
  } catch (e) {
    showToast(t(errKey, { msg: errMsg(e) }));
  } finally {
    busy = false;
    setControlsDisabled(false);
  }
}

function setControlsDisabled(disabled) {
  if (!pageRoot) return;
  pageRoot.querySelectorAll("button, select").forEach((el) => {
    if (disabled) {
      el.dataset.prevDisabled = el.disabled ? "1" : "0";
      el.disabled = true;
    } else {
      if (el.dataset.prevDisabled === "0") el.disabled = false;
      delete el.dataset.prevDisabled;
    }
  });
}

// ---------------------------------------------------------------------------
// Hardware strip
// ---------------------------------------------------------------------------

async function refreshHardware(force = false) {
  if (!pageRoot) return;
  const textEl = pageRoot.querySelector("#mp-hw-text");
  const recoEl = pageRoot.querySelector("#mp-hw-reco");
  if (textEl) textEl.textContent = t("models.hardware.loading");
  if (recoEl) recoEl.textContent = "";
  try {
    if (typeof window.api?.system?.hardware !== "function") {
      hardwareSnap = null;
      if (textEl) textEl.textContent = t("models.hardware.unknown");
      return;
    }
    hardwareSnap = await window.api.system.hardware(force);
    renderHardwareStrip();
  } catch (e) {
    hardwareSnap = null;
    if (textEl) textEl.textContent = t("models.hardware.error", { msg: errMsg(e) });
    if (recoEl) recoEl.textContent = "";
  }
}

function renderHardwareStrip() {
  if (!pageRoot) return;
  const textEl = pageRoot.querySelector("#mp-hw-text");
  const recoEl = pageRoot.querySelector("#mp-hw-reco");
  if (textEl) textEl.textContent = hardwareSummaryLine(hardwareSnap, t);
  if (recoEl) recoEl.textContent = offloadHintLine(hardwareSnap, t);
}

// ---------------------------------------------------------------------------
// Refresh
// ---------------------------------------------------------------------------

async function refresh() {
  if (!pageRoot) return;
  try {
    const [status, loaded, downloaded, roleMap] = await Promise.all([
      window.api.lmstudio.status(),
      window.api.lmstudio.listLoaded(),
      window.api.lmstudio.listDownloaded(),
      window.api.modelRoles.list(PIPELINE_ROLES),
    ]);
    renderStatus(status);
    renderLoaded(loaded);
    renderLoadFromDisk(downloaded, loaded);
    renderRoles(roleMap, loaded, downloaded);
    renderHardwareStrip();
  } catch (e) {
    showToast(t("models.toast.refresh_failed", { msg: errMsg(e) }));
  }
}

// ---------------------------------------------------------------------------
// Render: status
// ---------------------------------------------------------------------------

function renderStatus(status) {
  const node = pageRoot.querySelector("#mp-status-indicator");
  if (!node) return;
  node.textContent = status.online
    ? t("models.status.online", { ver: status.version ? ` v${status.version}` : "" })
    : t("models.status.offline");
  node.className = `mp-status-pill ${status.online ? "mp-status-online" : "mp-status-offline"}`;
}

// ---------------------------------------------------------------------------
// Render: loaded models
// ---------------------------------------------------------------------------

function renderLoaded(loaded) {
  const host = pageRoot.querySelector("#mp-loaded");
  if (!host) return;
  clear(host);
  if (loaded.length === 0) {
    host.appendChild(el("p", { class: "mp-empty" }, t("models.empty.no_loaded")));
    return;
  }
  for (const m of loaded) {
    const btn = el("button", { class: "btn btn-sm btn-ghost", type: "button" }, t("models.btn.unload"));
    btn.addEventListener("click", () => withBusy(
      () => window.api.lmstudio.unload(m.identifier),
      "models.toast.unload_failed"
    ));
    host.appendChild(el("div", { class: "mp-model-row mp-model-row-compact" }, [
      el("span", { class: "mp-model-name", title: m.modelKey }, m.modelKey),
      btn,
    ]));
  }
}

// ---------------------------------------------------------------------------
// Render: pick downloaded + load (compact)
// ---------------------------------------------------------------------------

/**
 * @param {Array<{ modelKey: string }>} downloaded
 * @param {Array<{ modelKey: string; identifier: string }>} loaded
 */
function renderLoadFromDisk(downloaded, loaded) {
  const host = pageRoot.querySelector("#mp-downloaded");
  if (!host) return;
  clear(host);

    const loadedKeys = new Set(loaded.map((l) => l.modelKey));
  if (downloaded.length === 0) {
    host.appendChild(el("p", { class: "mp-empty" }, t("models.empty.no_downloaded")));
    return;
  }

  const sorted = [...downloaded].sort((a, b) => a.modelKey.localeCompare(b.modelKey));

  const select = el("select", { id: "mp-pick-downloaded", class: "mp-load-select" });
  select.appendChild(el("option", { value: "" }, t("models.load.pick_placeholder")));
  for (const m of sorted) {
    const isLoaded = loadedKeys.has(m.modelKey);
    const opt = el(
      "option",
      { value: m.modelKey, disabled: isLoaded ? "disabled" : undefined },
      isLoaded ? `${m.modelKey} (${t("models.btn.loaded")})` : m.modelKey
    );
    select.appendChild(opt);
  }

  const loadBtn = el("button", { class: "btn btn-sm btn-primary", type: "button" }, t("models.btn.load"));

  function syncLoadEnabled() {
    const key = select.value;
    loadBtn.disabled = !key || loadedKeys.has(key);
  }
  select.addEventListener("change", syncLoadEnabled);
  syncLoadEnabled();

  loadBtn.addEventListener("click", () => {
    const key = select.value;
    if (!key || loadedKeys.has(key)) return;
    const offloadOpts = inferGpuOffloadForLmLoad(hardwareSnap);
    void withBusy(
      async () => {
        showToast(t("models.toast.loading", { key }), "success");
        await window.api.lmstudio.load(key, { gpuOffload: offloadOpts.gpuOffload ?? "max" });
        showToast(t("models.toast.loaded", { key }), "success");
      },
      "models.toast.load_failed"
    );
  });

  const autoBtn = el(
    "button",
    { class: "btn btn-sm btn-ghost mp-load-auto", type: "button", title: t("models.autoconf.title") },
    t("models.autoconf.btn")
  );
  autoBtn.addEventListener("click", () => {
    const pick = pickHardwareAutoModel(downloaded, hardwareSnap);
    if (!pick) {
      showToast(t("models.autoconf.empty"));
      return;
    }
    if (loadedKeys.has(pick.modelKey)) {
      showToast(t("models.autoconf.already_loaded", { key: pick.modelKey }), "success");
      return;
    }
    const offloadOpts = inferGpuOffloadForLmLoad(hardwareSnap);
    const ctx = suggestedContextLength(hardwareSnap);
    void withBusy(
      async () => {
        showToast(t("models.autoconf.loading", { key: pick.modelKey, reason: t(pick.reasonKey) }), "success");
        await window.api.lmstudio.load(pick.modelKey, {
          gpuOffload: offloadOpts.gpuOffload ?? "max",
          contextLength: ctx,
        });
        showToast(t("models.toast.loaded", { key: pick.modelKey }), "success");
      },
      "models.toast.load_failed"
    );
  });

  host.appendChild(el("div", { class: "mp-load-stack" }, [
    el("div", { class: "mp-load-row" }, [select, loadBtn]),
    el("div", { class: "mp-load-row mp-load-row-auto" }, [autoBtn]),
    el("p", { class: "mp-load-hint" }, t("models.load.hint")),
  ]));
}

// ---------------------------------------------------------------------------
// Render: role selectors
// ---------------------------------------------------------------------------

const ROLE_META = {
  crystallizer:         { labelKey: "models.role.crystallizer.label",         helpKey: "models.role.crystallizer.help" },
  evaluator:            { labelKey: "models.role.evaluator.label",            helpKey: "models.role.evaluator.help" },
  judge:                { labelKey: "models.role.judge.label",                helpKey: "models.role.judge.help" },
  translator:           { labelKey: "models.role.translator.label",           helpKey: "models.role.translator.help" },
  ukrainian_specialist: { labelKey: "models.role.ukrainian_specialist.label", helpKey: "models.role.ukrainian_specialist.help" },
  lang_detector:        { labelKey: "models.role.lang_detector.label",        helpKey: "models.role.lang_detector.help" },
  vision_meta:          { labelKey: "models.role.vision_meta.label",          helpKey: "models.role.vision_meta.help" },
  vision_ocr:           { labelKey: "models.role.vision_ocr.label",           helpKey: "models.role.vision_ocr.help" },
  vision_illustration:  { labelKey: "models.role.vision_illustration.label",  helpKey: "models.role.vision_illustration.help" },
};

/**
 * @param {unknown[]} roleMap
 * @param {Array<{ modelKey: string }>} loaded
 * @param {Array<{ modelKey: string }>} downloaded
 */
function renderRoles(roleMap, loaded, downloaded) {
  const host = pageRoot.querySelector("#mp-roles");
  if (!host) return;
  clear(host);

  const loadedKeys = new Set(loaded.map((l) => l.modelKey));
  const allModels = [
    ...loaded.map((m) => ({ key: m.modelKey, loaded: true })),
    ...downloaded
      .filter((d) => !loadedKeys.has(d.modelKey))
      .map((d) => ({ key: d.modelKey, loaded: false })),
  ];

  for (const entry of roleMap) {
    const role = /** @type {string} */ (entry.role);
    const meta = ROLE_META[role] ?? { labelKey: null, helpKey: null };
    const label = meta.labelKey ? t(meta.labelKey) : role;
    const help = meta.helpKey ? t(meta.helpKey) : "";

    const current = entry.resolved?.modelKey ?? "";
    const select = el("select", { class: "mp-role-select" });

    const autoOpt = el("option", { value: "" }, t("models.role.auto"));
    select.appendChild(autoOpt);

    for (const m of allModels) {
      const opt = el("option", { value: m.key }, m.loaded ? `● ${m.key}` : `○ ${m.key}`);
      if (m.key === current) opt.selected = true;
      select.appendChild(opt);
    }

    if (current && !allModels.some((m) => m.key === current)) {
      const opt = el("option", { value: current, selected: "selected" }, `${current} (${t("models.role.not_loaded")})`);
      select.appendChild(opt);
    }

    /* Visual-feedback: галочка "✓" появляется на 2 секунды после сохранения,
     * чтобы пользователь видел, что выбор записался в дефолтный профиль. */
    const savedTick = el("span", { class: "mp-role-saved-tick", style: "opacity:0" }, "✓");

    select.addEventListener("change", () => {
      const val = select.value || null;
      void window.api.preferences
        .set({ [entry.prefKey]: val })
        .then(() => {
          showToast(
            val
              ? t("models.toast.role_saved", { role: label, model: val })
              : t("models.toast.role_auto", { role: label }),
            "success",
          );
          /* Мигнуть галочкой возле дропдауна. */
          savedTick.style.opacity = "1";
          setTimeout(() => { savedTick.style.opacity = "0"; }, 2000);
        })
        .catch((err) => showToast(t("models.toast.role_save_failed", { msg: errMsg(err) })));
    });

    host.appendChild(el("div", { class: "mp-role-row mp-role-row-compact" }, [
      el("div", { class: "mp-role-info" }, [
        el("span", { class: "mp-role-label" }, label),
        help ? el("span", { class: "mp-role-help" }, help) : null,
      ].filter(Boolean)),
      el("div", { class: "mp-role-control" }, [select, savedTick]),
    ]));
  }
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

function buildHwStrip() {
  /* Компактная полоска с железом: свёрнута по умолчанию,
     разворачивается кликом на toggles. Пользователь знает своё железо —
     информация полезна, но не должна занимать экран. */
  const details = el("details", { class: "mp-hw-details" }, [
    el("summary", { class: "mp-hw-summary" }, [
      el("span", { id: "mp-hw-text", class: "mp-hw-text" }, t("models.hardware.loading")),
    ]),
    el("div", { class: "mp-hw-expanded" }, [
      el("div", { id: "mp-hw-reco", class: "mp-hw-reco" }, ""),
      el("button", { id: "mp-hw-refresh", class: "btn btn-ghost btn-sm", type: "button" }, t("models.hardware.rescan")),
    ]),
  ]);
  return el("div", { class: "mp-hw-strip" }, [details]);
}

function buildLayout() {
  return el("div", { class: "models-page" }, [
    el("div", { class: "mp-header" }, [
      el("div", { class: "mp-header-row" }, [
        el("h1", { class: "mp-title" }, t("models.header.title")),
        el("span", { id: "mp-status-indicator", class: "mp-status-pill mp-status-offline" }, t("models.status.offline")),
        (() => {
          const btn = el("button", { class: "btn btn-ghost btn-sm", type: "button", title: t("models.btn.refresh_all") }, "↻");
          btn.addEventListener("click", () => void refreshAll());
          return btn;
        })(),
      ]),
      el("p", { class: "mp-header-sub" }, t("models.header.sub_compact")),
    ]),

    /* Олимпиада — НАВЕРХУ: это главная точка входа для автонастройки. */
    buildOlympicsCard(),

    /* Железо — компактно, свёрнуто, не занимает место. */
    buildHwStrip(),

    el("div", { class: "mp-toast-area" }),

    el("div", { class: "mp-grid" }, [
      el("section", { class: "mp-card mp-card-compact" }, [
        el("h2", { class: "mp-card-title" }, t("models.card.loaded")),
        el("div", { id: "mp-loaded", class: "mp-model-list" }, t("models.card.loading")),
      ]),
      el("section", { class: "mp-card mp-card-compact" }, [
        el("h2", { class: "mp-card-title" }, t("models.card.from_disk")),
        el("div", { id: "mp-downloaded", class: "mp-model-list" }, t("models.card.loading")),
      ]),
    ]),

    el("section", { class: "mp-card mp-roles-card mp-card-compact" }, [
      el("h2", { class: "mp-card-title" }, t("models.roles.title")),
      el("p", { class: "mp-card-sub" }, t("models.header.sub_simple")),
      el("div", { id: "mp-roles", class: "mp-roles-list mp-roles-list-compact" }, t("models.card.loading")),
      ]),
    ]);
}

// ---------------------------------------------------------------------------
// Олимпиада: автонастройка ролей через реальный турнир локальных моделей
// ---------------------------------------------------------------------------

let olympicsBusy = false;
let olympicsDebugVisible = false;

/**
 * Простой helper: создать чекбокс, привязанный к pref-ключу. Загружает текущее
 * значение из preferences, при изменении сохраняет обратно. Без миганий.
 *
 * @param {string} prefKey — ключ в preferences (boolean)
 * @param {string=} domId  — id для DOM (опционально)
 */
function bindPrefCheckbox(prefKey, domId) {
  const cb = el("input", domId ? { id: domId, type: "checkbox" } : { type: "checkbox" });
  if (window.api?.preferences?.getAll) {
    void window.api.preferences.getAll().then((prefs) => {
      cb.checked = prefs?.[prefKey] === true;
    }).catch(() => { /* ignore */ });
  }
  cb.addEventListener("change", () => {
    if (window.api?.preferences?.set) {
      void window.api.preferences.set({ [prefKey]: cb.checked });
    }
  });
  return cb;
}

/**
 * Карточка Олимпиады. Главный экран — простой и понятный («для бабушек»):
 *   — большая кнопка «Запустить Олимпиаду»
 *   — после прогона: медальный зачёт + рекомендации (роли применяются автоматически)
 *   — все сложные опции спрятаны в `<details>` Advanced.
 */
function buildOlympicsCard() {
  return el("section", { class: "mp-card mp-card-compact mp-olympics-card" }, [
    el("h2", { class: "mp-card-title" }, t("models.olympics.title")),
    el("p", { class: "mp-card-sub" }, t("models.olympics.sub")),

    /* ── Главная зона: только большие кнопки. Никаких чекбоксов. ── */
    el("div", { class: "mp-olympics-actions" }, [
      el("button", {
        id: "mp-olympics-run",
        class: "btn btn-primary btn-lg",
        type: "button",
        onclick: () => void runOlympicsAndShow(),
      }, t("models.olympics.run")),
      el("button", {
        id: "mp-olympics-cancel",
        class: "btn btn-ghost",
        type: "button",
        style: "display:none",
        onclick: () => void cancelOlympics(),
      }, t("models.olympics.cancel")),
      el("button", {
        class: "btn btn-ghost btn-xs",
        type: "button",
        onclick: async () => {
          if (window.api?.arena?.clearOlympicsCache) {
            await window.api.arena.clearOlympicsCache();
          }
          resetOlympicsUI();
          showToast(t("models.olympics.cache_cleared"), "success");
        },
      }, "🗑 Очистить кэш"),
      el("button", {
        id: "mp-olympics-debug-toggle",
        class: "btn btn-ghost btn-xs",
        type: "button",
        onclick: () => {
          olympicsDebugVisible = !olympicsDebugVisible;
          const logEl = pageRoot?.querySelector("#mp-olympics-log");
          const toggleBtn = pageRoot?.querySelector("#mp-olympics-debug-toggle");
          if (logEl) logEl.style.display = olympicsDebugVisible ? "" : "none";
          if (toggleBtn) toggleBtn.textContent = olympicsDebugVisible ? "🔽 Скрыть протокол" : "📜 Протокол игр";
        },
      }, "📜 Протокол игр"),
    ]),

    /* Лог-панель: скрыта по умолчанию, появляется в процессе турнира. */
    el("div", { id: "mp-olympics-log", class: "mp-olympics-log", style: "display:none" }, ""),

    /* Зона результатов (медальный зачёт + рекомендации). Заполняется после прогона. */
    el("div", { id: "mp-olympics-results", class: "mp-olympics-results" }, ""),

    /* ── Advanced: всё, что нужно редко. Свёрнуто по умолчанию. ── */
    buildOlympicsAdvanced(),
  ]);
}

/**
 * Расширенные настройки Олимпиады — свёрнутый <details>.
 * Содержит:
 *   — переключатель «оптимум / чемпион» для авто-применения после турнира
 *   — фильтры (класс моделей, тестировать все)
 *   — экспертные тумблеры (per-role tuning, SDK)
 *   — выбор ролей для турнира (галочки)
 *   — экспорт/импорт профиля
 */
function buildOlympicsAdvanced() {
  return el("details", { class: "mp-olympics-advanced" }, [
    el("summary", { class: "mp-olympics-advanced-summary" }, t("models.olympics.advanced")),
    el("p", { class: "mp-olympics-advanced-hint" }, t("models.olympics.advanced.hint")),

    /* — Авто-применение: оптимум (по умолчанию) или чемпион — */
    el("label", { class: "mp-olympics-option" }, [
      bindPrefCheckbox("olympicsUseChampion", "mp-olympics-use-champion"),
      el("span", {}, t("models.olympics.advanced.use_champion")),
      el("span", { class: "mp-olympics-option-hint" }, t("models.olympics.advanced.use_champion_hint")),
    ]),

    /* — Фильтр класса + testAll — */
    el("label", { class: "mp-olympics-option" }, [
      bindPrefCheckbox("olympicsTestAll", "mp-olympics-testall"),
      el("span", {}, t("models.olympics.option.test_all")),
      el("span", { class: "mp-olympics-option-hint" }, t("models.olympics.option.test_all_hint")),
    ]),
    el("label", { class: "mp-olympics-option" }, [
      el("span", {}, t("models.olympics.option.weight_classes")),
      (() => {
        const sel = el("select", { id: "mp-olympics-classes", class: "mp-olympics-select" }, [
          el("option", { value: "s,m" }, "S+M (1–12B) — стандарт"),
          el("option", { value: "s" }, "Только S (1–5B) — слабое железо"),
          el("option", { value: "m,l" }, "M+L (5–30B) — сильное железо"),
          el("option", { value: "s,m,l" }, "S+M+L — широкий охват"),
        ]);
        sel.value = "s,m";
        if (window.api?.preferences?.getAll) {
          void window.api.preferences.getAll().then((prefs) => {
            const saved = typeof prefs?.olympicsWeightClasses === "string" ? prefs.olympicsWeightClasses : "s,m";
            if (saved && sel.querySelector(`option[value="${saved}"]`)) sel.value = saved;
          }).catch(() => { /* ignore */ });
        }
        sel.addEventListener("change", () => {
          if (window.api?.preferences?.set) {
            void window.api.preferences.set({ olympicsWeightClasses: sel.value });
          }
        });
        return sel;
      })(),
    ]),

    /* — Экспертные тумблеры — */
    el("label", { class: "mp-olympics-option" }, [
      bindPrefCheckbox("olympicsRoleLoadConfigEnabled", "mp-olympics-role-tuning"),
      el("span", {}, t("models.olympics.option.role_tuning")),
      el("span", { class: "mp-olympics-option-hint" }, t("models.olympics.option.role_tuning_hint")),
    ]),
    el("label", { class: "mp-olympics-option" }, [
      bindPrefCheckbox("olympicsUseLmsSDK", "mp-olympics-use-sdk"),
      el("span", {}, t("models.olympics.option.use_sdk")),
      el("span", { class: "mp-olympics-option-hint" }, t("models.olympics.option.use_sdk_hint")),
    ]),

    /* — Какие роли тестировать (по умолчанию: все) — */
    el("div", { class: "mp-olympics-roles" }, [
      el("span", { class: "mp-olympics-roles-label" }, t("models.olympics.advanced.roles_label")),
      el("p", { class: "mp-olympics-roles-hint" }, t("models.olympics.advanced.roles_hint")),
      el("div", { class: "mp-olympics-roles-grid" },
        ALL_ROLES.map((r) =>
          el("label", { class: "mp-olympics-role-check" }, [
            el("input", { type: "checkbox", "data-role": r.role, checked: true }),
            el("span", {}, r.label),
          ])
        ),
      ),
    ]),

    /* — Профиль: экспорт / импорт — */
    el("div", { class: "mp-olympics-profile-row" }, [
      el("button", {
        class: "btn btn-ghost btn-sm",
        type: "button",
        title: t("models.olympics.advanced.export_hint"),
        onclick: () => void exportProfileViaDialog(),
      }, t("models.olympics.advanced.export")),
      el("button", {
        class: "btn btn-ghost btn-sm",
        type: "button",
        title: t("models.olympics.advanced.import_hint"),
        onclick: () => void importProfileViaDialog(),
      }, t("models.olympics.advanced.import")),
      el("button", {
        class: "btn btn-ghost btn-xs",
        type: "button",
        title: "Скачать профиль как JSON-файл (без диалога)",
        onclick: () => void downloadProfileAsBlob(),
      }, "↓ JSON"),
    ]),
    el("p", { class: "mp-olympics-advanced-hint" }, t("models.olympics.advanced.export_hint")),
  ]);
}

// ---------------------------------------------------------------------------
// Profile export / import
// ---------------------------------------------------------------------------

/** Экспорт через нативный Save-dialog (preload → IPC → Electron dialog). */
async function exportProfileViaDialog() {
  if (!window.api?.preferences?.exportProfile) {
    showToast(t("models.olympics.advanced.export_unavailable"), "error");
    return;
  }
  try {
    const res = await window.api.preferences.exportProfile();
    if (!res?.path) return;
    showToast(t("models.olympics.advanced.export_done", { path: res.path }), "success");
      } catch (e) {
    showToast(errMsg(e), "error");
  }
}

/** Импорт через нативный Open-dialog. */
async function importProfileViaDialog() {
  if (!window.api?.preferences?.importProfile) {
    showToast(t("models.olympics.advanced.import_unavailable"), "error");
    return;
  }
  try {
    const res = await window.api.preferences.importProfile();
    if (!res?.path) return;
    showToast(t("models.olympics.advanced.import_done", { keys: String(res.appliedKeys.length) }), "success");
    await refresh();
      } catch (e) {
    showToast(errMsg(e), "error");
  }
}

/**
 * Скачать профиль как JSON-blob — renderer-only путь без файлового диалога.
 * Полезно когда у пользователя нет прав на запись или хочется быстро поделиться.
 */
async function downloadProfileAsBlob() {
  if (!window.api?.preferences?.getProfile) return;
  try {
    const file = await window.api.preferences.getProfile();
    const blob = new Blob([JSON.stringify(file, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
    a.href = url;
    a.download = `bibliary-profile-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (e) {
    showToast(errMsg(e), "error");
  }
}

/** Добавляет строку в протокол Олимпиады (накопительный).
 *  Панель всегда показывается когда есть контент — это живой репортаж для пользователя. */
function appendOlympicsLog(logEl, text, level = "info") {
  if (!logEl) return;
  logEl.style.display = "";
  olympicsDebugVisible = true;
  const toggleBtn = pageRoot?.querySelector("#mp-olympics-debug-toggle");
  if (toggleBtn) toggleBtn.textContent = "🔽 Скрыть протокол";
  const entry = el("div", { class: `mp-olympics-log-entry mp-olympics-log-${level}` }, text);
  logEl.appendChild(entry);
  logEl.scrollTop = logEl.scrollHeight;
}

/** Полный сброс видимого UI олимпиады: протокол + результаты → чистый экран. */
function resetOlympicsUI() {
  const logEl = pageRoot?.querySelector("#mp-olympics-log");
  const resultsEl = pageRoot?.querySelector("#mp-olympics-results");
  if (logEl) { clear(logEl); logEl.style.display = "none"; }
  if (resultsEl) clear(resultsEl);
  olympicsDebugVisible = false;
  const toggleBtn = pageRoot?.querySelector("#mp-olympics-debug-toggle");
  if (toggleBtn) toggleBtn.textContent = "📜 Протокол игр";
}

async function runOlympicsAndShow() {
  if (olympicsBusy) return;
  if (!window.api?.arena?.runOlympics) {
    showToast(t("models.olympics.unavailable"), "error");
    return;
  }
  olympicsBusy = true;
  setOlympicsButtons(true);
  resetOlympicsUI();
  const logEl = pageRoot?.querySelector("#mp-olympics-log");
  const resultsEl = pageRoot?.querySelector("#mp-olympics-results");
  appendOlympicsLog(logEl, t("models.olympics.starting"));

  let unsub = null;
  if (typeof window.api.arena.onOlympicsProgress === "function") {
    unsub = window.api.arena.onOlympicsProgress((ev) => {
      if (!ev || typeof ev !== "object") return;
      const e = ev;
      if (e.type === "olympics.start") {
        const n = e.models?.length ?? 0;
        const d = e.disciplines?.length ?? 0;
        appendOlympicsLog(logEl, `⚡ На арену выходят ${n} участников. Впереди ${d} испытаний. Да начнутся Игры!`, "mid");
      } else if (e.type === "olympics.vram_guard") {
        const gb = Number(e.estimatedGB ?? 0).toFixed(1);
        appendOlympicsLog(logEl, `⚠ Служитель арены: памяти немного (${gb} ГБ), проверяем участников по одному.`, "mid");
      } else if (e.type === "olympics.model.loading") {
        appendOlympicsLog(logEl, `🏃 Участник «${e.model}» выходит на дорожку...`, "info");
      } else if (e.type === "olympics.model.loaded") {
        const dur = ((e.loadTimeMs ?? 0) / 1000).toFixed(1);
        appendOlympicsLog(logEl, `  ✅ «${e.model}» занял место на арене (вышел за ${dur}с)`, "mid");
      } else if (e.type === "olympics.model.unloaded") {
        appendOlympicsLog(logEl, `  🚪 «${e.model}» уходит с арены. Благодарим за участие!`, "info");
      } else if (e.type === "olympics.model.load_failed") {
        const reason = String(e.reason ?? "").slice(0, 80);
        appendOlympicsLog(logEl, `  ❌ «${e.model}» не вышел на арену — ${reason}`, "bad");
      } else if (e.type === "olympics.discipline.start") {
        appendOlympicsLog(logEl, `🏛 Испытание «${e.discipline}» — участники встают на старт!`, "mid");
      } else if (e.type === "olympics.model.done") {
        const score = Math.round((e.score ?? 0) * 100);
        const dur = ((e.durationMs ?? 0) / 1000).toFixed(1);
        const ok = e.ok !== false;
        const errorHint = e.error ? ` (${e.error.slice(0, 60)})` : "";
        let icon, msg, level;
        if (score >= 70) {
          icon = "🥇"; msg = "блестящий результат"; level = "good";
        } else if (score >= 40) {
          icon = "🏅"; msg = "держится достойно"; level = "mid";
        } else {
          icon = "😓"; msg = "не его сегодня день"; level = "bad";
        }
        appendOlympicsLog(logEl, `  ${icon} «${e.model}» — ${msg}! ${score}/100  (${dur}с)${errorHint}`, ok ? level : "bad");
      } else if (e.type === "olympics.discipline.done") {
        if (e.champion) {
          appendOlympicsLog(logEl, `  🌿 Лавровый венок: «${e.champion}» — победитель этого испытания!`, "good");
        } else {
          appendOlympicsLog(logEl, `  😞 В этом испытании достойного победителя не нашлось.`, "bad");
        }
      }
    });
  }

  /* Считываем опции из UI. */
  const testAllEl = pageRoot?.querySelector("#mp-olympics-testall");
  const classesEl = pageRoot?.querySelector("#mp-olympics-classes");
  const testAll = testAllEl?.checked === true;
  const wcStr = classesEl?.value ?? "s,m";
  const weightClasses = wcStr.split(",").map((s) => s.trim()).filter(Boolean);
  /* Per-role filter: только отмеченные роли. */
  const roleChecks = pageRoot?.querySelectorAll(".mp-olympics-role-check input[data-role]") ?? [];
  const roles = [];
  for (const cb of roleChecks) {
    if (cb.checked) roles.push(cb.getAttribute("data-role"));
  }
  if (roles.length === 0) {
    const msg = "Выбери хотя бы одну роль для Олимпиады";
    appendOlympicsLog(logEl, `✗ ${msg}`, "bad");
    showToast(msg, "error");
    olympicsBusy = false;
    setOlympicsButtons(false);
    if (typeof unsub === "function") unsub();
    return;
  }

  try {
    const report = await window.api.arena.runOlympics({ testAll, weightClasses, roles });
    appendOlympicsLog(logEl, t("models.olympics.done", { ms: ((report.totalDurationMs ?? 0) / 1000).toFixed(1) }), "good");
    renderOlympicsReport(report);
    showToast(t("models.olympics.success"), "success");
    /* ── Авто-применение ролей. По умолчанию применяется «оптимум» (лучшее
     *    соотношение качества и скорости). В Advanced пользователь может
     *    включить флаг "olympicsUseChampion" — тогда применится «чемпион». */
    await autoApplyOlympicsRecommendations(report);
  } catch (e) {
    const msg = errMsg(e);
    const isAbort = msg.includes("aborted") || msg.includes("abort") || msg.includes("cancel");
    if (isAbort) {
      resetOlympicsUI();
    } else {
      appendOlympicsLog(logEl, `✗ ${msg}`, "bad");
      showToast(t("models.olympics.failed", { reason: msg }), "error");
      if (resultsEl) resultsEl.appendChild(el("div", { class: "mp-error" }, msg));
    }
  } finally {
    olympicsBusy = false;
    setOlympicsButtons(false);
    if (typeof unsub === "function") unsub();
  }
}

async function cancelOlympics() {
  if (!olympicsBusy) return;
  if (!window.api?.arena?.cancelOlympics) return;
  try {
    await window.api.arena.cancelOlympics();
    showToast(t("models.olympics.cancelled"), "success");
  } catch (e) {
    showToast(errMsg(e), "error");
  }
}

function setOlympicsButtons(running) {
  const runBtn = pageRoot?.querySelector("#mp-olympics-run");
  const cancelBtn = pageRoot?.querySelector("#mp-olympics-cancel");
  if (runBtn) runBtn.disabled = running;
  if (cancelBtn) cancelBtn.style.display = running ? "" : "none";
}

/** Человекочитаемое имя pref-ключа для UI. */
function prefKeyLabel(k) {
  const MAP = {
    extractorModel:           "Кристаллизатор",
    judgeModel:               "Критик",
    evaluatorModel:           "Оценщик книг",
    translatorModel:          "Переводчик",
    langDetectorModel:        "Определитель языка",
    ukrainianSpecialistModel: "Украинская модель",
    visionModelKey:           "Vision (обложки / OCR / иллюстрации)",
  };
  return MAP[k] ?? k;
}

/** Иконка роли для UI. */
function roleIcon(prefKey) {
  const MAP = {
    extractorModel:           "💎",
    judgeModel:               "⚖️",
    evaluatorModel:           "📚",
    translatorModel:          "🌐",
    langDetectorModel:        "🔤",
    ukrainianSpecialistModel: "🇺🇦",
    visionModelKey:           "👁️",
  };
  return MAP[prefKey] ?? "🤖";
}

/**
 * Роли для чекбоксов «какие роли тестировать в Олимпиаде».
 * Должно совпадать с `PIPELINE_ROLES` (порядок важен — таб-бар результатов
 * следует тому же порядку). Legacy `vision` намеренно убрана: новые
 * vision_meta/vision_ocr/vision_illustration покрывают её полностью.
 */
const ALL_ROLES = [
  { role: "crystallizer",         label: "💎 Кристаллизатор" },
  { role: "evaluator",            label: "📚 Оценщик" },
  { role: "judge",                label: "⚖️ Судья" },
  { role: "translator",           label: "🌐 Переводчик" },
  { role: "ukrainian_specialist", label: "🇺🇦 Укр." },
  { role: "lang_detector",        label: "🔤 Язык" },
  { role: "vision_meta",          label: "📖 Vision: обложки" },
  { role: "vision_ocr",           label: "🖨️ Vision: OCR страниц" },
  { role: "vision_illustration",  label: "🖼️ Vision: иллюстрации" },
];

/**
 * Литературные названия для ролей (для табов).
 * Технически точные, но человекочитаемые.
 *
 * Намеренно русские: страница Олимпиады стилизована под древнегреческий
 * нарратив, и часть атмосферных описаний дисциплин не переводится через t().
 * Если потребуется английская локаль — переписать на ключи `models.olympics.role.*`.
 */
const ROLE_HUMAN_LABEL = {
  crystallizer:         { icon: "💎", title: "Кристаллизатор знаний", subtitle: "извлечение фактов и связей" },
  evaluator:            { icon: "📚", title: "Литературный критик", subtitle: "оценка качества книги" },
  judge:                { icon: "⚖️", title: "Судья",               subtitle: "выбор лучшего ответа" },
  translator:           { icon: "🌐", title: "Переводчик",          subtitle: "межъязыковая адаптация" },
  lang_detector:        { icon: "🔤", title: "Лингвист-детектор",   subtitle: "определение языка" },
  ukrainian_specialist: { icon: "🇺🇦", title: "Знаток украинского", subtitle: "генерация на укр." },
  vision:               { icon: "👁️", title: "Зрение (общее)",     subtitle: "legacy" },
  vision_meta:          { icon: "📖", title: "Хранитель обложек",   subtitle: "метаданные книги" },
  vision_ocr:           { icon: "🖨️", title: "Распознаватель текста", subtitle: "OCR сканированных страниц" },
  vision_illustration:  { icon: "🖼️", title: "Иллюстратор",         subtitle: "описание картинок" },
};

/**
 * Литературные названия дисциплин: short — короткий заголовок таба-вкладки;
 * long — полное название для содержимого аккордеона.
 *
 * Стиль: «спортивная номинация древней Греции в современной обработке».
 * Технически точно — но можно понять без чтения кода.
 */
const DISCIPLINE_HUMAN = {
  /* — Кристаллизатор — */
  "crystallizer-rover":              { short: "Марсоход",          long: "Извлечение фактов о миссии Curiosity" },
  "crystallizer-production-delta":   { short: "Боевая схема",      long: "Извлечение DeltaKnowledge точно по продакшн-схеме (essence + cipher + relations)" },
  "crystallizer-ru-mendeleev":       { short: "Менделеев",         long: "Извлечение знаний из русскоязычного текста (периодический закон)" },

  /* — Оценщик — */
  "evaluator-clrs":                  { short: "CLRS",              long: "Оценка эталона CLRS — должна быть высокой (8-10)" },
  "evaluator-noise":                 { short: "Шум",               long: "Оценка мусорного фрагмента — должна быть низкой (0-2)" },

  /* — Переводчик — */
  "translator-en-ru":                { short: "Англ → Рус",        long: "Перевод английского технического текста на русский (главный путь импорта)" },

  /* — Знаток украинского — */
  "ukrainian-uk-write":              { short: "Письмо",            long: "Создание связного текста на украинском с правильной орфографией" },

  /* — Судья — */
  "judge-bst":                       { short: "BST",               long: "Выбор правильного ответа о сложности BST (A-вариант)" },

  /* — Детектор языка — */
  "lang-detect-uk":                  { short: "Современный укр.",  long: "Распознавание современного украинского технического текста" },
  "lang-detect-en":                  { short: "Английский",        long: "Контрольная проверка распознавания английского" },

  /* — Зрение — */
  "vision_meta-strict-json":         { short: "Строгий JSON",      long: "Дисциплина формата: vision-модель возвращает чистый JSON без prose" },
  "vision_meta-cover-en":            { short: "Обложка EN",        long: "JSON-метаданные обложки английской книги" },
  "vision_ocr-plain-text":           { short: "Plain text",        long: "Дисциплина формата: OCR должен дать чистый текст без markdown/JSON" },
  "vision_illustration-with-context":{ short: "С контекстом",      long: "Описание иллюстрации с привязкой к теме главы (для RAG-индекса)" },
};

/**
 * Получить литературное название дисциплины по её id.
 * Если маппинга нет — fallback на сам id.
 */
function disciplineHuman(id) {
  return DISCIPLINE_HUMAN[id] || { short: id, long: id };
}

/** Литературное название роли. */
function roleHuman(role) {
  return ROLE_HUMAN_LABEL[role] || { icon: "🤖", title: role, subtitle: "" };
}

function renderOlympicsReport(report) {
  const root = pageRoot?.querySelector("#mp-olympics-results");
  if (!root) return;
  clear(root);

  /* ── Warnings (мало моделей / рекомендации по загрузке) ── */
  const warnings = report.warnings ?? [];
  const availCount = report.availableModelCount ?? 0;
  const usedCount  = (report.models ?? []).length;

  if (warnings.length > 0) {
    const warnMsgs = warnings.map((w) => {
      if (w === "few_models_1") return t("models.olympics.warning.only1", { count: usedCount, avail: availCount });
      if (w === "few_models_2") return t("models.olympics.warning.only2", { count: usedCount, avail: availCount });
      if (w === "few_models_3") return t("models.olympics.warning.only3", { count: usedCount, avail: availCount });
      if (w === "recommend_download") return t("models.olympics.warning.recommend_download");
      if (w.startsWith("all_failed:")) return t("models.olympics.warning.all_failed", { discipline: w.slice(11) });
      if (w.startsWith("role_no_winner:")) return `Роль «${w.slice(15)}» — нет уверенного победителя.`;
      return w;
    });
    const warnBox = el("div", { class: "mp-olympics-warning" }, [
      el("div", { class: "mp-olympics-warning-title" }, "⚠ " + t("models.olympics.warning.title")),
      ...warnMsgs.map((m) => el("div", { class: "mp-olympics-warning-msg" }, m)),
      /* Подсказка по загрузке моделей — только если мало кандидатов */
      (availCount < 4 || usedCount < 3)
        ? el("div", { class: "mp-olympics-warning-hint" }, [
            el("span", {}, t("models.olympics.warning.download_hint")),
            el("a", {
              href: "https://lmstudio.ai/models",
              target: "_blank",
              class: "mp-link",
            }, "lmstudio.ai/models"),
            el("span", {}, t("models.olympics.warning.download_hint2")),
          ])
        : null,
    ].filter(Boolean));
    root.appendChild(warnBox);
  }

  /* ── Медальный зачёт с BT-MLE и capabilities ── */
  const caps = report.modelCapabilities ?? {};
  const btScores = report.btScores ?? {};

  function capBadges(modelKey) {
    const c = caps[modelKey];
    if (!c) return "";
    const badges = [];
    if (c.vision) badges.push("👁");
    if (c.reasoning) badges.push("🧠");
    if (c.toolUse) badges.push("🔧");
    if (c.paramsString) badges.push(c.paramsString);
    return badges.length > 0 ? ` [${badges.join(" ")}]` : "";
  }

  const medalsBox = el("div", { class: "mp-olympics-medals" }, [
    el("h3", {}, t("models.olympics.leaderboard")),
    ...((report.medals ?? []).map((row, i) => {
      const icon = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : "  ";
      const btScore = btScores[row.model];
      const btStr = typeof btScore === "number" ? ` · BT: ${Math.round(btScore * 100)}` : "";
      return el("div", { class: "mp-olympics-medal-row" }, [
        el("span", { class: "mp-olympics-medals-rank" }, icon),
        el("span", { class: "mp-olympics-medal-model" }, row.model + capBadges(row.model)),
        el("span", { class: "mp-olympics-medals-cell" }, `${row.gold}🥇 ${row.silver}🥈 ${row.bronze}🥉${btStr}`),
        el("span", { class: "mp-olympics-medals-time" }, `${(row.totalDurationMs / 1000).toFixed(1)}s`),
      ]);
    })),
  ]);
  root.appendChild(medalsBox);

  /* ── Результаты по дисциплинам ──
   *
   * UI: <details> ─ табы по ролям ─ <details> per discipline.
   *
   *   ▶ Результаты испытаний (свёрнут по умолчанию)
   *      [💎 Кристаллизатор] [📚 Критик] [⚖️ Судья] [🌐 Переводчик] ...
   *      ┌──────────────────────────────────────────┐
   *      │ ▶ Марсоход — Извлечение фактов Curiosity │
   *      │ ▶ Аполлон-11 — Глубокое извлечение       │
   *      │ ▼ Боевая схема — DeltaKnowledge          │
   *      │     🥇 model-A — 95/100 (1.7s) eff 0.5   │
   *      │     🥈 model-B — 90/100 (2.5s) eff 0.4   │
   *      └──────────────────────────────────────────┘
   */
  const allDisciplines = report.disciplines ?? [];

  /* Группируем дисциплины по роли. */
  const byRole = new Map();
  for (const d of allDisciplines) {
    if (!byRole.has(d.role)) byRole.set(d.role, []);
    byRole.get(d.role).push(d);
  }

  const disciplinesRoot = el("details", { class: "mp-olympics-disciplines" });
  disciplinesRoot.appendChild(
    el("summary", { class: "mp-olympics-disciplines-summary" }, [
      el("span", {}, t("models.olympics.disciplines")),
      el("span", { class: "mp-olympics-disciplines-count" }, ` (${allDisciplines.length} испытаний)`),
    ]),
  );

  /* Внутренний контейнер контента (показывается при раскрытии details). */
  const inner = el("div", { class: "mp-olympics-disciplines-inner" });

  /* ── Табы по ролям ── */
  const tabsBar = el("div", { class: "mp-olympics-tabs", role: "tablist" });
  const panels = el("div", { class: "mp-olympics-tabs-panels" });
  const roleKeys = [...byRole.keys()];

  /** Отрисовка одной дисциплины как раскрывающегося аккордеона. */
  function renderDiscipline(d) {
    const sorted = [...(d.perModel ?? [])].sort((a, b) => {
      if (Math.abs(a.score - b.score) > 0.005) return b.score - a.score;
      return a.durationMs - b.durationMs;
    });
    const podium = ["🥇", "🥈", "🥉"];
    const human = disciplineHuman(d.discipline);
    /* Краткая статистика для свёрнутого вида: лучший score, count моделей. */
    const top = sorted[0];
    const topScore = top ? Math.round(top.score * 100) : 0;
    const summaryStat = top
      ? ` — лучший: ${topScore}/100 (${top.model})`
      : ` — нет результатов`;

    const summaryChildren = [
      el("span", { class: "mp-olympics-discipline-tab-short" }, human.short),
      el("span", { class: "mp-olympics-discipline-tab-long" }, ` · ${human.long}`),
      el("span", { class: "mp-olympics-discipline-tab-stat" }, summaryStat),
    ];
    if (d.thinkingFriendly) {
      summaryChildren.push(el(
        "span",
        {
          class: "mp-olympics-thinking-badge",
          title: "Дисциплина оптимизирована для thinking-моделей: efficiency не штрафует за время reasoning-блока",
        },
        " 🧠 thinking-friendly",
      ));
    }

    const det = el("details", { class: "mp-olympics-discipline" }, [
      el("summary", { class: "mp-olympics-discipline-summary" }, summaryChildren),
      el("div", { class: "mp-olympics-discipline-meta" }, [
        el("span", { class: "mp-olympics-discipline-id" }, `id: ${d.discipline}`),
        d.description ? el("span", { class: "mp-olympics-discipline-desc" }, ` · ${d.description}`) : null,
      ].filter(Boolean)),
      ...sorted.map((p, i) => {
        const score = Math.round(p.score * 100);
        const level = score >= 70 ? "good" : score >= 40 ? "mid" : "bad";
        const errHint = p.error ? ` ✗ ${p.error.slice(0, 50)}` : "";
        const effHint = p.efficiency > 0 ? ` · eff ${p.efficiency.toFixed(1)}` : "";
        const sampleEl = (p.sample && score >= 30)
          ? el("div", { class: "mp-olympics-discipline-sample" }, `"${p.sample.slice(0, 120)}…"`)
          : null;
        return el("div", { class: `mp-olympics-discipline-row mp-olympics-row-${level}` }, [
          el("span", {}, `${podium[i] ?? "  "} ${p.model} — ${score}/100  (${(p.durationMs / 1000).toFixed(1)}s)${effHint}${errHint}`),
          sampleEl,
        ].filter(Boolean));
      }),
    ]);
    return det;
  }

  /** Активировать вкладку по индексу. */
  const tabButtons = [];
  const tabPanels = [];

  function setActiveTab(idx) {
    for (let i = 0; i < tabButtons.length; i++) {
      tabButtons[i].classList.toggle("active", i === idx);
      tabButtons[i].setAttribute("aria-selected", i === idx ? "true" : "false");
      tabPanels[i].style.display = i === idx ? "" : "none";
    }
  }

  roleKeys.forEach((role, idx) => {
    const ds = byRole.get(role);
    const human = roleHuman(role);
    const btn = el("button", {
      class: "mp-olympics-tab",
      type: "button",
      role: "tab",
      title: human.subtitle,
    }, [
      el("span", { class: "mp-olympics-tab-icon" }, human.icon),
      el("span", { class: "mp-olympics-tab-title" }, ` ${human.title}`),
      el("span", { class: "mp-olympics-tab-count" }, ` (${ds.length})`),
    ]);
    btn.addEventListener("click", () => setActiveTab(idx));
    tabsBar.appendChild(btn);
    tabButtons.push(btn);

    const panel = el("div", {
      class: "mp-olympics-tab-panel",
      role: "tabpanel",
    }, [
      el("div", { class: "mp-olympics-tab-panel-subtitle" }, human.subtitle),
      ...ds.map(renderDiscipline),
    ]);
    panels.appendChild(panel);
    tabPanels.push(panel);
  });

  inner.appendChild(tabsBar);
  inner.appendChild(panels);
  disciplinesRoot.appendChild(inner);
  if (tabButtons.length > 0) setActiveTab(0);
  root.appendChild(disciplinesRoot);

  /* ── Рекомендации (по ролям) ── */
  const recs = report.recommendations ?? {};
  const byScore = report.recommendationsByScore ?? {};
  const aggregates = report.roleAggregates ?? [];
  const recsKeys = Object.keys(recs);
  const byScoreKeys = Object.keys(byScore);

  if (recsKeys.length === 0 && byScoreKeys.length === 0) {
    root.appendChild(el("div", { class: "mp-olympics-no-recs" }, t("models.olympics.no_recommendations")));
    return;
  }

  /* Одна кнопка вместо двух: «Распределить роли». По умолчанию применяет
   * «оптимум»; если в Advanced включён флаг `olympicsUseChampion` — применит
   * «чемпиона». Auto-apply уже произошёл сразу после run (см. autoApplyOlympicsRecommendations).
   * Эта кнопка нужна для повторного применения если пользователь поменял флаг
   * или вручную правил роли и хочет вернуть рекомендации. */
  let useChampion = false;
  const champBadge = el("span", { class: "mp-olympics-champion-badge", style: "display:none" }, "🏆");
  const distributeBtn = el("button", {
    class: "btn btn-primary",
    type: "button",
    disabled: recsKeys.length === 0 && byScoreKeys.length === 0,
    onclick: () => {
      const target = useChampion ? byScore : recs;
      void applyRecommendations(target);
    },
  }, [
    el("span", { class: "mp-olympics-distribute-label" }, t("models.olympics.distribute")),
    champBadge,
    el("span", { class: "mp-olympics-distribute-count" },
      ` (${(useChampion ? byScoreKeys : recsKeys).length})`),
  ]);

  /* Подхватываем актуальное значение флага useChampion из prefs. */
  if (window.api?.preferences?.getAll) {
    void window.api.preferences.getAll().then((prefs) => {
      useChampion = prefs?.olympicsUseChampion === true;
      const lbl = distributeBtn.querySelector(".mp-olympics-distribute-label");
      const cnt = distributeBtn.querySelector(".mp-olympics-distribute-count");
      if (lbl) lbl.textContent = useChampion
        ? t("models.olympics.distribute_champion")
        : t("models.olympics.distribute");
      if (cnt) cnt.textContent = ` (${(useChampion ? byScoreKeys : recsKeys).length})`;
      champBadge.style.display = useChampion ? "" : "none";
    }).catch(() => { /* ignore */ });
  }

  const recsHeader = el("div", { class: "mp-olympics-recs-header" }, [
    el("h3", {}, t("models.olympics.recommendations")),
    el("p", { class: "mp-card-sub" }, t("models.olympics.distribute_after_run")),
    el("div", { class: "mp-olympics-apply-buttons" }, [distributeBtn]),
  ]);
  root.appendChild(recsHeader);

  /* По одной карточке на роль. Внутри — top-3 модели + объяснение, какая
     стала optimum/champion и почему. */
  for (const agg of aggregates) {
    const top = (agg.perModel ?? []).slice(0, 3);
    const optimumStats = agg.optimum ? agg.perModel.find((p) => p.model === agg.optimum) : null;
    const championStats = agg.champion ? agg.perModel.find((p) => p.model === agg.champion) : null;

    const card = el("div", { class: "mp-olympics-role-card" }, [
      el("div", { class: "mp-olympics-role-header" }, [
        el("span", { class: "mp-olympics-role-icon" }, roleIcon(agg.prefKey)),
        el("span", { class: "mp-olympics-role-name" }, prefKeyLabel(agg.prefKey)),
        el("span", { class: "mp-olympics-role-disciplines" },
          `${(agg.disciplines ?? []).length} ${t("models.olympics.role.tests")}`),
      ]),

      /* Top-3 модели со средними показателями + capabilities */
      el("div", { class: "mp-olympics-role-top" },
        top.map((p, i) => {
          const podium = ["🥇", "🥈", "🥉"][i] ?? "  ";
          const score = Math.round(p.avgScore * 100);
          const minScore = Math.round(p.minScore * 100);
          const isChamp = p.model === agg.champion;
          const isOpt = p.model === agg.optimum;
          const tags = [];
          if (isChamp) tags.push(el("span", { class: "mp-olympics-tag mp-olympics-tag-champion" }, "ЧЕМПИОН"));
          if (isOpt) tags.push(el("span", { class: "mp-olympics-tag mp-olympics-tag-optimum" }, "ОПТИМУМ"));
          const capStr = capBadges(p.model);
          const btScore = btScores[p.model];
          const btStr = typeof btScore === "number" ? ` BT:${Math.round(btScore * 100)}` : "";
          const level = score >= 70 ? "good" : score >= 40 ? "mid" : "bad";
          return el("div", { class: `mp-olympics-role-row mp-olympics-row-${level}` }, [
            el("span", { class: "mp-olympics-role-rank" }, podium),
            el("span", { class: "mp-olympics-role-model" }, p.model + capStr),
            el("span", { class: "mp-olympics-role-stats" },
              `${score}/100 (min ${minScore}) · ${(p.avgDurationMs / 1000).toFixed(1)}s${btStr}`),
            ...tags,
          ]);
        })
      ),

      /* Объяснение «почему» */
      (agg.optimumReason || agg.championReason)
        ? el("div", { class: "mp-olympics-role-why" }, [
            optimumStats && agg.optimumReason
              ? el("div", { class: "mp-olympics-why-row" }, [
                  el("span", { class: "mp-olympics-why-label" }, "⭐ Оптимум:"),
                  el("span", { class: "mp-olympics-why-text" }, agg.optimumReason),
                ])
              : null,
            championStats && agg.championReason && agg.champion !== agg.optimum
              ? el("div", { class: "mp-olympics-why-row" }, [
                  el("span", { class: "mp-olympics-why-label" }, "🏆 Чемпион:"),
                  el("span", { class: "mp-olympics-why-text" }, agg.championReason),
                ])
              : null,
            agg.champion === agg.optimum && agg.optimumReason
              ? el("div", { class: "mp-olympics-why-hint" }, "Чемпион = Оптимум — лучшая по качеству И по скорости.")
              : null,
          ].filter(Boolean))
        : el("div", { class: "mp-olympics-role-no-winner" },
            "Нет уверенного победителя — все модели не справились с этой ролью."),
    ]);
    root.appendChild(card);
  }
}

async function applyRecommendations(recs) {
  if (!window.api?.arena?.applyOlympicsRecommendations) return;
  try {
    await window.api.arena.applyOlympicsRecommendations({ recommendations: recs });
    showToast(t("models.olympics.distribute_done"), "success");
    void refresh();
  } catch (e) {
    showToast(errMsg(e), "error");
  }
}

/**
 * Авто-применение рекомендаций после успешного прогона Олимпиады.
 *
 * По умолчанию применяет «оптимум» (`report.recommendations`). Если в Advanced
 * включён флаг `olympicsUseChampion` — применит «чемпиона»
 * (`report.recommendationsByScore`).
 *
 * Сохраняется в preferences.json — следующий запуск приложения подхватит
 * этот же набор моделей. Никаких ручных «сохранить» нажимать не нужно.
 *
 * @param {{ recommendations?: Record<string, string>; recommendationsByScore?: Record<string, string> }} report
 */
async function autoApplyOlympicsRecommendations(report) {
  if (!window.api?.arena?.applyOlympicsRecommendations) return;

  let useChampion = false;
  if (window.api?.preferences?.getAll) {
    try {
      const prefs = await window.api.preferences.getAll();
      useChampion = prefs?.olympicsUseChampion === true;
    } catch { /* ignore — fallback to optimum */ }
  }

  const target = useChampion
    ? (report.recommendationsByScore ?? {})
    : (report.recommendations ?? {});
  const keys = Object.keys(target);
  if (keys.length === 0) return;

  try {
    await window.api.arena.applyOlympicsRecommendations({ recommendations: target });
    showToast(
      `${useChampion ? "🏆" : "⭐"} ${t("models.olympics.distribute_done")} (${keys.length})`,
      "success",
    );
    void refresh();
  } catch (e) {
    /* Не показываем как fatal — пользователь увидит кнопку и сможет применить руками. */
    console.warn("[models] auto-apply failed:", e);
  }
}

async function refreshAll() {
  await refreshHardware(true);
  await refresh();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function mountModels(root) {
  if (!root || root.dataset.mounted === "1") return;
  root.dataset.mounted = "1";
  pageRoot = root;
  root.appendChild(buildLayout());

  const hwBtn = root.querySelector("#mp-hw-refresh");
  if (hwBtn) hwBtn.addEventListener("click", () => void refreshHardware(true).then(() => renderHardwareStrip()));

  /* hw-refresh теперь внутри <details>, поэтому подписываемся через делегирование */
  void refreshHardware(false).then(() => refresh());

  if (typeof window.api.preferences?.onChanged === "function") {
    preferencesUnsubscribe = window.api.preferences.onChanged(() => {
      if (!busy) void refresh();
    });
  }

  localeUnsubscribe = onLocaleChange(() => {
    if (pageRoot && !busy) void refreshAll();
  });

  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    if (!busy) void refresh();
  }, REFRESH_MS);
}

export function unmountModels() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  if (typeof preferencesUnsubscribe === "function") {
    preferencesUnsubscribe();
    preferencesUnsubscribe = null;
  }
  if (typeof localeUnsubscribe === "function") {
    localeUnsubscribe();
    localeUnsubscribe = null;
  }
  pageRoot = null;
  busy = false;
  hardwareSnap = null;
}

if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", unmountModels);
}
