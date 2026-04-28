// @ts-check
import { el, clear } from "./dom.js";
import { t } from "./i18n.js";
import { buildCollectionPicker } from "./components/collection-picker.js";
import { buildModelSelect } from "./components/model-select.js";
import { showAlert } from "./components/ui-dialog.js";
import { recordDataset } from "./datasets-history.js";

/**
 * Создание датасета — простой UI для генерации обучающих примеров из принятых
 * концептов в Qdrant.
 *
 * Два режима в одной странице:
 *   1) Быстрый шаблонный экспорт (секунды, без LLM) — большая жёлтая кнопка.
 *   2) LLM-синтез (минуты-часы, через выбранную модель LM Studio) —
 *      сворачиваемая секция «Сгенерировать через нейросеть».
 *
 * Готовый JSONL заливается прямо в облачные провайдеры (Together AI,
 * OpenAI, Fireworks, HuggingFace).
 */

const STATE = {
  collection: "delta-knowledge",
  pairsPerConcept: 2,
  /** @type {"sharegpt" | "chatml"} */
  format: "sharegpt",
  outputDir: "",
  busy: false,
  /** @type {"idle" | "export" | "synth"} */
  mode: "idle",
  /** @type {null | {concepts: number; totalLines: number; trainLines: number; valLines: number; outputDir: string; format: string; files: string[]; byDomain: Record<string, number>; method?: string; model?: string; durationMs?: number; llmFailures?: number; schemaFailures?: number}} */
  result: null,
  /** @type {string | null} */
  lastError: null,
  exportProgress: { conceptsRead: 0, linesEmitted: 0 },
  synthProgress: {
    phase: /** @type {"idle"|"scan"|"generate"|"write"|"done"|"error"} */ ("idle"),
    conceptsRead: 0,
    paired: 0,
    skippedEmpty: 0,
    skippedLlmFail: 0,
    skippedSchemaFail: 0,
    /** @type {string | null} */
    currentDomain: null,
    /** @type {string | null} */
    currentEssence: null,
  },
  synth: {
    open: false,
    /** @type {string | null} */
    currentJobId: null,
  },
};

const SYNTH_MODEL_HINTS = ["qwen3.6", "qwen3-coder", "qwen2.5", "mistral-small", "gemma-3"];

let unsub = null;
let collectionPicker = /** @type {ReturnType<typeof buildCollectionPicker> | null} */ (null);
let synthModelSelect = /** @type {ReturnType<typeof buildModelSelect> | null} */ (null);

/* ────────────────────────────────────────────────────────────────────────── */
/* Step 1 — collection picker                                                  */
/* ────────────────────────────────────────────────────────────────────────── */

function buildStep1(root) {
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
  collectionPicker = buildCollectionPicker({
    id: "ds-collection",
    initialValue: STATE.collection,
    onChange: (name) => {
      STATE.collection = String(name || "");
    },
    onCreate: async () => {
      await collectionPicker?.refresh();
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
  slot.appendChild(collectionPicker.root);
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Step 2 — pairs per concept (radio)                                          */
/* ────────────────────────────────────────────────────────────────────────── */

function buildStep2() {
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

/* ────────────────────────────────────────────────────────────────────────── */
/* Step 3 — format                                                             */
/* ────────────────────────────────────────────────────────────────────────── */

function buildStep3() {
  const opts = [
    {
      v: "sharegpt",
      label: t("dataset.step3.sharegpt.label"),
      providers: t("dataset.step3.sharegpt.providers"),
    },
    {
      v: "chatml",
      label: t("dataset.step3.chatml.label"),
      providers: t("dataset.step3.chatml.providers"),
    },
  ];
  const group = el("div", { class: "ds-radio-group ds-radio-group-2", role: "radiogroup" });
  for (const o of opts) {
    const isActive = STATE.format === o.v;
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
        el("div", { class: "ds-radio-tile-label" }, o.label),
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
    ]),
  ]);
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Step 4 — folder                                                             */
/* ────────────────────────────────────────────────────────────────────────── */

function buildStep4(root) {
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

/* ────────────────────────────────────────────────────────────────────────── */
/* Primary action — fast template export                                       */
/* ────────────────────────────────────────────────────────────────────────── */

function buildPrimaryAction(root) {
  const btn = el(
    "button",
    {
      class: "ds-primary-btn",
      type: "button",
      id: "ds-create",
      onclick: () => onCreateDataset(root),
    },
    t("dataset.create.btn"),
  );
  const hint = el("p", { class: "ds-primary-hint" }, t("dataset.create.hint"));
  return el("div", { class: "ds-primary-row" }, [btn, hint]);
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Synth section — LLM-driven dataset generation                                */
/* ────────────────────────────────────────────────────────────────────────── */

function buildSynthSection(root) {
  const detail = el(
    "details",
    {
      class: "ds-synth",
      open: STATE.synth.open ? "" : null,
      ontoggle: () => {
        STATE.synth.open = /** @type {HTMLDetailsElement} */ (detail).open;
      },
    },
    [
      el("summary", { class: "ds-synth-summary" }, [
        el("span", { class: "ds-synth-summary-icon" }, "✦"),
        el("span", { class: "ds-synth-summary-label" }, t("dataset.synth.summary")),
      ]),
      el("p", { class: "ds-synth-hint" }, t("dataset.synth.hint")),
      el("div", { class: "ds-synth-body", id: "ds-synth-body" }),
    ],
  );
  setTimeout(() => renderSynthBody(root), 0);
  return detail;
}

function renderSynthBody(root) {
  const body = root.querySelector("#ds-synth-body");
  if (!body) return;
  clear(body);

  const modelRow = buildModelSelect({
    role: "extractor",
    label: t("dataset.synth.model.label"),
    hints: SYNTH_MODEL_HINTS,
    wrapClass: "cv-row",
    labelClass: "cv-label",
    selectClass: "cv-select",
  });
  synthModelSelect = modelRow;

  const startBtn = el(
    "button",
    {
      class: "ds-synth-btn",
      type: "button",
      id: "ds-synth-start",
      disabled: STATE.busy ? "true" : null,
      onclick: () => onSynthStart(root),
    },
    t("dataset.synth.btn.start"),
  );

  const stopBtn = el(
    "button",
    {
      class: "cv-btn",
      type: "button",
      id: "ds-synth-stop",
      disabled: STATE.busy && STATE.mode === "synth" ? null : "true",
      onclick: () => onSynthStop(root),
    },
    t("dataset.synth.btn.stop"),
  );

  body.append(
    modelRow.wrap,
    el("div", { class: "ds-synth-controls" }, [startBtn, stopBtn]),
  );
}

async function onSynthStart(root) {
  if (STATE.busy) return;
  if (!STATE.collection) {
    await showAlert(t("dataset.alert.noCollection"));
    return;
  }
  if (!STATE.outputDir) {
    await showAlert(t("dataset.alert.noFolder"));
    return;
  }
  const model = synthModelSelect?.getValue() ?? "";
  if (!model) {
    await showAlert(t("dataset.synth.alert.noModel"));
    return;
  }

  STATE.busy = true;
  STATE.mode = "synth";
  STATE.result = null;
  STATE.lastError = null;
  STATE.synthProgress = {
    phase: "scan",
    conceptsRead: 0,
    paired: 0,
    skippedEmpty: 0,
    skippedLlmFail: 0,
    skippedSchemaFail: 0,
    currentDomain: null,
    currentEssence: null,
  };
  renderProgress(root);
  toggleSynthButtons(root, true);

  try {
    const res = await window.api.datasetV2.synthesize({
      collection: STATE.collection,
      outputDir: STATE.outputDir,
      format: STATE.format,
      pairsPerConcept: STATE.pairsPerConcept,
      model,
    });
    if (!res.ok || !res.stats) {
      STATE.lastError = res.error || t("dataset.alert.unknownError");
    } else {
      STATE.result = {
        ...res.stats,
        method: "llm-synth",
      };
      recordDataset({
        outputDir: res.stats.outputDir,
        collection: STATE.collection,
        format: res.stats.format,
        method: "llm-synth",
        model: res.stats.model,
        concepts: res.stats.concepts,
        totalLines: res.stats.totalLines,
        trainLines: res.stats.trainLines,
        valLines: res.stats.valLines,
        durationMs: res.stats.durationMs,
        createdAt: new Date().toISOString(),
      });
    }
  } catch (e) {
    STATE.lastError = e instanceof Error ? e.message : String(e);
  } finally {
    STATE.busy = false;
    STATE.mode = "idle";
    STATE.synth.currentJobId = null;
    toggleSynthButtons(root, false);
    renderProgress(root);
  }
}

async function onSynthStop(root) {
  if (!STATE.synth.currentJobId) return;
  try {
    await window.api.datasetV2.cancel(STATE.synth.currentJobId);
  } catch (e) {
    console.warn("[synth] cancel failed", e);
  }
  toggleSynthButtons(root, false);
}

function toggleSynthButtons(root, busy) {
  const start = root.querySelector("#ds-synth-start");
  const stop = root.querySelector("#ds-synth-stop");
  const create = root.querySelector("#ds-create");
  if (start) start.disabled = busy;
  if (stop) stop.disabled = !busy;
  if (create) create.disabled = busy;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Progress + Result blocks                                                    */
/* ────────────────────────────────────────────────────────────────────────── */

function buildProgress() {
  return el("div", { class: "ds-progress", id: "ds-progress" });
}

function renderProgress(root) {
  const wrap = root.querySelector("#ds-progress");
  if (!wrap) return;
  clear(wrap);

  if (!STATE.busy && !STATE.result && !STATE.lastError) return;

  if (STATE.busy && STATE.mode === "synth") {
    const p = STATE.synthProgress;
    const phaseLabel = phaseToLabel(p.phase);
    const lines = [
      el("p", { class: "ds-progress-line" }, phaseLabel),
      el(
        "p",
        { class: "ds-progress-line" },
        t("dataset.synth.progress.line")
          .replace("{read}", String(p.conceptsRead))
          .replace("{paired}", String(p.paired)),
      ),
    ];
    if (p.skippedLlmFail + p.skippedSchemaFail > 0) {
      lines.push(
        el(
          "p",
          { class: "ds-progress-line ds-progress-warn-line" },
          t("dataset.synth.progress.skipped")
            .replace("{llm}", String(p.skippedLlmFail))
            .replace("{schema}", String(p.skippedSchemaFail)),
        ),
      );
    }
    if (p.currentDomain && p.currentEssence) {
      lines.push(
        el(
          "p",
          { class: "ds-progress-line ds-progress-current" },
          `${p.currentDomain} · ${p.currentEssence}`,
        ),
      );
    }
    wrap.appendChild(
      el("div", { class: "ds-progress-card ds-progress-running" }, [
        el("div", { class: "ds-progress-spinner" }),
        el("div", { class: "ds-progress-body" }, [
          el("h4", { class: "ds-progress-title" }, t("dataset.synth.progress.title")),
          ...lines,
        ]),
      ]),
    );
    return;
  }

  if (STATE.busy) {
    wrap.appendChild(
      el("div", { class: "ds-progress-card ds-progress-running" }, [
        el("div", { class: "ds-progress-spinner" }),
        el("div", { class: "ds-progress-body" }, [
          el("h4", { class: "ds-progress-title" }, t("dataset.progress.running.title")),
          el(
            "p",
            { class: "ds-progress-line" },
            t("dataset.progress.running.line")
              .replace("{concepts}", String(STATE.exportProgress.conceptsRead))
              .replace("{lines}", String(STATE.exportProgress.linesEmitted)),
          ),
        ]),
      ]),
    );
    return;
  }

  if (STATE.lastError) {
    wrap.appendChild(
      el("div", { class: "ds-progress-card ds-progress-error" }, [
        el("div", { class: "ds-progress-icon" }, "!"),
        el("div", { class: "ds-progress-body" }, [
          el("h4", { class: "ds-progress-title" }, t("dataset.progress.error.title")),
          el("p", { class: "ds-progress-line" }, STATE.lastError),
        ]),
      ]),
    );
    return;
  }

  if (STATE.result) {
    const r = STATE.result;
    const isSynth = r.method === "llm-synth";
    const filesList = el(
      "ul",
      { class: "ds-result-files" },
      r.files.map((f) => el("li", { class: "ds-result-file" }, f)),
    );
    const openFolderBtn = el(
      "button",
      {
        class: "cv-btn cv-btn-accent ds-open-folder",
        type: "button",
        onclick: async () => {
          try {
            await window.api.datasetV2.openFolder(r.outputDir);
          } catch (e) {
            await showAlert(e instanceof Error ? e.message : String(e));
          }
        },
      },
      t("dataset.result.openFolder"),
    );
    const reviewBtn = el(
      "button",
      {
        class: "cv-btn",
        type: "button",
        onclick: () => {
          /** @type {HTMLButtonElement | null} */
          const trigger = document.querySelector('.sidebar-icon[data-route="datasets"]');
          trigger?.click();
        },
      },
      t("dataset.result.review"),
    );

    const lines = [
      el(
        "p",
        { class: "ds-progress-line" },
        t("dataset.result.summary")
          .replace("{train}", String(r.trainLines))
          .replace("{val}", String(r.valLines))
          .replace("{concepts}", String(r.concepts)),
      ),
    ];
    if (isSynth) {
      const minutes = ((r.durationMs ?? 0) / 60000).toFixed(1);
      lines.push(
        el(
          "p",
          { class: "ds-progress-line ds-fast-note" },
          t("dataset.result.synthExplain")
            .replace("{model}", String(r.model ?? ""))
            .replace("{minutes}", minutes),
        ),
      );
    } else {
      lines.push(
        el(
          "p",
          { class: "ds-progress-line ds-fast-note" },
          t("dataset.result.fastExplain"),
        ),
      );
    }

    wrap.appendChild(
      el("div", { class: "ds-progress-card ds-progress-success" }, [
        el("div", { class: "ds-progress-icon ds-progress-icon-good" }, "✓"),
        el("div", { class: "ds-progress-body" }, [
          el("h4", { class: "ds-progress-title" }, t("dataset.result.title")),
          ...lines,
          el("div", { class: "ds-result-path" }, r.outputDir),
          filesList,
          el("div", { class: "ds-result-actions" }, [openFolderBtn, reviewBtn]),
        ]),
      ]),
    );

    /* «Контроль качества» — топ-доменов */
    const domains = Object.entries(r.byDomain)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8);
    if (domains.length > 0) {
      const detail = el("details", { class: "ds-quality" }, [
        el("summary", { class: "ds-quality-summary" }, t("dataset.quality.summary")),
        el("p", { class: "ds-quality-hint" }, t("dataset.quality.hint")),
        el(
          "div",
          { class: "ds-quality-grid" },
          domains.map(([d, n]) =>
            el("div", { class: "ds-quality-cell" }, [
              el("div", { class: "ds-quality-cell-name" }, d),
              el("div", { class: "ds-quality-cell-count" }, String(n)),
            ]),
          ),
        ),
      ]);
      wrap.appendChild(detail);
    }
  }
}

function phaseToLabel(phase) {
  switch (phase) {
    case "scan":
      return t("dataset.synth.phase.scan");
    case "generate":
      return t("dataset.synth.phase.generate");
    case "write":
      return t("dataset.synth.phase.write");
    case "done":
      return t("dataset.synth.phase.done");
    default:
      return t("dataset.synth.phase.idle");
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Action: fast export                                                         */
/* ────────────────────────────────────────────────────────────────────────── */

async function onCreateDataset(root) {
  if (STATE.busy) return;
  if (!STATE.collection) {
    await showAlert(t("dataset.alert.noCollection"));
    return;
  }
  if (!STATE.outputDir) {
    await showAlert(t("dataset.alert.noFolder"));
    return;
  }
  STATE.busy = true;
  STATE.mode = "export";
  STATE.result = null;
  STATE.lastError = null;
  STATE.exportProgress = { conceptsRead: 0, linesEmitted: 0 };
  renderProgress(root);
  const btn = root.querySelector("#ds-create");
  if (btn) btn.disabled = true;

  try {
    const res = await window.api.datasetV2.exportDataset({
      collection: STATE.collection,
      outputDir: STATE.outputDir,
      format: STATE.format,
      pairsPerConcept: STATE.pairsPerConcept,
    });
    if (!res.ok || !res.stats) {
      STATE.lastError = res.error || t("dataset.alert.unknownError");
    } else {
      STATE.result = res.stats;
      recordDataset({
        outputDir: res.stats.outputDir,
        collection: STATE.collection,
        format: res.stats.format,
        method: "template",
        concepts: res.stats.concepts,
        totalLines: res.stats.totalLines,
        trainLines: res.stats.trainLines,
        valLines: res.stats.valLines,
        createdAt: new Date().toISOString(),
      });
    }
  } catch (e) {
    STATE.lastError = e instanceof Error ? e.message : String(e);
  } finally {
    STATE.busy = false;
    STATE.mode = "idle";
    if (btn) btn.disabled = false;
    renderProgress(root);
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Event handler                                                                */
/* ────────────────────────────────────────────────────────────────────────── */

function handleEvent(root, payload) {
  const stage = String(payload.stage ?? "");

  if (stage === "export") {
    if (String(payload.phase) === "progress") {
      STATE.exportProgress = {
        conceptsRead: Number(payload.conceptsRead ?? STATE.exportProgress.conceptsRead),
        linesEmitted: Number(payload.linesEmitted ?? STATE.exportProgress.linesEmitted),
      };
      renderProgress(root);
    }
    return;
  }

  if (stage === "synth") {
    if (payload.jobId && !STATE.synth.currentJobId) {
      STATE.synth.currentJobId = String(payload.jobId);
    }
    const phase = String(payload.phase ?? "");
    if (phase === "progress" || phase === "start") {
      STATE.synthProgress = {
        phase: /** @type {any} */ (String(payload.phase ?? STATE.synthProgress.phase)),
        conceptsRead: Number(payload.conceptsRead ?? STATE.synthProgress.conceptsRead),
        paired: Number(payload.paired ?? STATE.synthProgress.paired),
        skippedEmpty: Number(payload.skippedEmpty ?? STATE.synthProgress.skippedEmpty),
        skippedLlmFail: Number(payload.skippedLlmFail ?? STATE.synthProgress.skippedLlmFail),
        skippedSchemaFail: Number(
          payload.skippedSchemaFail ?? STATE.synthProgress.skippedSchemaFail,
        ),
        currentDomain: payload.currentDomain ? String(payload.currentDomain) : null,
        currentEssence: payload.currentEssence ? String(payload.currentEssence) : null,
      };
      renderProgress(root);
    }
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Mount                                                                       */
/* ────────────────────────────────────────────────────────────────────────── */

export function mountCrystal(root) {
  if (!root) return;
  if (root.dataset.mounted === "1") return;
  root.dataset.mounted = "1";
  clear(root);

  /* Read cross-section pre-fill (set by Library "Создать датасет") */
  try {
    const prefill = sessionStorage.getItem("bibliary_dataset_prefill_collection");
    if (prefill) {
      STATE.collection = prefill;
      sessionStorage.removeItem("bibliary_dataset_prefill_collection");
    }
  } catch {
    /* sessionStorage may be unavailable */
  }

  const hero = el("header", { class: "ds-hero" }, [
    el("h1", { class: "ds-hero-title" }, t("dataset.hero.title")),
    el("p", { class: "ds-hero-sub" }, t("dataset.hero.sub")),
    el("p", { class: "ds-hero-note" }, t("dataset.hero.fastNote")),
  ]);

  const steps = el("div", { class: "ds-steps" }, [
    buildStep1(root),
    buildStep2(),
    buildStep3(),
    buildStep4(root),
  ]);

  const action = buildPrimaryAction(root);
  const progress = buildProgress();
  const synth = buildSynthSection(root);

  root.append(hero, steps, action, progress, synth);
  renderProgress(root);

  if (unsub) unsub();
  unsub = window.api.datasetV2.onEvent((payload) => handleEvent(root, payload));
}

export function isCrystalBusy() {
  return STATE.busy;
}
