// @ts-check
import { el, clear } from "../dom.js";
import { t } from "../i18n.js";
import { profileCard } from "./profile-card.js";
import { loadedList } from "./loaded-list.js";
import { downloadedList } from "./downloaded-list.js";
import { statusBar } from "./status-bar.js";
import { buildContextSlider } from "../components/context-slider.js";
import { buildProfileManager } from "./profile-manager.js";
import { buildNeonHero, neonDivider } from "../components/neon-helpers.js";
import { buildRoleRow } from "./role-row.js";
import { buildArenaPanel } from "./arena-panel.js";
import { buildAutoConfigureButton } from "./auto-configure-button.js";
import { createCalibrationProgress } from "./calibration-progress.js";
import { buildMemoryEntries, compareByRoleOrder, isCalibratableRole, roleLabel } from "./role-utils.js";

const REFRESH_MS = 7000;
const TOAST_TTL_MS = 6000;
const DEFAULT_CONTEXT_LENGTH = 32768;

let refreshTimer = null;
let pageRoot = null;
let profilesCache = null;
let busy = false;
/** modelKey, для которого сейчас открыт slider (single-active). */
let memoryForgeOpenKey = null;
let preferencesUnsubscribe = null;
let calibrationProgress = null;

function showToast(message, kind = "error") {
  if (!pageRoot) return;
  const area = pageRoot.querySelector("#mp-toast-area");
  if (!area) return;
  const toast = el("div", { class: `toast toast-${kind}`, role: "status", "aria-live": "polite" }, message);
  area.appendChild(toast);
  setTimeout(() => toast.remove(), TOAST_TTL_MS);
}

function isModelsRouteActive() {
  const route = pageRoot?.closest(".route");
  return !route || route.classList.contains("route-active");
}

async function refresh() {
  if (!pageRoot || !isModelsRouteActive()) return;
  try {
    const [status, downloaded, loaded, roleMap, ratings, prefs] = await Promise.all([
      window.api.lmstudio.status(),
      window.api.lmstudio.listDownloaded(),
      window.api.lmstudio.listLoaded(),
      window.api.modelRoles.list(),
      window.api.arena.getRatings(),
      window.api.preferences.getAll(),
    ]);

    const statusEl = pageRoot.querySelector("#mp-status");
    clear(statusEl);
    statusEl.appendChild(statusBar(status));

    if (!profilesCache) profilesCache = await window.api.lmstudio.profiles();

    const loadedKeys = new Set(loaded.map((l) => l.modelKey));
    const profilesEl = pageRoot.querySelector("#mp-profiles");
    clear(profilesEl);
    for (const kind of ["BIG", "SMALL"]) {
      const spec = profilesCache[kind];
      profilesEl.appendChild(
        profileCard(kind, spec, {
          loaded: loadedKeys.has(spec.key),
          onLoad: () => handleLoad(spec.key),
          onUnload: () => {
            const inst = loaded.find((l) => l.modelKey === spec.key);
            if (inst) handleUnload(inst.identifier);
          },
          onActivate: () => handleSwitch(kind),
        })
      );
    }

    const loadedEl = pageRoot.querySelector("#mp-loaded");
    clear(loadedEl);
    loadedEl.appendChild(loadedList(loaded, handleUnload));

    const downloadedEl = pageRoot.querySelector("#mp-downloaded");
    clear(downloadedEl);
    downloadedEl.appendChild(downloadedList(downloaded, handleLoad, loadedKeys));

    renderMemoryForge(loaded, downloaded);
    renderRolesCard(roleMap, loaded, ratings);
    renderFallbacks(roleMap, prefs);
  } catch (e) {
    showToast(t("models.toast.refresh_failed", { msg: errMsg(e) }));
  }
}

function renderRolesCard(roleMap, loaded, ratings) {
  const host = pageRoot.querySelector("#mp-roles");
  if (!host) return;
  clear(host);

  const sorted = [...roleMap].sort(compareByRoleOrder);
  const resolvedCount = sorted.filter((entry) => entry.resolved?.modelKey).length;
  host.appendChild(el("div", { class: "roles-card-head" }, [
    el("div", {}, [
      el("div", { class: "card-title" }, t("models.roles.title")),
      el("div", { class: "card-sub" }, t("models.roles.sub", {
        resolved: resolvedCount,
        total: sorted.length,
        loaded: loaded.length,
      })),
    ]),
    buildAutoConfigureButton({
      progress: calibrationProgress,
      onDone: refresh,
      onError: (err) => showToast(err.message),
    }),
  ]));

  const list = el("div", { class: "roles-list" });
  for (const entry of sorted) {
    list.appendChild(buildRoleRow({
      entry,
      loaded,
      ratings: ratings.roles ?? {},
      onChangeModel: handleRoleModelChange,
      onCalibrate: handleCalibrateRole,
    }));
  }
  host.appendChild(list);
}

async function handleRoleModelChange(entry, modelKey) {
  await withBusy(async () => {
    await window.api.preferences.set({ [entry.prefKey]: modelKey });
    showToast(modelKey
      ? t("models.toast.role_saved", { role: roleLabel(entry.role), model: modelKey })
      : t("models.toast.role_auto", { role: roleLabel(entry.role) }), "success");
  }, "models.toast.role_save_failed");
}

async function handleCalibrateRole(entry) {
  if (!isCalibratableRole(entry.role)) {
    showToast(t("models.calibrate_unavailable"));
    return;
  }
  await withBusy(async () => {
    calibrationProgress?.start(t("models.calibration.one_role", { role: roleLabel(entry.role) }));
    const lock = await window.api.arena.getLockStatus();
    if (lock.busy) {
      const reason = lock.reasons.join(", ");
      calibrationProgress?.finish(false, t("models.calibration.skipped", { reason }));
      return;
    }
    const report = await window.api.arena.runCycle({ roles: [entry.role], manual: true });
    calibrationProgress?.finish(report.ok, report.message);
    if (!report.ok) throw new Error(report.message);
  }, "models.toast.calibrate_failed");
}

function renderFallbacks(roleMap, prefs) {
  const host = pageRoot.querySelector("#mp-fallbacks");
  if (!host) return;
  clear(host);

  for (const entry of roleMap.filter((item) => item.fallbackKey)) {
    const input = el("input", {
      class: "fallback-input",
      value: String(prefs[entry.fallbackKey] ?? ""),
      placeholder: t("models.fallback.placeholder"),
    });
    input.addEventListener("change", () => {
      void window.api.preferences
        .set({ [entry.fallbackKey]: input.value })
        .then(() => showToast(t("models.toast.fallback_saved"), "success"))
        .then(refresh)
        .catch((err) => showToast(t("models.toast.fallback_failed", { msg: errMsg(err) })));
    });
    host.appendChild(el("label", { class: "fallback-row" }, [
      el("span", { class: "fallback-role" }, roleLabel(entry.role)),
      input,
    ]));
  }
}

/**
 * Карточка Memory Forge: список загруженных моделей с возможностью открыть
 * context-slider для каждой. Поддерживается single-active (один открытый
 * slider за раз — чтобы UI не разъезжался).
 */
function renderMemoryForge(loaded, downloaded) {
  const wrap = pageRoot.querySelector("#mp-memory-forge");
  if (!wrap) return;
  clear(wrap);

  const entries = buildMemoryEntries(loaded, downloaded);

  if (entries.length === 0) {
    wrap.appendChild(el("div", { class: "mp-empty" }, t("models.memory.empty")));
    return;
  }

  for (const entry of entries) {
    const row = el("div", { class: "mp-memory-row" }, [
      el("div", { class: "mp-memory-row-head" }, [
        el("span", { class: "mp-memory-key" }, entry.modelKey),
        el(
          "span",
          { class: entry.loaded ? "mp-memory-badge mp-memory-badge-on" : "mp-memory-badge" },
          entry.loaded ? t("models.memory.loaded") : t("models.memory.downloaded")
        ),
      ]),
    ]);

    const toggleBtn = el(
      "button",
      { class: "btn btn-ghost mp-memory-toggle", type: "button" },
      memoryForgeOpenKey === entry.modelKey ? t("models.memory.hide") : t("models.memory.open")
    );
    const sliderHost = el("div", { class: "mp-memory-slider-host" });
    if (memoryForgeOpenKey === entry.modelKey) {
      sliderHost.appendChild(buildSliderForEntry(entry));
    }
    toggleBtn.addEventListener("click", () => {
      if (memoryForgeOpenKey === entry.modelKey) {
        memoryForgeOpenKey = null;
      } else {
        memoryForgeOpenKey = entry.modelKey;
      }
      renderMemoryForge(loaded, downloaded);
    });
    row.appendChild(toggleBtn);
    row.appendChild(sliderHost);
    wrap.appendChild(row);
  }
}

function buildSliderForEntry(entry) {
  return buildContextSlider({
    modelKey: entry.modelKey,
    hardware: entry.sizeGB ? { modelWeightsGB: entry.sizeGB } : {},
    mode: "full",
    onApply: async (target, kvDtype) => {
      try {
        await window.api.yarn.apply(entry.modelKey, target, kvDtype);
        showToast(t("ctx.toast.applied"), "success");
      } catch (e) {
        showToast(t("ctx.toast.apply_fail", { msg: errMsg(e) }));
        throw e;
      }
    },
    onRevert: async () => {
      try {
        await window.api.yarn.revert(entry.modelKey);
        showToast(t("ctx.toast.reverted"), "success");
      } catch (e) {
        showToast(t("ctx.toast.revert_fail", { msg: errMsg(e) }));
        throw e;
      }
    },
  });
}

function errMsg(e) {
  return e instanceof Error ? e.message : String(e);
}

async function withBusy(action, errorKey) {
  if (busy) {
    showToast(t("models.toast.busy"));
    return;
  }
  busy = true;
  setControlsDisabled(true);
  try {
    await action();
    await refresh();
  } catch (e) {
    showToast(t(errorKey, { msg: errMsg(e) }));
  } finally {
    busy = false;
    setControlsDisabled(false);
  }
}

function setControlsDisabled(disabled) {
  if (!pageRoot) return;
  pageRoot
    .querySelectorAll("button, select, input")
    .forEach((btn) => {
      if (disabled) {
        btn.dataset.prevDisabled = btn.disabled ? "1" : "0";
        btn.disabled = true;
      } else {
        if (btn.dataset.prevDisabled === "0") btn.disabled = false;
        delete btn.dataset.prevDisabled;
      }
    });
}

function handleLoad(modelKey) {
  return withBusy(async () => {
    showToast(t("models.toast.loading", { key: modelKey }), "success");
    await window.api.lmstudio.load(modelKey, { contextLength: DEFAULT_CONTEXT_LENGTH, gpuOffload: "max" });
    showToast(t("models.toast.loaded", { key: modelKey }), "success");
  }, "models.toast.load_failed");
}

function handleUnload(identifier) {
  return withBusy(async () => {
    await window.api.lmstudio.unload(identifier);
    showToast(t("models.toast.unloaded"), "success");
  }, "models.toast.unload_failed");
}

function handleSwitch(profile) {
  return withBusy(async () => {
    showToast(t("models.toast.switching", { profile }), "success");
    await window.api.lmstudio.switchProfile(profile, DEFAULT_CONTEXT_LENGTH);
    showToast(t("models.toast.active", { profile }), "success");
  }, "models.toast.switch_failed");
}

function buildLayout() {
  calibrationProgress = createCalibrationProgress();
  return [
    buildNeonHero({
      title: t("models.header.title"),
      subtitle: t("models.header.sub_simple"),
      pattern: "flower",
    }),
    neonDivider(),
    el("div", { class: "scanline-overlay", "aria-hidden": "true" }),
    el("section", { class: "card hud-card roles-shell" }, [
      el("div", { id: "mp-roles" }, t("models.card.loading")),
      el("div", { id: "mp-toast-area", class: "models-toast-area" }),
      calibrationProgress.root,
    ]),
    buildDisclosure({
      id: "mp-disclosure-advanced",
      label: t("models.disclosure.advanced"),
      modeMin: "advanced",
      content: [
        el("div", { class: "models-grid-2" }, [
          el("div", { class: "card hud-card" }, [
            el("div", { class: "card-title" }, t("models.card.server")),
            el("div", { id: "mp-status" }, t("models.card.loading")),
          ]),
          el("div", { class: "card hud-card" }, [
            el("div", { class: "card-title" }, t("models.card.profiles")),
            el("div", { id: "mp-profiles", class: "profile-grid" }),
          ]),
        ]),
        el("div", { class: "models-grid-2" }, [
          el("div", { class: "card hud-card" }, [
            el("div", { class: "card-title" }, t("models.card.loaded")),
            el("div", { id: "mp-loaded" }),
          ]),
          el("div", { class: "card hud-card" }, [
            el("div", { class: "card-title" }, t("models.card.downloaded")),
            el("div", { id: "mp-downloaded" }),
          ]),
        ]),
        el("div", { class: "card hud-card" }, [
          el("div", { class: "card-title" }, t("models.card.memory")),
          el("div", { class: "card-sub" }, t("models.card.memory_sub")),
          el("div", { id: "mp-memory-forge", class: "mp-memory-list" }),
        ]),
      ],
    }),
    buildDisclosure({
      id: "mp-disclosure-pro",
      label: t("models.disclosure.pro"),
      modeMin: "pro",
      content: [
        el("div", { class: "card hud-card" }, [
          el("div", { class: "card-title" }, t("models.card.arena")),
          el("div", { class: "card-sub" }, t("models.card.arena_sub")),
          buildArenaPanel({ progress: calibrationProgress, onRefresh: refresh, onError: (err) => showToast(err.message) }),
        ]),
        el("div", { class: "card hud-card" }, [
          el("div", { class: "card-title" }, t("models.card.fallbacks")),
          el("div", { class: "card-sub" }, t("models.card.fallbacks_sub")),
          el("div", { id: "mp-fallbacks", class: "fallback-list" }),
        ]),
        el("div", { class: "card hud-card" }, [
          el("div", { class: "card-title" }, t("models.card.profile_manager")),
          el("div", { class: "card-sub" }, t("models.card.profile_manager_sub")),
          el("div", { id: "mp-profile-manager" }),
        ]),
      ],
    }),
  ];
}

function buildDisclosure({ id, label, modeMin, content }) {
  const storageKey = `bibliary.models.${id}.open`;
  let open = true;
  try {
    const stored = localStorage.getItem(storageKey);
    if (stored !== null) open = stored === "1";
  } catch {
    open = true;
  }

  const details = el("details", { class: "models-disclosure", id, "data-mode-min": modeMin });
  if (open) details.setAttribute("open", "open");
  details.appendChild(el("summary", { class: "models-disclosure-summary" }, [
    el("span", { class: "summary-prefix" }, "//"),
    el("span", {}, label),
  ]));
  details.appendChild(el("div", { class: "models-disclosure-body" }, content));
  details.addEventListener("toggle", () => {
    try {
      localStorage.setItem(storageKey, details.open ? "1" : "0");
    } catch {
      /* localStorage unavailable */
    }
  });
  return details;
}

export function mountModels(root) {
  if (!root || root.dataset.mounted === "1") return;
  root.dataset.mounted = "1";
  pageRoot = root;
  for (const node of buildLayout()) root.appendChild(node);

  // Profile manager — единожды при mount, обновляется по запросу.
  const pmHost = root.querySelector("#mp-profile-manager");
  if (pmHost) {
    const pm = buildProfileManager({
      onChange: async () => {
        profilesCache = null; // сбросить кеш встроенных profile цепочки
        await refresh();
      },
    });
    pmHost.appendChild(pm);
  }

  refresh();
  if (typeof window.api.preferences?.onChanged === "function") {
    preferencesUnsubscribe = window.api.preferences.onChanged(() => {
      if (!busy && isModelsRouteActive()) void refresh();
    });
  }
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    if (!busy && isModelsRouteActive()) refresh();
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
  calibrationProgress = null;
  memoryForgeOpenKey = null;
  profilesCache = null;
  pageRoot = null;
  busy = false;
}

if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", unmountModels);
}
