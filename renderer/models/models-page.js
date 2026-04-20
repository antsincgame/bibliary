// @ts-check
import { el, clear } from "./dom.js";
import { profileCard } from "./profile-card.js";
import { loadedList } from "./loaded-list.js";
import { downloadedList } from "./downloaded-list.js";
import { statusBar } from "./status-bar.js";

const REFRESH_MS = 7000;
let refreshTimer = null;
let pageRoot = null;
let profilesCache = null;
let busy = false;

function showToast(message, kind = "error") {
  if (!pageRoot) return;
  const area = pageRoot.querySelector("#mp-toast-area");
  if (!area) return;
  const toast = el("div", { class: `toast toast-${kind}` }, message);
  area.appendChild(toast);
  setTimeout(() => toast.remove(), 6000);
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
  } catch (e) {
    showToast(`Refresh failed: ${e instanceof Error ? e.message : String(e)}`, "error");
  }
}

async function withBusy(action, errorMessage) {
  if (busy) {
    showToast("Another operation is already in progress", "error");
    return;
  }
  busy = true;
  setControlsDisabled(true);
  try {
    await action();
    await refresh();
  } catch (e) {
    showToast(`${errorMessage}: ${e instanceof Error ? e.message : String(e)}`, "error");
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
    showToast(`Loading ${modelKey}…`, "success");
    await window.api.lmstudio.load(modelKey, { contextLength: 32768, gpuOffload: "max" });
    showToast(`${modelKey} loaded`, "success");
  }, "Load failed");
}

function handleUnload(identifier) {
  return withBusy(async () => {
    await window.api.lmstudio.unload(identifier);
    showToast("Unloaded", "success");
  }, "Unload failed");
}

function handleSwitch(profile) {
  return withBusy(async () => {
    showToast(`Switching to ${profile}…`, "success");
    await window.api.lmstudio.switchProfile(profile, 32768);
    showToast(`${profile} active`, "success");
  }, "Switch failed");
}

function buildLayout() {
  return [
    el("div", { class: "card" }, [
      el("div", { class: "card-title" }, "Server"),
      el("div", { id: "mp-status" }, "Loading…"),
      el("div", { id: "mp-toast-area", style: "margin-top:14px;" }),
    ]),
    el("div", { class: "card" }, [
      el("div", { class: "card-title" }, "Profiles"),
      el("div", { id: "mp-profiles", class: "profile-grid" }),
    ]),
    el("div", { class: "card" }, [
      el("div", { class: "card-title" }, "Loaded models (in memory)"),
      el("div", { id: "mp-loaded" }),
    ]),
    el("div", { class: "card" }, [
      el("div", { class: "card-title" }, "Downloaded models"),
      el("div", { id: "mp-downloaded" }),
    ]),
  ];
}

export function mountModels(root) {
  if (!root || root.dataset.mounted === "1") return;
  root.dataset.mounted = "1";
  pageRoot = root;
  for (const node of buildLayout()) root.appendChild(node);
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
