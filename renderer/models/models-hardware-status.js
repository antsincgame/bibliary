// @ts-check
/**
 * Hardware-strip + LM Studio status + загруженные/доступные модели + роли.
 *
 * Извлечено из `models-page.js` (Phase 2.4 cross-platform roadmap, 2026-04-30).
 * Группа объединена т.к. все эти блоки переоткрываются в одном `refresh()`.
 */

import { el, clear } from "../dom.js";
import { t } from "../i18n.js";
import {
  hardwareSummaryLine,
  inferGpuOffloadForLmLoad,
  offloadHintLine,
  pickHardwareAutoModel,
  suggestedContextLength,
} from "./gpu-offload-hint.js";
import {
  ctx,
  errMsg,
  showToast,
  withBusy,
  PIPELINE_ROLES,
} from "./models-page-internals.js";

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

export async function refreshHardware(force = false) {
  if (!ctx.pageRoot) return;
  const textEl = ctx.pageRoot.querySelector("#mp-hw-text");
  const recoEl = ctx.pageRoot.querySelector("#mp-hw-reco");
  if (textEl) textEl.textContent = t("models.hardware.loading");
  if (recoEl) recoEl.textContent = "";
  try {
    if (typeof window.api?.system?.hardware !== "function") {
      ctx.hardwareSnap = null;
      if (textEl) textEl.textContent = t("models.hardware.unknown");
      return;
    }
    ctx.hardwareSnap = await window.api.system.hardware(force);
    renderHardwareStrip();
  } catch (e) {
    ctx.hardwareSnap = null;
    if (textEl) textEl.textContent = t("models.hardware.error", { msg: errMsg(e) });
    if (recoEl) recoEl.textContent = "";
  }
}

export function renderHardwareStrip() {
  if (!ctx.pageRoot) return;
  const textEl = ctx.pageRoot.querySelector("#mp-hw-text");
  const recoEl = ctx.pageRoot.querySelector("#mp-hw-reco");
  if (textEl) textEl.textContent = hardwareSummaryLine(ctx.hardwareSnap, t);
  if (recoEl) recoEl.textContent = offloadHintLine(ctx.hardwareSnap, t);
}

export async function refresh() {
  if (!ctx.pageRoot) return;
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

export async function refreshAll() {
  await refreshHardware(true);
  await refresh();
}

function renderStatus(status) {
  const node = ctx.pageRoot?.querySelector("#mp-status-indicator");
  if (!node) return;
  node.textContent = status.online
    ? t("models.status.online", { ver: status.version ? ` v${status.version}` : "" })
    : t("models.status.offline");
  node.className = `mp-status-pill ${status.online ? "mp-status-online" : "mp-status-offline"}`;
}

function renderLoaded(loaded) {
  const host = ctx.pageRoot?.querySelector("#mp-loaded");
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
      "models.toast.unload_failed",
      refresh,
    ));
    host.appendChild(el("div", { class: "mp-model-row mp-model-row-compact" }, [
      el("span", { class: "mp-model-name", title: m.modelKey }, m.modelKey),
      btn,
    ]));
  }
}

/**
 * @param {Array<{ modelKey: string }>} downloaded
 * @param {Array<{ modelKey: string; identifier: string }>} loaded
 */
function renderLoadFromDisk(downloaded, loaded) {
  const host = ctx.pageRoot?.querySelector("#mp-downloaded");
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
    const offloadOpts = inferGpuOffloadForLmLoad(ctx.hardwareSnap);
    void withBusy(
      async () => {
        showToast(t("models.toast.loading", { key }), "success");
        await window.api.lmstudio.load(key, { gpuOffload: offloadOpts.gpuOffload ?? "max" });
        showToast(t("models.toast.loaded", { key }), "success");
      },
      "models.toast.load_failed",
      refresh,
    );
  });

  const autoBtn = el(
    "button",
    { class: "btn btn-sm btn-ghost mp-load-auto", type: "button", title: t("models.autoconf.title") },
    t("models.autoconf.btn")
  );
  autoBtn.addEventListener("click", () => {
    const pick = pickHardwareAutoModel(downloaded, ctx.hardwareSnap);
    if (!pick) {
      showToast(t("models.autoconf.empty"));
      return;
    }
    if (loadedKeys.has(pick.modelKey)) {
      showToast(t("models.autoconf.already_loaded", { key: pick.modelKey }), "success");
      return;
    }
    const offloadOpts = inferGpuOffloadForLmLoad(ctx.hardwareSnap);
    const cl = suggestedContextLength(ctx.hardwareSnap);
    void withBusy(
      async () => {
        showToast(t("models.autoconf.loading", { key: pick.modelKey, reason: t(pick.reasonKey) }), "success");
        await window.api.lmstudio.load(pick.modelKey, {
          gpuOffload: offloadOpts.gpuOffload ?? "max",
          contextLength: cl,
        });
        showToast(t("models.toast.loaded", { key: pick.modelKey }), "success");
      },
      "models.toast.load_failed",
      refresh,
    );
  });

  host.appendChild(el("div", { class: "mp-load-stack" }, [
    el("div", { class: "mp-load-row" }, [select, loadBtn]),
    el("div", { class: "mp-load-row mp-load-row-auto" }, [autoBtn]),
    el("p", { class: "mp-load-hint" }, t("models.load.hint")),
  ]));
}

/**
 * @param {unknown[]} roleMap
 * @param {Array<{ modelKey: string }>} loaded
 * @param {Array<{ modelKey: string }>} downloaded
 */
function renderRoles(roleMap, loaded, downloaded) {
  const host = ctx.pageRoot?.querySelector("#mp-roles");
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

export function buildHwStrip() {
  /* Компактная полоска с железом: свёрнута по умолчанию,
     разворачивается кликом на toggles. */
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
