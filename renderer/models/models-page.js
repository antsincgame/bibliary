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

/** Роли, отображаемые на странице моделей. */
const PIPELINE_ROLES = [
  "crystallizer",
  "evaluator",
  "judge",
  "translator",
  "ukrainian_specialist",
  "lang_detector",
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

    select.addEventListener("change", () => {
      const val = select.value || null;
      void window.api.preferences
        .set({ [entry.prefKey]: val })
        .then(() => showToast(
          val
            ? t("models.toast.role_saved", { role: label, model: val })
            : t("models.toast.role_auto", { role: label }),
          "success"
        ))
        .catch((err) => showToast(t("models.toast.role_save_failed", { msg: errMsg(err) })));
    });

    host.appendChild(el("div", { class: "mp-role-row mp-role-row-compact" }, [
      el("div", { class: "mp-role-info" }, [
        el("span", { class: "mp-role-label" }, label),
        help ? el("span", { class: "mp-role-help" }, help) : null,
      ].filter(Boolean)),
      select,
    ]));
  }
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

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

    el("div", { class: "mp-hw-strip" }, [
      el("div", { class: "mp-hw-copy" }, [
        el("div", { id: "mp-hw-text", class: "mp-hw-text" }, t("models.hardware.loading")),
        el("div", { id: "mp-hw-reco", class: "mp-hw-reco" }, ""),
      ]),
      el("button", { id: "mp-hw-refresh", class: "btn btn-ghost btn-sm", type: "button" }, t("models.hardware.rescan")),
    ]),

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

    buildOlympicsCard(),
  ]);
}

// ---------------------------------------------------------------------------
// Олимпиада: автонастройка ролей через реальный турнир локальных моделей
// ---------------------------------------------------------------------------

let olympicsBusy = false;

function buildOlympicsCard() {
  return el("section", { class: "mp-card mp-card-compact mp-olympics-card" }, [
    el("h2", { class: "mp-card-title" }, t("models.olympics.title")),
    el("p", { class: "mp-card-sub" }, t("models.olympics.sub")),
    el("div", { class: "mp-olympics-actions" }, [
      el("button", {
        id: "mp-olympics-run",
        class: "btn btn-primary",
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
    ]),
    el("div", { id: "mp-olympics-progress", class: "mp-olympics-progress" }, ""),
    el("div", { id: "mp-olympics-results", class: "mp-olympics-results" }, ""),
  ]);
}

async function runOlympicsAndShow() {
  if (olympicsBusy) return;
  if (!window.api?.arena?.runOlympics) {
    showToast(t("models.olympics.unavailable"), "error");
    return;
  }
  olympicsBusy = true;
  setOlympicsButtons(true);
  const progressEl = pageRoot?.querySelector("#mp-olympics-progress");
  const resultsEl = pageRoot?.querySelector("#mp-olympics-results");
  if (progressEl) progressEl.textContent = t("models.olympics.starting");
  if (resultsEl) clear(resultsEl);

  let unsub = null;
  if (typeof window.api.arena.onOlympicsProgress === "function") {
    unsub = window.api.arena.onOlympicsProgress((ev) => {
      if (!progressEl || !ev || typeof ev !== "object") return;
      const e = ev;
      if (e.type === "olympics.start") {
        progressEl.textContent = t("models.olympics.progress.start", { models: e.models?.length ?? 0, disciplines: e.disciplines?.length ?? 0 });
      } else if (e.type === "olympics.discipline.start") {
        progressEl.textContent = t("models.olympics.progress.discipline", { discipline: e.discipline });
      } else if (e.type === "olympics.model.done") {
        const score = Math.round((e.score ?? 0) * 100);
        const dur = ((e.durationMs ?? 0) / 1000).toFixed(1);
        progressEl.textContent = `${e.discipline} · ${e.model} → ${score}/100 (${dur}s)`;
      }
    });
  }

  try {
    const report = await window.api.arena.runOlympics({});
    if (progressEl) progressEl.textContent = t("models.olympics.done", { ms: ((report.totalDurationMs ?? 0) / 1000).toFixed(1) });
    renderOlympicsReport(report);
    showToast(t("models.olympics.success"), "success");
  } catch (e) {
    if (progressEl) progressEl.textContent = "";
    const msg = errMsg(e);
    showToast(t("models.olympics.failed", { reason: msg }), "error");
    if (resultsEl) resultsEl.appendChild(el("div", { class: "mp-error" }, msg));
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

function renderOlympicsReport(report) {
  const root = pageRoot?.querySelector("#mp-olympics-results");
  if (!root) return;
  clear(root);

  const medalsBox = el("div", { class: "mp-olympics-medals" }, [
    el("h3", {}, t("models.olympics.leaderboard")),
    ...((report.medals ?? []).map((row) =>
      el("div", { class: "mp-olympics-medal-row" }, [
        el("span", { class: "mp-olympics-medal-model" }, row.model),
        el("span", { class: "mp-olympics-medals-cell" }, `🥇${row.gold} 🥈${row.silver} 🥉${row.bronze}`),
        el("span", { class: "mp-olympics-medals-time" }, `${(row.totalDurationMs / 1000).toFixed(1)}s`),
      ])
    )),
  ]);
  root.appendChild(medalsBox);

  const disciplines = el("div", { class: "mp-olympics-disciplines" }, [
    el("h3", {}, t("models.olympics.disciplines")),
    ...((report.disciplines ?? []).map((d) => {
      const sorted = [...(d.perModel ?? [])].sort((a, b) => b.score - a.score);
      const podium = ["🥇", "🥈", "🥉"];
      return el("div", { class: "mp-olympics-discipline" }, [
        el("div", { class: "mp-olympics-discipline-title" }, `${d.discipline} (${d.role})`),
        el("div", { class: "mp-olympics-discipline-desc" }, d.description ?? ""),
        ...sorted.map((p, i) =>
          el("div", { class: "mp-olympics-discipline-row" },
            `${podium[i] ?? "  "} ${p.model} — ${Math.round(p.score * 100)}/100  (${(p.durationMs / 1000).toFixed(1)}s)`
          ),
        ),
      ]);
    })),
  ]);
  root.appendChild(disciplines);

  const recs = report.recommendations ?? {};
  const byScore = report.recommendationsByScore ?? {};
  const recsKeys = Object.keys(recs);
  const byScoreKeys = Object.keys(byScore);
  if (recsKeys.length === 0 && byScoreKeys.length === 0) {
    root.appendChild(el("div", { class: "mp-olympics-no-recs" }, t("models.olympics.no_recommendations")));
    return;
  }

  /* Две колонки: ОПТИМУМ (бабушкин выбор) и ЧЕМПИОН (максимальное качество). */
  const recsBox = el("div", { class: "mp-olympics-recs" }, [
    el("h3", {}, t("models.olympics.recommendations")),
    el("p", { class: "mp-card-sub" }, t("models.olympics.recommendations_hint_v2")),

    el("div", { class: "mp-olympics-recs-cols" }, [
      el("div", { class: "mp-olympics-recs-col" }, [
        el("div", { class: "mp-olympics-recs-col-title" }, t("models.olympics.optimum.title")),
        el("div", { class: "mp-olympics-recs-col-sub" }, t("models.olympics.optimum.sub")),
        ...recsKeys.map((k) => el("div", { class: "mp-olympics-rec-row" }, `${k}: ${recs[k]}`)),
        el("button", {
          class: "btn btn-primary",
          type: "button",
          disabled: recsKeys.length === 0,
          onclick: () => void applyRecommendations(recs),
        }, t("models.olympics.apply.optimum")),
      ]),
      el("div", { class: "mp-olympics-recs-col" }, [
        el("div", { class: "mp-olympics-recs-col-title" }, t("models.olympics.champion.title")),
        el("div", { class: "mp-olympics-recs-col-sub" }, t("models.olympics.champion.sub")),
        ...byScoreKeys.map((k) => el("div", { class: "mp-olympics-rec-row" }, `${k}: ${byScore[k]}`)),
        el("button", {
          class: "btn btn-ghost",
          type: "button",
          disabled: byScoreKeys.length === 0,
          onclick: () => void applyRecommendations(byScore),
        }, t("models.olympics.apply.champion")),
      ]),
    ]),
  ]);
  root.appendChild(recsBox);
}

async function applyRecommendations(recs) {
  if (!window.api?.arena?.applyOlympicsRecommendations) return;
  try {
    await window.api.arena.applyOlympicsRecommendations({ recommendations: recs });
    showToast(t("models.olympics.applied"), "success");
    void refresh();
  } catch (e) {
    showToast(errMsg(e), "error");
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
