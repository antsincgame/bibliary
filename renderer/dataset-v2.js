// @ts-check
import { el, clear } from "./dom.js";
import { t } from "./i18n.js";
import { buildCollectionPicker } from "./components/collection-picker.js";
import { buildModelSelect } from "./components/model-select.js";
import { showAlert, showConfirm } from "./components/ui-dialog.js";
import { recordDataset } from "./datasets-history.js";

/**
 * Создание датасета — UI для генерации обучающих примеров через нейросеть.
 *
 * Только LLM-синтез (минуты-часы, через выбранную модель LM Studio).
 * Шаблонный «быстрый экспорт» убран — он давал низкое качество.
 *
 * Готовый JSONL заливается прямо в облачные провайдеры (Google Colab,
 * HuggingFace, Together AI, OpenAI, Fireworks).
 */

const STATE = {
  collection: "delta-knowledge",
  pairsPerConcept: 2,
  /** @type {"sharegpt" | "chatml"} */
  format: "chatml",
  outputDir: "",
  busy: false,
  /** @type {"idle" | "synth"} */
  mode: "idle",
  /** @type {null | {concepts: number; totalLines: number; trainLines: number; valLines: number; outputDir: string; format: string; files: string[]; byDomain: Record<string, number>; method?: string; model?: string; durationMs?: number; llmFailures?: number; schemaFailures?: number; rawSamples?: Array<{conceptId: string; reason: string; raw: string}>}} */
  result: null,
  /** @type {string | null} */
  lastError: null,
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
    /** @type {string | null} */
    currentJobId: null,
  },
  showAdvanced: false,
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
    autoLoad: true,
    onChange: (name) => {
      STATE.collection = String(name || "");
    },
    onCreate: async () => {
      await collectionPicker?.refresh();
    },
    onDelete: async (name) => {
      if (!name) return;
      try {
        const api = /** @type {any} */ (window).api;
        await api.qdrant.remove(name);
        await collectionPicker?.refresh();
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
/* Primary action — LLM synthesis (the only way)                                */
/* ────────────────────────────────────────────────────────────────────────── */

function buildPrimaryAction(root) {
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

  const advanced = buildAdvancedModelRow(root);

  return el("div", { class: "ds-primary-row" }, [
    el("div", { class: "ds-primary-buttons" }, [startBtn, stopBtn]),
    hint,
    advanced,
  ]);
}

function buildAdvancedModelRow(root) {
  const summary = el(
    "summary",
    { class: "ds-advanced-summary" },
    t("dataset.synth.modelOptional.summary"),
  );
  const slot = el("div", { class: "ds-advanced-body", id: "ds-advanced-body" });
  const wrap = el("details", {
    class: "ds-advanced",
    open: STATE.showAdvanced ? "" : null,
    ontoggle: () => {
      const w = root.querySelector(".ds-advanced");
      if (w instanceof HTMLDetailsElement) STATE.showAdvanced = w.open;
    },
  }, [summary, slot]);

  setTimeout(() => mountAdvancedBody(root), 0);
  return wrap;
}

function mountAdvancedBody(root) {
  const slot = root.querySelector("#ds-advanced-body");
  if (!slot) return;
  clear(slot);

  const modelRow = buildModelSelect({
    role: "extractor",
    label: t("dataset.synth.modelOptional.label"),
    hints: SYNTH_MODEL_HINTS,
    wrapClass: "cv-row",
    labelClass: "cv-label ds-advanced-label",
    selectClass: "cv-select ds-advanced-select",
  });
  synthModelSelect = modelRow;

  slot.append(
    modelRow.wrap,
    el("p", { class: "ds-advanced-hint" }, t("dataset.synth.modelOptional.hint")),
  );
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Synthesis actions                                                            */
/* ────────────────────────────────────────────────────────────────────────── */

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
  if (!(await showConfirm(t("dataset.synth.confirm.stop")))) return;
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
  if (start) start.disabled = busy;
  if (stop) stop.disabled = !busy;
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
        t("dataset.synth.progress.line", {
          read: String(p.conceptsRead),
          paired: String(p.paired),
        }),
      ),
    ];
    if (p.skippedLlmFail + p.skippedSchemaFail > 0) {
      lines.push(
        el(
          "p",
          { class: "ds-progress-line ds-progress-warn-line" },
          t("dataset.synth.progress.skipped", {
            llm: String(p.skippedLlmFail),
            schema: String(p.skippedSchemaFail),
          }),
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
        t("dataset.result.summary", {
          train: String(r.trainLines),
          val: String(r.valLines),
          concepts: String(r.concepts),
        }),
      ),
    ];
    const minutes = ((r.durationMs ?? 0) / 60000).toFixed(1);
    lines.push(
      el(
        "p",
        { class: "ds-progress-line ds-fast-note" },
        t("dataset.result.synthExplain", {
          model: String(r.model ?? ""),
          minutes,
        }),
      ),
    );

    /* Если были schema-сбои — показать кнопку «Подробнее» с raw-сэмплами */
    if (r.schemaFailures && r.schemaFailures > 0) {
      lines.push(
        el(
          "p",
          { class: "ds-progress-line ds-progress-warn-line" },
          t("dataset.result.schemaSkippedHint", {
            n: String(r.schemaFailures),
          }),
        ),
      );
      const samples = r.rawSamples || [];
      if (samples.length > 0) {
        lines.push(buildRawSamplesDetails(samples));
      }
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

/**
 * Раскрывающийся блок с сырыми ответами LLM, которые не прошли парсинг.
 * @param {Array<{conceptId: string; reason: string; raw: string}>} samples
 */
function buildRawSamplesDetails(samples) {
  return el("details", { class: "ds-raw-samples" }, [
    el("summary", { class: "ds-raw-samples-summary" },
      t("dataset.result.rawSamples.summary", { n: String(samples.length) })),
    el("p", { class: "ds-raw-samples-hint" },
      t("dataset.result.rawSamples.hint")),
    el("div", { class: "ds-raw-samples-list" },
      samples.map((s, idx) => el("div", { class: "ds-raw-sample" }, [
        el("div", { class: "ds-raw-sample-header" },
          `#${idx + 1} · ${s.conceptId.slice(0, 8)}… · ${s.reason}`),
        el("pre", { class: "ds-raw-sample-body" },
          s.raw.slice(0, 800) + (s.raw.length > 800 ? " …" : "")),
      ])),
    ),
  ]);
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
/* Event handler                                                                */
/* ────────────────────────────────────────────────────────────────────────── */

function handleEvent(root, payload) {
  const stage = String(payload.stage ?? "");
  if (stage !== "synth") return;
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
    el("p", { class: "ds-hero-note" }, t("dataset.hero.synthNote")),
  ]);

  const steps = el("div", { class: "ds-steps" }, [
    buildStep1(root),
    buildStep2(),
    buildStep3(),
    buildStep4(root),
  ]);

  const action = buildPrimaryAction(root);
  const progress = buildProgress();

  root.append(hero, steps, action, progress);
  renderProgress(root);

  if (unsub) unsub();
  unsub = window.api.datasetV2.onEvent((payload) => handleEvent(root, payload));
}

export function isCrystalBusy() {
  return STATE.busy;
}
