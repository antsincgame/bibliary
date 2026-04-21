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

const REFRESH_MS = 7000;
const TOAST_TTL_MS = 6000;

let refreshTimer = null;
let pageRoot = null;
let profilesCache = null;
let busy = false;
/** modelKey, для которого сейчас открыт slider (single-active). */
let memoryForgeOpenKey = null;

function showToast(message, kind = "error") {
  if (!pageRoot) return;
  const area = pageRoot.querySelector("#mp-toast-area");
  if (!area) return;
  const toast = el("div", { class: `toast toast-${kind}` }, message);
  area.appendChild(toast);
  setTimeout(() => toast.remove(), TOAST_TTL_MS);
}

async function refresh() {
  if (!pageRoot) return;
  try {
    const [status, downloaded, loaded] = await Promise.all([
      window.api.lmstudio.status(),
      window.api.lmstudio.listDownloaded(),
      window.api.lmstudio.listLoaded(),
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
  } catch (e) {
    showToast(t("models.toast.refresh_failed", { msg: errMsg(e) }));
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

  // Объединённый список: loaded имеют приоритет, downloaded добавляем оставшихся.
  const seen = new Set();
  /** @type {Array<{ modelKey: string; loaded: boolean; sizeGB?: number }>} */
  const entries = [];
  for (const l of loaded) {
    if (seen.has(l.modelKey)) continue;
    seen.add(l.modelKey);
    entries.push({ modelKey: l.modelKey, loaded: true });
  }
  for (const d of downloaded) {
    if (seen.has(d.modelKey)) continue;
    seen.add(d.modelKey);
    entries.push({
      modelKey: d.modelKey,
      loaded: false,
      sizeGB: typeof d.sizeBytes === "number" ? d.sizeBytes / 1024 / 1024 / 1024 : undefined,
    });
  }

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
    .querySelectorAll(".profile-card button, #mp-loaded button, #mp-downloaded button")
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
    await window.api.lmstudio.load(modelKey, { contextLength: 32768, gpuOffload: "max" });
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
    await window.api.lmstudio.switchProfile(profile, 32768);
    showToast(t("models.toast.active", { profile }), "success");
  }, "models.toast.switch_failed");
}

function buildLayout() {
  return [
    buildNeonHero({
      title: t("models.header.title"),
      subtitle: t("models.header.sub"),
      pattern: "flower",
    }),
    neonDivider(),
    el("div", { class: "card" }, [
      el("div", { class: "card-title" }, t("models.card.server")),
      el("div", { id: "mp-status" }, t("models.card.loading")),
      el("div", { id: "mp-toast-area", style: "margin-top:14px;" }),
    ]),
    el("div", { class: "card" }, [
      el("div", { class: "card-title" }, t("models.card.profiles")),
      el("div", { id: "mp-profiles", class: "profile-grid" }),
    ]),
    el("div", { class: "card" }, [
      el("div", { class: "card-title" }, t("models.card.loaded")),
      el("div", { id: "mp-loaded" }),
    ]),
    el("div", { class: "card" }, [
      el("div", { class: "card-title" }, t("models.card.downloaded")),
      el("div", { id: "mp-downloaded" }),
    ]),
    el("div", { class: "card" }, [
      el("div", { class: "card-title" }, t("models.card.memory")),
      el("div", { class: "card-sub" }, t("models.card.memory_sub")),
      el("div", { id: "mp-memory-forge", class: "mp-memory-list" }),
    ]),
    el("div", { class: "card", "data-mode-min": "advanced" }, [
      el("div", { class: "card-title" }, t("models.card.profile_manager")),
      el("div", { class: "card-sub" }, t("models.card.profile_manager_sub")),
      el("div", { id: "mp-profile-manager" }),
    ]),
  ];
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
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    if (!busy) refresh();
  }, REFRESH_MS);
}

export function unmountModels() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  pageRoot = null;
  busy = false;
}

if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", unmountModels);
}
