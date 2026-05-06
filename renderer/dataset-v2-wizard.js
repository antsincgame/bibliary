// @ts-check
/**
 * Шаги мастера «Создание датасета»: collection picker, pairs/format/folder
 * radio-tiles, primary action button + advanced model picker.
 *
 * Извлечено из `renderer/dataset-v2.js` (Phase 3.4 cross-platform roadmap,
 * 2026-04-30).
 */

import { el, clear } from "./dom.js";
import { t } from "./i18n.js";
import { buildCollectionPicker } from "./components/collection-picker.js";
import { buildModelSelect } from "./components/model-select.js";
import { showAlert } from "./components/ui-dialog.js";
import { STATE, SYNTH_MODEL_HINTS } from "./dataset-v2-state.js";
import { onSynthStart, onSynthStop } from "./dataset-v2-progress.js";

export function buildStep1(root) {
  const card = el("section", { class: "ds-card" }, [
    el("div", { class: "ds-card-num" }, "1"),
    el("div", { class: "ds-card-body" }, [
      el("h3", { class: "ds-card-title" }, t("dataset.step1.title")),
      el("p", { class: "ds-card-hint" }, t("dataset.step1.hint")),
      el("div", { class: "ds-card-control", id: "ds-coll-slot" }),
    ]),
  ]);

  setTimeout(() => mountCollectionPicker(root), 0);
  return card;
}

function mountCollectionPicker(root) {
  const slot = root.querySelector("#ds-coll-slot");
  if (!slot) return;
  clear(slot);
  STATE.refs.collectionPicker = buildCollectionPicker({
    id: "ds-collection",
    initialValue: STATE.collection,
    autoLoad: true,
    onChange: (name) => {
      STATE.collection = String(name || "");
    },
    onCreate: async () => {
      await STATE.refs.collectionPicker?.refresh();
    },
    onDelete: async (name) => {
      if (!name) return;
      try {
        const api = /** @type {any} */ (window).api;
        await api.qdrant.remove(name);
        await STATE.refs.collectionPicker?.refresh();
      } catch (e) {
        await showAlert(t("library.collection.delete.failed", {
          err: e instanceof Error ? e.message : String(e),
        }));
      }
    },
    loadCollections: async () => {
      try {
        return await window.api.getCollections();
      } catch {
        return [];
      }
    },
    createCollection: async (name) => {
      try {
        const r = /** @type {{ ok?: boolean; error?: string } | null} */ (
          await window.api.qdrant.create({ name })
        );
        return r && r.ok !== false
          ? { ok: true }
          : { ok: false, error: r?.error || "unknown" };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
  });
  slot.appendChild(STATE.refs.collectionPicker.root);
}

export function buildStep2() {
  const opts = [
    { v: 1, label: t("dataset.step2.opt1.label"), hint: t("dataset.step2.opt1.hint") },
    { v: 2, label: t("dataset.step2.opt2.label"), hint: t("dataset.step2.opt2.hint") },
    { v: 3, label: t("dataset.step2.opt3.label"), hint: t("dataset.step2.opt3.hint") },
  ];
  const group = el("div", { class: "ds-radio-group", role: "radiogroup" });
  for (const o of opts) {
    const isActive = STATE.pairsPerConcept === o.v;
    const tile = el(
      "button",
      {
        type: "button",
        class: `ds-radio-tile${isActive ? " ds-radio-tile-active" : ""}`,
        "aria-pressed": String(isActive),
        "data-value": String(o.v),
        onclick: (e) => {
          STATE.pairsPerConcept = o.v;
          const root = /** @type {HTMLElement | null} */ (e.currentTarget);
          const grp = root?.closest(".ds-radio-group");
          if (grp) {
            grp.querySelectorAll(".ds-radio-tile").forEach((n) => {
              const node = /** @type {HTMLElement} */ (n);
              node.classList.toggle(
                "ds-radio-tile-active",
                node.dataset.value === String(o.v),
              );
              node.setAttribute(
                "aria-pressed",
                String(node.dataset.value === String(o.v)),
              );
            });
          }
        },
      },
      [
        el("div", { class: "ds-radio-tile-num" }, String(o.v)),
        el("div", { class: "ds-radio-tile-label" }, o.label),
        el("div", { class: "ds-radio-tile-hint" }, o.hint),
      ],
    );
    group.appendChild(tile);
  }

  return el("section", { class: "ds-card" }, [
    el("div", { class: "ds-card-num" }, "2"),
    el("div", { class: "ds-card-body" }, [
      el("h3", { class: "ds-card-title" }, t("dataset.step2.title")),
      el("p", { class: "ds-card-hint" }, t("dataset.step2.hint")),
      group,
    ]),
  ]);
}

export function buildStep3() {
  const opts = [
    {
      v: "chatml",
      label: t("dataset.step3.chatml.label"),
      providers: t("dataset.step3.chatml.providers"),
      recommended: true,
    },
    {
      v: "sharegpt",
      label: t("dataset.step3.sharegpt.label"),
      providers: t("dataset.step3.sharegpt.providers"),
      recommended: false,
    },
  ];
  const group = el("div", { class: "ds-radio-group ds-radio-group-2", role: "radiogroup" });
  for (const o of opts) {
    const isActive = STATE.format === o.v;
    const labelEl = el("div", { class: "ds-radio-tile-label" }, [
      o.label,
      o.recommended ? el("span", { class: "ds-radio-tile-badge" }, t("dataset.step3.recommendedBadge")) : null,
    ].filter(Boolean));
    const tile = el(
      "button",
      {
        type: "button",
        class: `ds-radio-tile ds-radio-tile-wide${isActive ? " ds-radio-tile-active" : ""}`,
        "aria-pressed": String(isActive),
        "data-value": o.v,
        onclick: (e) => {
          STATE.format = /** @type {"sharegpt" | "chatml"} */ (o.v);
          const root = /** @type {HTMLElement | null} */ (e.currentTarget);
          const grp = root?.closest(".ds-radio-group");
          if (grp) {
            grp.querySelectorAll(".ds-radio-tile").forEach((n) => {
              const node = /** @type {HTMLElement} */ (n);
              node.classList.toggle("ds-radio-tile-active", node.dataset.value === o.v);
              node.setAttribute("aria-pressed", String(node.dataset.value === o.v));
            });
          }
        },
      },
      [
        labelEl,
        el("div", { class: "ds-radio-tile-hint" }, o.providers),
      ],
    );
    group.appendChild(tile);
  }

  return el("section", { class: "ds-card" }, [
    el("div", { class: "ds-card-num" }, "3"),
    el("div", { class: "ds-card-body" }, [
      el("h3", { class: "ds-card-title" }, t("dataset.step3.title")),
      el("p", { class: "ds-card-hint" }, t("dataset.step3.hint")),
      group,
      el("p", { class: "ds-card-note" }, t("dataset.step3.colabNote")),
    ]),
  ]);
}

export function buildStep4(root) {
  const pathLabel = el(
    "div",
    { class: "ds-path-display", id: "ds-path-display" },
    STATE.outputDir || t("dataset.step4.empty"),
  );
  const btn = el(
    "button",
    {
      class: "cv-btn cv-btn-accent",
      type: "button",
      onclick: async () => {
        try {
          const dir = await window.api.datasetV2.pickExportDir();
          if (dir) {
            STATE.outputDir = dir;
            const node = root.querySelector("#ds-path-display");
            if (node) node.textContent = dir;
            const empty = node?.classList;
            if (empty) empty.toggle("ds-path-display-empty", false);
          }
        } catch (e) {
          await showAlert(e instanceof Error ? e.message : String(e));
        }
      },
    },
    t("dataset.step4.pick"),
  );

  if (!STATE.outputDir) pathLabel.classList.add("ds-path-display-empty");

  return el("section", { class: "ds-card" }, [
    el("div", { class: "ds-card-num" }, "4"),
    el("div", { class: "ds-card-body" }, [
      el("h3", { class: "ds-card-title" }, t("dataset.step4.title")),
      el("p", { class: "ds-card-hint" }, t("dataset.step4.hint")),
      el("div", { class: "ds-path-row" }, [pathLabel, btn]),
    ]),
  ]);
}

export function buildPrimaryAction(root) {
  const startBtn = el(
    "button",
    {
      class: "ds-primary-btn",
      type: "button",
      id: "ds-synth-start",
      onclick: () => onSynthStart(root),
    },
    t("dataset.synth.btn.start"),
  );
  const stopBtn = el(
    "button",
    {
      class: "ds-stop-btn",
      type: "button",
      id: "ds-synth-stop",
      disabled: "true",
      onclick: () => onSynthStop(root),
    },
    t("dataset.synth.btn.stop"),
  );
  const hint = el("p", { class: "ds-primary-hint" }, t("dataset.synth.hint"));

  const modelRow = buildPrimaryModelRow(root);

  return el("div", { class: "ds-primary-row" }, [
    modelRow,
    el("div", { class: "ds-primary-buttons" }, [startBtn, stopBtn]),
    hint,
  ]);
}

function buildPrimaryModelRow(root) {
  const slot = el("div", { class: "ds-model-row", id: "ds-model-row" });
  setTimeout(() => mountModelRow(root), 0);
  return slot;
}

function mountModelRow(root) {
  const slot = root.querySelector("#ds-model-row");
  if (!slot) return;
  clear(slot);

  const modelRow = buildModelSelect({
    role: "extractor",
    label: t("dataset.synth.model.label"),
    hints: SYNTH_MODEL_HINTS,
    wrapClass: "cv-row ds-model-select-row",
    labelClass: "cv-label ds-model-label",
    selectClass: "cv-select ds-model-select",
  });
  STATE.refs.synthModelSelect = modelRow;

  slot.append(
    modelRow.wrap,
    el("p", { class: "ds-model-hint" }, t("dataset.synth.model.hint")),
  );
}
