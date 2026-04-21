// @ts-check
import { el } from "./dom.js";
import { t } from "./i18n.js";
import { makeGlossaryButton } from "./dataset-glossary.js";

export const STEP_IDS = [1, 2, 3, 4];

export const ONBOARD_KEY = "bibliary_dataset_onboarded";

export function buildStepper({ currentStep, maxReachedStep, totals, onJump, onReplay }) {
  const items = STEP_IDS.map((id) => {
    const reached = id <= maxReachedStep;
    const isCurrent = id === currentStep;
    const cls = [
      "stepper-item",
      isCurrent ? "is-current" : "",
      reached ? "is-reached" : "is-pending",
      reached && !isCurrent ? "is-clickable" : "",
    ]
      .filter(Boolean)
      .join(" ");

    return el(
      "button",
      {
        type: "button",
        class: cls,
        disabled: reached && !isCurrent ? null : "true",
        onclick: () => {
          if (reached && !isCurrent) onJump?.(id);
        },
      },
      [
        el("span", { class: "stepper-num" }, String(id)),
        el("span", { class: "stepper-label" }, t(`stepper.step.${id}`)),
      ]
    );
  });

  const totalsBlock = el("div", { class: "stepper-totals" }, [
    totalsPair("totals-num", totals.total ?? 0, t("stepper.totals.total")),
    el("span", { class: "totals-sep" }, "·"),
    totalsPair("totals-num totals-done", totals.done ?? 0, t("stepper.totals.done")),
    el("span", { class: "totals-sep" }, "·"),
    totalsPair("totals-num totals-left", totals.left ?? 0, t("stepper.totals.left")),
  ]);

  const replayBtn = el(
    "button",
    {
      type: "button",
      class: "stepper-replay",
      title: t("stepper.replay.title"),
      onclick: () => onReplay?.(),
    },
    t("stepper.replay")
  );

  const help = makeGlossaryButton(["chunk", "T1", "T2", "T3", "fewshot", "batch"], "?");
  help.classList.add("stepper-help");

  return el("div", { class: "stepper" }, [
    el("div", { class: "stepper-line" }, items),
    el("div", { class: "stepper-meta" }, [totalsBlock, replayBtn, help]),
  ]);
}

function totalsPair(numClass, value, caption) {
  return el("span", { class: "totals-pair" }, [
    el("span", { class: numClass }, String(value)),
    el("span", { class: "totals-cap" }, caption),
  ]);
}

export function isOnboarded() {
  try {
    return localStorage.getItem(ONBOARD_KEY) === "1";
  } catch {
    return false;
  }
}

export function markOnboarded() {
  try {
    localStorage.setItem(ONBOARD_KEY, "1");
  } catch {
    // ignore
  }
}

export function clearOnboarded() {
  try {
    localStorage.removeItem(ONBOARD_KEY);
  } catch {
    // ignore
  }
}
