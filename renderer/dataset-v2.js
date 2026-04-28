// @ts-check
import { el, clear } from "./dom.js";
import { t } from "./i18n.js";
import { buildCollectionPicker } from "./components/collection-picker.js";
import { buildModelSelect } from "./components/model-select.js";
import { showAlert } from "./components/ui-dialog.js";

/**
 * Создание датасета — простой UI для генерации обучающих примеров из принятых
 * концептов в Qdrant. Готовый JSONL заливается прямо в облачные провайдеры
 * (Together AI, OpenAI, Fireworks, HuggingFace).
 *
 * Поток в 4 шага:
 *   1. Какая коллекция знаний (где лежат принятые концепты)
 *   2. Сколько примеров на концепт (1 / 2 / 3)
 *   3. Формат для облака (ShareGPT / ChatML)
 *   4. Папка сохранения
 *
 * Внизу страницы — раскрывающийся «расширенный режим» с прежним извлечением
 * δ-знаний из книг в коллекции. Бабушкам не показываем, опытным — рядом.
 */

const STATE = {
  collection: "delta-knowledge",
  pairsPerConcept: 2,
  /** @type {"sharegpt" | "chatml"} */
  format: "sharegpt",
  outputDir: "",
  busy: false,
  /** @type {null | {concepts: number; totalLines: number; trainLines: number; valLines: number; outputDir: string; format: string; files: string[]; byDomain: Record<string, number>}} */
  result: null,
  /** @type {string | null} */
  lastError: null,
  exportProgress: { conceptsRead: 0, linesEmitted: 0 },

  /* «Расширенный режим» — старое извлечение из книги */
  advanced: {
    open: false,
    /** @type {Array<{collection: string, books: Array<{bookSourcePath: string, fileName: string, totalChunks: number, status: string}>}>} */
    history: [],
    selectedBook: "",
    extractBusy: false,
    /** @type {string | null} */
    currentJobId: null,
    /** @type {Array<{ts: number, msg: string, level: "info"|"good"|"warn"|"bad"}>} */
    log: [],
    stats: { chapter: 0, chapters: 0, accepted: 0, skipped: 0 },
  },
};

let unsub = null;
let collectionPicker = /** @type {ReturnType<typeof buildCollectionPicker> | null} */ (null);
let extractorSelect = /** @type {ReturnType<typeof buildModelSelect> | null} */ (null);

const EXTRACTOR_HINTS = ["qwen3.6", "qwen3-coder", "mistral-small", "qwen3.5"];

/* ────────────────────────────────────────────────────────────────────────── */
/* Render helpers                                                              */
/* ────────────────────────────────────────────────────────────────────────── */

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString();
}

function pushLog(msg, level = "info") {
  STATE.advanced.log.push({ ts: Date.now(), msg: String(msg).slice(0, 240), level });
  if (STATE.advanced.log.length > 200) STATE.advanced.log = STATE.advanced.log.slice(-150);
}

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
    const tile = el("button", {
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
    }, [
      el("div", { class: "ds-radio-tile-num" }, String(o.v)),
      el("div", { class: "ds-radio-tile-label" }, o.label),
      el("div", { class: "ds-radio-tile-hint" }, o.hint),
    ]);
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
/* Step 3 — format (radio)                                                     */
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
    const tile = el("button", {
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
    }, [
      el("div", { class: "ds-radio-tile-label" }, o.label),
      el("div", { class: "ds-radio-tile-hint" }, o.providers),
    ]);
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
/* Step 4 — output folder                                                      */
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
/* Big "Create" button                                                         */
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
  return el("div", { class: "ds-primary-row" }, [btn]);
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

  if (STATE.busy) {
    wrap.appendChild(
      el("div", { class: "ds-progress-card ds-progress-running" }, [
        el("div", { class: "ds-progress-spinner" }),
        el("div", { class: "ds-progress-body" }, [
          el("h4", { class: "ds-progress-title" }, t("dataset.progress.running.title")),
          el("p", { class: "ds-progress-line" },
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
    const filesList = el(
      "ul",
      { class: "ds-result-files" },
      r.files.map((f) => el("li", { class: "ds-result-file" }, f)),
    );
    const btn = el(
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
    wrap.appendChild(
      el("div", { class: "ds-progress-card ds-progress-success" }, [
        el("div", { class: "ds-progress-icon ds-progress-icon-good" }, "✓"),
        el("div", { class: "ds-progress-body" }, [
          el("h4", { class: "ds-progress-title" }, t("dataset.result.title")),
          el("p", { class: "ds-progress-line" },
            t("dataset.result.summary")
              .replace("{train}", String(r.trainLines))
              .replace("{val}", String(r.valLines))
              .replace("{concepts}", String(r.concepts)),
          ),
          el("div", { class: "ds-result-path" }, r.outputDir),
          filesList,
          btn,
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

/* ────────────────────────────────────────────────────────────────────────── */
/* Action: create dataset                                                      */
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
    }
  } catch (e) {
    STATE.lastError = e instanceof Error ? e.message : String(e);
  } finally {
    STATE.busy = false;
    if (btn) btn.disabled = false;
    renderProgress(root);
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Advanced — старое извлечение δ-знаний из книги                             */
/* ────────────────────────────────────────────────────────────────────────── */

async function loadAdvancedHistory() {
  try {
    STATE.advanced.history = await window.api.scanner.listHistory();
  } catch {
    STATE.advanced.history = [];
  }
}

function buildAdvancedSection(root) {
  const detail = el("details", {
    class: "ds-advanced",
    open: STATE.advanced.open ? "" : null,
    ontoggle: () => {
      const open = /** @type {HTMLDetailsElement} */ (detail).open;
      STATE.advanced.open = open;
      if (open && STATE.advanced.history.length === 0) {
        loadAdvancedHistory().then(() => renderAdvanced(root));
      }
    },
  }, [
    el("summary", { class: "ds-advanced-summary" }, t("dataset.advanced.summary")),
    el("div", { class: "ds-advanced-hint" }, t("dataset.advanced.hint")),
    el("div", { class: "ds-advanced-body", id: "ds-advanced-body" }),
  ]);
  setTimeout(() => renderAdvanced(root), 0);
  return detail;
}

function renderAdvanced(root) {
  const body = root.querySelector("#ds-advanced-body");
  if (!body) return;
  clear(body);

  /* Source row */
  const srcSelect = el("select", {
    class: "cv-select",
    onchange: (e) => {
      STATE.advanced.selectedBook = /** @type {HTMLSelectElement} */ (e.target).value;
    },
  });
  if (STATE.advanced.history.length === 0) {
    srcSelect.appendChild(el("option", { value: "" }, t("dataset.advanced.src.empty")));
    srcSelect.disabled = true;
  } else {
    srcSelect.appendChild(el("option", { value: "" }, "—"));
    for (const grp of STATE.advanced.history) {
      const og = el("optgroup", { label: grp.collection });
      for (const b of grp.books) {
        const opt = el(
          "option",
          { value: b.bookSourcePath },
          `${b.fileName} (${b.totalChunks} · ${b.status})`,
        );
        if (b.bookSourcePath === STATE.advanced.selectedBook) opt.selected = true;
        og.appendChild(opt);
      }
      srcSelect.appendChild(og);
    }
  }

  /* Extractor model */
  const extractorRow = buildModelSelect({
    role: "extractor",
    label: t("dataset.advanced.model"),
    hints: EXTRACTOR_HINTS,
    wrapClass: "cv-row",
    labelClass: "cv-label",
    selectClass: "cv-select",
  });
  extractorSelect = extractorRow;

  /* Buttons */
  const startBtn = el("button", {
    class: "cv-btn cv-btn-accent",
    type: "button",
    disabled: STATE.advanced.extractBusy ? "true" : null,
    onclick: () => onAdvancedStart(root),
  }, t("dataset.advanced.btn.start"));

  const stopBtn = el("button", {
    class: "cv-btn",
    type: "button",
    disabled: STATE.advanced.extractBusy ? null : "true",
    onclick: () => onAdvancedStop(root),
  }, t("dataset.advanced.btn.stop"));

  const refresh = el("button", {
    class: "cv-btn",
    type: "button",
    title: "↻",
    onclick: async () => {
      await Promise.all([
        loadAdvancedHistory(),
        extractorSelect?.refresh() ?? Promise.resolve(),
      ]);
      renderAdvanced(root);
    },
  }, "↻");

  /* Stats */
  const s = STATE.advanced.stats;
  const stats = el("div", { class: "ds-advanced-stats" }, [
    el("div", { class: "ds-stat" }, [
      el("div", { class: "ds-stat-label" }, t("dataset.advanced.stat.chapter")),
      el("div", { class: "ds-stat-value" }, s.chapter > 0 ? `${s.chapter} / ${s.chapters || "?"}` : "—"),
    ]),
    el("div", { class: "ds-stat" }, [
      el("div", { class: "ds-stat-label" }, t("dataset.advanced.stat.accepted")),
      el("div", { class: "ds-stat-value ds-stat-good" }, String(s.accepted)),
    ]),
    el("div", { class: "ds-stat" }, [
      el("div", { class: "ds-stat-label" }, t("dataset.advanced.stat.skipped")),
      el("div", { class: "ds-stat-value ds-stat-warn" }, String(s.skipped)),
    ]),
  ]);

  /* Log */
  const log = el("div", { class: "ds-advanced-log" });
  if (STATE.advanced.log.length === 0) {
    log.appendChild(el("div", { class: "ds-advanced-log-empty" }, t("dataset.advanced.log.empty")));
  } else {
    for (const ev of STATE.advanced.log.slice().reverse()) {
      log.appendChild(
        el("div", { class: `ds-advanced-log-row ds-advanced-log-${ev.level}` }, [
          el("span", { class: "ds-advanced-log-time" }, fmtTime(ev.ts)),
          el("span", { class: "ds-advanced-log-msg" }, ev.msg),
        ]),
      );
    }
  }

  body.append(
    el("label", { class: "cv-label" }, t("dataset.advanced.src.label")),
    srcSelect,
    extractorRow.wrap,
    el("div", { class: "cv-actions" }, [startBtn, stopBtn, refresh]),
    stats,
    log,
  );
}

async function onAdvancedStart(root) {
  if (STATE.advanced.extractBusy) return;
  if (!STATE.advanced.selectedBook) {
    await showAlert(t("dataset.advanced.alert.noBook"));
    return;
  }
  if (!STATE.collection) {
    await showAlert(t("dataset.alert.noCollection"));
    return;
  }
  const extractModel = extractorSelect?.getValue() ?? "";
  if (!extractModel) {
    await showAlert(t("dataset.advanced.alert.noModel"));
    return;
  }
  STATE.advanced.extractBusy = true;
  STATE.advanced.log = [];
  STATE.advanced.stats = { chapter: 0, chapters: 0, accepted: 0, skipped: 0 };
  pushLog(t("dataset.advanced.event.started"), "info");
  renderAdvanced(root);

  try {
    const result = await window.api.datasetV2.startExtraction({
      bookSourcePath: STATE.advanced.selectedBook,
      extractModel,
      targetCollection: STATE.collection || undefined,
    });
    STATE.advanced.currentJobId = result.jobId;
    pushLog(
      `done · accepted=${result.totalDelta.accepted} · skipped=${result.totalDelta.skipped}`,
      "good",
    );
  } catch (e) {
    pushLog(`error: ${e instanceof Error ? e.message : String(e)}`, "bad");
  } finally {
    STATE.advanced.currentJobId = null;
    STATE.advanced.extractBusy = false;
    renderAdvanced(root);
  }
}

async function onAdvancedStop(root) {
  if (!STATE.advanced.currentJobId) return;
  try {
    await window.api.datasetV2.cancel(STATE.advanced.currentJobId);
    pushLog(t("dataset.advanced.event.stopped"), "warn");
  } catch (e) {
    pushLog(`stop failed: ${e instanceof Error ? e.message : String(e)}`, "bad");
  }
  STATE.advanced.extractBusy = false;
  renderAdvanced(root);
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Event handler — слушаем только export.progress + chapter.done для логов    */
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

  /* Advanced extraction events */
  if (stage === "chunker") {
    STATE.advanced.stats.chapter = (Number(payload.chapterIndex) ?? 0) + 1;
    pushLog(`глава #${payload.chapterIndex} → ${payload.chunks} чанков`, "info");
    renderAdvanced(root);
    return;
  }
  if (stage === "delta" && String(payload.type) === "delta.chunk.done") {
    if (payload.accepted) STATE.advanced.stats.accepted += 1;
    else STATE.advanced.stats.skipped += 1;
    renderAdvanced(root);
    return;
  }
  if (stage === "chapter" && String(payload.phase) === "done") {
    pushLog(
      `глава ${payload.chapterIndex} готова: +${payload.accepted} / ~${payload.skipped}`,
      "good",
    );
    renderAdvanced(root);
    return;
  }
  if (stage === "job" && String(payload.phase) === "done") {
    pushLog(t("dataset.advanced.event.done"), "good");
    renderAdvanced(root);
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

  /* Hero */
  const hero = el("header", { class: "ds-hero" }, [
    el("h1", { class: "ds-hero-title" }, t("dataset.hero.title")),
    el("p", { class: "ds-hero-sub" }, t("dataset.hero.sub")),
  ]);

  /* Steps */
  const steps = el("div", { class: "ds-steps" }, [
    buildStep1(root),
    buildStep2(),
    buildStep3(),
    buildStep4(root),
  ]);

  /* Action */
  const action = buildPrimaryAction(root);

  /* Progress slot */
  const progress = buildProgress();

  /* Advanced */
  const advanced = buildAdvancedSection(root);

  root.append(hero, steps, action, progress, advanced);
  renderProgress(root);

  if (unsub) unsub();
  unsub = window.api.datasetV2.onEvent((payload) => handleEvent(root, payload));
}

export function isCrystalBusy() {
  return STATE.busy || STATE.advanced.extractBusy;
}
