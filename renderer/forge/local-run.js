// @ts-check
import { el, clear } from "../dom.js";
import { t } from "../i18n.js";
import {
  STATE, STDOUT_TAIL_MAX,
  _startingLocalRun, setStartingLocalRun,
  _importingGguf, setImportingGguf,
  resetLocalRunFields, resetLocalRun,
  cleanupLocalListenersKeepData,
} from "./state.js";
import { showToast, errMsg } from "./ui-controls.js";

/** @param {() => void} render */
export function buildLocalRunSection(render) {
  const wrap = el("div", { class: "forge-section forge-local-run" });
  STATE.localRun.refresh = () => renderInto(wrap);
  renderInto(wrap);
  return wrap;

  /** @param {HTMLElement} node */
  function renderInto(node) {
    clear(node);
    node.appendChild(el("div", { class: "forge-section-title" }, t("forge.local.section.title")));
    node.appendChild(el("div", { class: "forge-section-sub" }, t("forge.local.section.sub")));

    if (!STATE.bundleDir) {
      node.appendChild(el("div", { class: "forge-local-hint" }, t("forge.local.hint.generate_first")));
      return;
    }

    const lr = STATE.localRun;
    if (lr.status === "idle") {
      const startBtn = /** @type {HTMLButtonElement} */ (el("button", {
        class: "btn btn-gold", type: "button",
      }, _startingLocalRun ? t("forge.local.btn.starting") : t("forge.local.btn.start")));
      if (_startingLocalRun) startBtn.disabled = true;
      startBtn.addEventListener("click", () => void startLocalRun());
      node.appendChild(startBtn);
      node.appendChild(el("div", { class: "forge-local-hint" }, t("forge.local.hint.requirements")));
      return;
    }

    if (lr.status === "running") {
      node.appendChild(buildStatusBadge("running", t("forge.local.status.running")));
      node.appendChild(buildMetricGrid(lr.metric));
      node.appendChild(buildStdoutTail(lr.stdoutTail));
      const cancelBtn = el("button", { class: "btn btn-ghost", type: "button" }, t("forge.local.btn.cancel"));
      cancelBtn.addEventListener("click", () => void cancelLocalRun());
      node.appendChild(cancelBtn);
      return;
    }

    if (lr.status === "succeeded") {
      node.appendChild(buildStatusBadge("succeeded", t("forge.local.status.succeeded")));
      node.appendChild(buildMetricGrid(lr.metric));
      node.appendChild(buildStdoutTail(lr.stdoutTail));
      const actions = el("div", { class: "forge-local-actions" });
      const importBtn = /** @type {HTMLButtonElement} */ (el("button", {
        class: "btn btn-gold", type: "button",
      }, importBtnLabel(lr.importedGguf, _importingGguf)));
      if (lr.importedGguf || _importingGguf) importBtn.disabled = true;
      importBtn.addEventListener("click", () => void importGgufClick());
      actions.appendChild(importBtn);
      const resetBtn = el("button", { class: "btn btn-ghost", type: "button" }, t("forge.local.btn.reset"));
      resetBtn.addEventListener("click", () => { resetLocalRun(); render(); });
      actions.appendChild(resetBtn);
      node.appendChild(actions);
      return;
    }

    if (lr.status === "failed" || lr.status === "cancelled") {
      const code = lr.exitCode == null ? "?" : String(lr.exitCode);
      const label = lr.status === "cancelled"
        ? t("forge.local.status.cancelled")
        : t("forge.local.status.failed", { code });
      node.appendChild(buildStatusBadge(lr.status, label));
      if (lr.error) node.appendChild(el("div", { class: "forge-local-error" }, lr.error));
      node.appendChild(buildStdoutTail(lr.stdoutTail));
      const resetBtn = el("button", { class: "btn btn-ghost", type: "button" }, t("forge.local.btn.reset"));
      resetBtn.addEventListener("click", () => { resetLocalRun(); render(); });
      node.appendChild(resetBtn);
    }
  }
}

function buildStatusBadge(kind, label) {
  return el("div", { class: `forge-local-badge forge-local-badge-${kind}` }, label);
}

function importBtnLabel(done, busy) {
  if (done) return t("forge.local.btn.gguf_done");
  if (busy) return t("forge.local.btn.gguf_busy");
  return t("forge.local.btn.import_gguf");
}

function buildMetricGrid(metric) {
  const grid = el("div", { class: "forge-metric-grid" });
  const cells = [
    ["forge.local.metric.step", metric?.step != null ? String(metric.step) : "—"],
    ["forge.local.metric.loss", metric?.loss != null ? metric.loss.toFixed(4) : "—"],
    ["forge.local.metric.grad_norm", metric?.gradNorm != null ? metric.gradNorm.toFixed(4) : "—"],
    ["forge.local.metric.lr", metric?.learningRate != null ? metric.learningRate.toExponential(2) : "—"],
    ["forge.local.metric.epoch", metric?.epoch != null ? metric.epoch.toFixed(2) : "—"],
  ];
  for (const [key, value] of cells) {
    grid.appendChild(el("div", { class: "forge-metric-cell" }, [
      el("div", { class: "forge-metric-label" }, t(key)),
      el("div", { class: "forge-metric-value" }, value),
    ]));
  }
  return grid;
}

function buildStdoutTail(tail) {
  const body = el("pre", { class: "forge-stdout-tail" }, tail.length === 0 ? "" : tail.join("\n"));
  return el("details", { class: "forge-collapsible" }, [
    el("summary", { class: "forge-collapsible-summary" }, `${t("forge.local.stdout")} (${tail.length})`),
    body,
  ]);
}

async function startLocalRun() {
  if (_startingLocalRun || STATE.localRun.status === "running") return;
  if (!STATE.bundleDir) {
    showToast(t("forge.local.toast.no_workspace"), "error");
    return;
  }
  setStartingLocalRun(true);
  try {
    const wsl = /** @type {any} */ (await window.api.wsl.detect().catch(() => null));
    if (!wsl || !wsl.installed) {
      showToast(t("forge.local.toast.no_wsl"), "error");
      return;
    }
    if (!wsl.gpuPassthrough) {
      showToast(t("forge.local.toast.no_gpu"), "warn");
    }

    resetLocalRunFields();
    const runId = STATE.spec.runId;
    STATE.localRun.runId = runId;
    STATE.localRun.status = "running";
    if (STATE.localRun.refresh) STATE.localRun.refresh();

    const onMetric = window.api.forgeLocal.onMetric(({ runId: r, metric }) => {
      if (r !== STATE.localRun.runId) return;
      STATE.localRun.metric = /** @type {any} */ (metric);
      if (STATE.localRun.refresh) STATE.localRun.refresh();
    });
    const onStdout = window.api.forgeLocal.onStdout(({ runId: r, line }) => {
      if (r !== STATE.localRun.runId) return;
      pushStdoutLine(line);
    });
    const onStderr = window.api.forgeLocal.onStderr(({ runId: r, line }) => {
      if (r !== STATE.localRun.runId) return;
      pushStdoutLine(`[stderr] ${line}`);
    });
    const onExit = window.api.forgeLocal.onExit(({ runId: r, code }) => {
      if (r !== STATE.localRun.runId) return;
      STATE.localRun.exitCode = code;
      STATE.localRun.status = code === 0 ? "succeeded" : "failed";
      cleanupLocalListenersKeepData();
      if (STATE.localRun.refresh) STATE.localRun.refresh();
    });
    const onError = window.api.forgeLocal.onError(({ runId: r, error }) => {
      if (r !== STATE.localRun.runId) return;
      STATE.localRun.error = error;
      STATE.localRun.status = "failed";
      cleanupLocalListenersKeepData();
      if (STATE.localRun.refresh) STATE.localRun.refresh();
    });
    STATE.localRun.unsubs = [onMetric, onStdout, onStderr, onExit, onError];

    const scriptWinPath = `${STATE.bundleDir}\\${runId}.py`;
    try {
      await window.api.forgeLocal.start({ runId, scriptWinPath });
    } catch (e) {
      cleanupLocalListenersKeepData();
      STATE.localRun.status = "failed";
      STATE.localRun.error = errMsg(e);
      showToast(t("forge.local.toast.start_fail", { msg: errMsg(e) }), "error");
      if (STATE.localRun.refresh) STATE.localRun.refresh();
    }
  } finally {
    setStartingLocalRun(false);
  }
}

function pushStdoutLine(line) {
  STATE.localRun.stdoutTail.push(line);
  if (STATE.localRun.stdoutTail.length > STDOUT_TAIL_MAX) {
    STATE.localRun.stdoutTail.splice(0, STATE.localRun.stdoutTail.length - STDOUT_TAIL_MAX);
  }
  if (STATE.localRun.refresh) STATE.localRun.refresh();
}

async function cancelLocalRun() {
  const runId = STATE.localRun.runId;
  if (!runId) return;
  try {
    const ok = await window.api.forgeLocal.cancel(runId);
    if (ok) {
      STATE.localRun.status = "cancelled";
      cleanupLocalListenersKeepData();
      showToast(t("forge.local.toast.cancelled"), "warn");
      if (STATE.localRun.refresh) STATE.localRun.refresh();
    }
  } catch (e) {
    showToast(t("forge.local.toast.cancel_fail", { msg: errMsg(e) }), "error");
  }
}

async function importGgufClick() {
  if (_importingGguf) return;
  if (!STATE.bundleDir) return;
  setImportingGguf(true);
  if (STATE.localRun.refresh) STATE.localRun.refresh();
  const outputDir = `${STATE.bundleDir}\\${STATE.spec.runId}-output`;
  const modelKey = STATE.spec.runId;
  try {
    const result = /** @type {any} */ (await window.api.forgeLocal.importGguf(outputDir, modelKey));
    if (result.copied === 0) {
      showToast(t("forge.local.toast.gguf_none"), "warn");
      return;
    }
    STATE.localRun.importedGguf = true;
    showToast(t("forge.local.toast.gguf_imported", { count: result.copied, path: result.destPath }), "success");
  } catch (e) {
    showToast(t("forge.local.toast.gguf_fail", { msg: errMsg(e) }), "error");
  } finally {
    setImportingGguf(false);
    if (STATE.localRun.refresh) STATE.localRun.refresh();
  }
}
