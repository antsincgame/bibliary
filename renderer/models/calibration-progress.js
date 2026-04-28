// @ts-check
import { el, clear } from "../dom.js";
import { t } from "../i18n.js";

const MIN_PROGRESS_PERCENT = 0;
const START_PROGRESS_PERCENT = 15;
const ERROR_PROGRESS_PERCENT = 40;
const SUCCESS_PROGRESS_PERCENT = 100;

export function createCalibrationProgress() {
  const label = el("span", { class: "calibration-label" }, t("models.calibration.idle"));
  const status = el("span", { class: "calibration-status" }, "[READY]");
  const fill = el("div", { class: "calibration-bar-fill", style: "width:0%" });
  const bar = el("div", {
    class: "calibration-bar",
    role: "progressbar",
    "aria-valuemin": "0",
    "aria-valuemax": "100",
    "aria-valuenow": "0",
  }, fill);
  const log = el("div", { class: "calibration-log", "aria-live": "polite" });
  const root = el("div", { class: "calibration-progress", hidden: "hidden" }, [
    el("div", { class: "calibration-head" }, [label, status]),
    bar,
    log,
  ]);

  function setPercent(value) {
    const safe = Math.max(MIN_PROGRESS_PERCENT, Math.min(SUCCESS_PROGRESS_PERCENT, Math.round(value)));
    fill.setAttribute("style", `width:${safe}%`);
    bar.setAttribute("aria-valuenow", String(safe));
  }

  function write(line, kind = "info") {
    root.hidden = false;
    log.appendChild(el("div", { class: `calibration-line calibration-${kind}` }, `> ${line}`));
    log.scrollTop = log.scrollHeight;
  }

  return {
    root,
    start(text) {
      root.hidden = false;
      clear(log);
      label.textContent = text || t("models.calibration.running");
      status.textContent = "[CALIBRATING]";
      root.classList.add("is-calibrating");
      setPercent(START_PROGRESS_PERCENT);
    },
    log: write,
    finish(ok, message) {
      status.textContent = ok ? "[OK]" : "[ERR]";
      root.classList.remove("is-calibrating");
      setPercent(ok ? SUCCESS_PROGRESS_PERCENT : ERROR_PROGRESS_PERCENT);
      write(message, ok ? "ok" : "err");
    },
    reset() {
      clear(log);
      label.textContent = t("models.calibration.idle");
      status.textContent = "[READY]";
      root.classList.remove("is-calibrating");
      root.hidden = true;
      setPercent(MIN_PROGRESS_PERCENT);
    },
  };
}
