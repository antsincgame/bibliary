// @ts-check
import { el } from "./dom.js";
import { t } from "./i18n.js";
import { makeGlossaryButton } from "./dataset-glossary.js";
import {
  buildStepper,
  isOnboarded,
  markOnboarded,
  clearOnboarded,
} from "./dataset-stepper.js";
import { buildResumeBanner } from "./components/resume-banner.js";

const DEFAULTS = {
  profile: "BIG",
  contextLength: 32768,
  batchSize: 15,
  delayMs: 300,
  fewShotCount: 2,
  sampling: {
    temperature: 0.7,
    top_p: 0.8,
    top_k: 20,
    min_p: 0,
    presence_penalty: 1.0,
    max_tokens: 4096,
  },
};

const CONTEXT_PRESETS = [
  { value: 32768, label: "32K (default)" },
  { value: 131072, label: "128K" },
  { value: 262144, label: "256K (native max)" },
  { value: 1010000, label: "1M (YaRN — requires custom config)" },
];

const SECONDS_PER_CHUNK_ESTIMATE = 45;
const TOAST_TTL_MS = 6000;
const SOURCE_SCHEMA_HINT = "{ id, principle, explanation, domain, tags[] }";

/** Кешируемый LM Studio URL — берётся через IPC system:env-summary, чтобы не хардкодить. */
let cachedLmStudioUrl = "http://localhost:1234";
async function refreshLmStudioUrl() {
  try {
    const env = /** @type {any} */ (await window.api.system.envSummary());
    if (env && typeof env.lmStudioUrl === "string" && env.lmStudioUrl.length > 0) {
      cachedLmStudioUrl = env.lmStudioUrl;
    }
  } catch {
    /* fallback */
  }
}
function getLmStudioUrl() {
  return cachedLmStudioUrl;
}

const STATE = {
  step: 1,
  maxReached: 1,
  readiness: null,
  progress: null,
  settings: { ...DEFAULTS },
  batchResult: null,
  activeBatchId: null,
  /** @type {Set<string>} chunkIds, для которых уже посчитан "done" — защита от двойного счёта */
  doneChunkIds: new Set(),
  /** Флаг "запуск идёт" — блокирует двойной клик start/resume до получения первого progress */
  starting: false,
  unsubscribeProgress: null,
  lastChunkId: null,
  rootEl: null,
  bodyEl: null,
  headerEl: null,
  unfinished: [],
  resumeBannerDismissed: false,
};

function field(label, control, glossaryKey) {
  const lbl = el("label", { class: "field-label" }, label);
  if (glossaryKey) {
    const help = makeGlossaryButton(glossaryKey, "?");
    help.classList.add("inline-help");
    lbl.appendChild(help);
  }
  return el("div", { class: "field" }, [lbl, control]);
}

function numberInput(id, value, step = 1, min, max) {
  const inp = el("input", { id, type: "number", step: String(step), value: String(value) });
  if (min !== undefined) inp.setAttribute("min", String(min));
  if (max !== undefined) inp.setAttribute("max", String(max));
  return inp;
}

function selectInput(id, options, current) {
  const sel = el("select", { id });
  for (const opt of options) {
    const o = el("option", { value: String(opt.value) }, opt.label);
    if (String(opt.value) === String(current)) o.setAttribute("selected", "true");
    sel.appendChild(o);
  }
  return sel;
}

function showToast(message, kind = "error") {
  const root = STATE.rootEl;
  if (!root) return;
  let area = root.querySelector("#ds-toast-area");
  if (!area) {
    area = el("div", { id: "ds-toast-area", class: "ds-toast-area" });
    root.appendChild(area);
  }
  const toast = el("div", { class: `toast toast-${kind}` }, message);
  area.appendChild(toast);
  setTimeout(() => toast.remove(), TOAST_TTL_MS);
}

function formatSeconds(total) {
  if (!isFinite(total) || total < 0) return "—";
  const s = Math.round(total);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 60) return `${m}m ${r}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function readSettingsFromDom(root) {
  const get = (id, fallback) => {
    const node = root.querySelector(`#${id}`);
    return node ? node.value : fallback;
  };
  const num = (id, fallback) => parseFloat(get(id, fallback));
  const int = (id, fallback) => parseInt(get(id, fallback), 10);

  return {
    profile: get("ds-profile", DEFAULTS.profile),
    contextLength: int("ds-context", DEFAULTS.contextLength),
    batchSize: int("ds-batch-size", DEFAULTS.batchSize),
    delayMs: int("ds-delay", DEFAULTS.delayMs),
    fewShotCount: int("ds-fewshot", DEFAULTS.fewShotCount),
    sampling: {
      temperature: num("ds-temp", DEFAULTS.sampling.temperature),
      top_p: num("ds-topp", DEFAULTS.sampling.top_p),
      top_k: int("ds-topk", DEFAULTS.sampling.top_k),
      min_p: num("ds-minp", DEFAULTS.sampling.min_p),
      presence_penalty: num("ds-presence", DEFAULTS.sampling.presence_penalty),
      max_tokens: int("ds-maxtokens", DEFAULTS.sampling.max_tokens),
    },
  };
}

function buildAdvancedCard() {
  return el("div", { class: "card collapsible-advanced", id: "ds-advanced-card" }, [
    el("div", { class: "card-title" }, t("ds.adv.title")),
    el("div", { class: "card-grid" }, [
      field(
        t("ds.adv.profile"),
        selectInput(
          "ds-profile",
          [
            { value: "BIG", label: "BIG — мощная генератор-модель" },
            { value: "SMALL", label: "SMALL — лёгкая для быстрых тестов" },
          ],
          STATE.settings.profile
        )
      ),
      field(t("ds.adv.context"), selectInput("ds-context", CONTEXT_PRESETS, STATE.settings.contextLength)),
      field(t("ds.adv.batch_size"), numberInput("ds-batch-size", STATE.settings.batchSize, 1, 1, 100)),
      field(t("ds.adv.delay"), numberInput("ds-delay", STATE.settings.delayMs, 50, 0, 10000)),
      field(t("ds.adv.fewshot"), numberInput("ds-fewshot", STATE.settings.fewShotCount, 1, 0, 5), "fewshot"),
    ]),
    el("div", { class: "card-title", style: "margin-top:18px" }, t("ds.adv.sampling")),
    el("div", { class: "card-grid" }, [
      field(t("ds.adv.sampling.temperature"), numberInput("ds-temp", STATE.settings.sampling.temperature, 0.05, 0, 2)),
      field(t("ds.adv.sampling.top_p"), numberInput("ds-topp", STATE.settings.sampling.top_p, 0.05, 0, 1)),
      field(t("ds.adv.sampling.top_k"), numberInput("ds-topk", STATE.settings.sampling.top_k, 1, 1, 200)),
      field(t("ds.adv.sampling.min_p"), numberInput("ds-minp", STATE.settings.sampling.min_p, 0.01, 0, 1)),
      field(t("ds.adv.sampling.presence_penalty"), numberInput("ds-presence", STATE.settings.sampling.presence_penalty, 0.1, 0, 2)),
      field(t("ds.adv.sampling.max_tokens"), numberInput("ds-maxtokens", STATE.settings.sampling.max_tokens, 256, 256, 65536)),
    ]),
  ]);
}

function buildProgressCard() {
  return el("div", { class: "card", id: "ds-progress-card" }, [
    el("div", { class: "card-title" }, t("ds.progress.title")),
    el(
      "div",
      { id: "ds-progress-info", style: "font-size:12px;color:var(--text-dim);margin-bottom:10px;" },
      t("ds.progress.loading")
    ),
    el(
      "div",
      { class: "progress-bar-track" },
      el("div", { class: "progress-bar-fill", id: "ds-bar-fill", style: "width:0%" })
    ),
    el("div", { style: "margin-top:14px;font-size:12px;" }, [
      el("span", { id: "ds-current-chunk", style: "color:var(--gold);" }, ""),
    ]),
    el("div", { class: "phase-grid", id: "ds-phase-grid", style: "margin-top:14px;display:none;" }, [
      buildPhaseCol("T1"),
      buildPhaseCol("T2"),
      buildPhaseCol("T3"),
    ]),
    el("div", { class: "live-stat-row", id: "ds-live-stats", style: "margin-top:14px;" }),
  ]);
}

function buildPhaseCol(name) {
  const label = el("div", { class: "phase-col-label" }, [name, makeGlossaryButton(name, "?")]);
  return el("div", { class: "phase-col", id: `ds-phase-${name}` }, [
    label,
    el("div", { id: `ds-phase-${name}-text`, style: "min-height:80px;color:var(--text);" }, ""),
  ]);
}

function resetPhases() {
  for (const phase of ["T1", "T2", "T3"]) {
    const col = STATE.bodyEl?.querySelector(`#ds-phase-${phase}`);
    if (!col) continue;
    col.classList.remove("is-active", "is-error", "is-done");
    const text = STATE.bodyEl?.querySelector(`#ds-phase-${phase}-text`);
    if (text) text.textContent = "";
  }
}

function setPhaseActive(phase) {
  for (const p of ["T1", "T2", "T3"]) {
    const col = STATE.bodyEl?.querySelector(`#ds-phase-${p}`);
    if (!col) continue;
    col.classList.toggle("is-active", p === phase);
  }
}

function setPhaseText(phase, text) {
  const node = STATE.bodyEl?.querySelector(`#ds-phase-${phase}-text`);
  if (node) node.textContent = text;
}

function applyProgressEvent(event, startedAt, completedCount) {
  const grid = STATE.bodyEl?.querySelector("#ds-phase-grid");
  if (grid) grid.style.display = "grid";

  if (STATE.lastChunkId !== event.chunkId) {
    STATE.lastChunkId = event.chunkId;
    resetPhases();
  }

  const bar = STATE.bodyEl?.querySelector("#ds-bar-fill");
  if (bar) {
    const pct = Math.round(((event.index - 1) / event.total) * 100);
    bar.style.width = `${pct}%`;
  }

  const info = STATE.bodyEl?.querySelector("#ds-progress-info");
  if (info) {
    info.innerHTML = t("ds.progress.chunk_phase", {
      idx: event.index,
      total: event.total,
      phase: event.phase,
    });
  }

  const current = STATE.bodyEl?.querySelector("#ds-current-chunk");
  if (current) {
    current.textContent = `[${event.domain}] ${event.principleHead}`;
  }

  if (event.phase === "T1" || event.phase === "T2" || event.phase === "T3") {
    if (event.preview) {
      setPhaseText(event.phase, event.preview);
    } else {
      setPhaseActive(event.phase);
    }
  } else if (event.phase === "done") {
    setPhaseActive(null);
    if (bar) bar.style.width = `${Math.round((event.index / event.total) * 100)}%`;
    const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
    const avgPerChunk = (elapsedSec / event.index).toFixed(1);
    const remaining = (event.total - event.index) * parseFloat(avgPerChunk);
    const stats = STATE.bodyEl?.querySelector("#ds-live-stats");
    if (stats) {
      stats.innerHTML = `
        <div>${t("ds.progress.elapsed")} <strong>${elapsedSec}s</strong></div>
        <div>${t("ds.progress.avg")} <strong>${avgPerChunk}s</strong></div>
        <div>${t("ds.progress.eta")} <strong>${Math.round(remaining)}s</strong></div>
        <div>${t("ds.progress.done")} <strong>${completedCount}</strong></div>
      `;
    }
  } else if (event.phase === "error") {
    const col = STATE.bodyEl?.querySelector("#ds-phase-T1");
    if (col) col.classList.add("is-error");
    setPhaseText("T1", t("ds.progress.error", { msg: event.error || "unknown" }));
  }
}

function attachProgressSubscription(startedAt) {
  STATE.doneChunkIds = new Set();
  STATE.unsubscribeProgress = window.api.dataset.onChunkProgress((event) => {
    if (event.phase === "done" && !STATE.doneChunkIds.has(event.chunkId)) {
      STATE.doneChunkIds.add(event.chunkId);
    }
    STATE.activeBatchId = event.batchId;
    applyProgressEvent(event, startedAt, STATE.doneChunkIds.size);
  });
}

function detachProgressSubscription() {
  if (STATE.unsubscribeProgress) {
    STATE.unsubscribeProgress();
    STATE.unsubscribeProgress = null;
  }
  STATE.activeBatchId = null;
  STATE.starting = false;
  STATE.doneChunkIds = new Set();
}

async function startBatch() {
  if (STATE.activeBatchId || STATE.starting) return;
  STATE.starting = true;
  STATE.settings = readSettingsFromDom(STATE.bodyEl) || STATE.settings;

  STATE.step = 3;
  STATE.maxReached = Math.max(STATE.maxReached, 3);
  render();

  STATE.lastChunkId = null;
  resetPhases();

  attachProgressSubscription(Date.now());

  try {
    const result = await window.api.dataset.startBatch(STATE.settings);
    STATE.batchResult = result;
    STATE.progress = result.progress;
    STATE.step = 4;
    STATE.maxReached = Math.max(STATE.maxReached, 4);
    showToast(t("ds.toast.batch_done", { name: result.batchName, count: result.examplesCount }), "success");
  } catch (e) {
    showToast(t("ds.toast.batch_failed", { msg: e instanceof Error ? e.message : String(e) }), "error");
    STATE.step = 2;
  } finally {
    detachProgressSubscription();
    render();
  }
}

async function cancelBatch() {
  if (!STATE.activeBatchId) return;
  try {
    const ok = await window.api.batch.cancel(STATE.activeBatchId);
    if (ok) showToast(t("ds.toast.cancel_requested"), "success");
  } catch (e) {
    showToast(t("ds.toast.batch_failed", { msg: e instanceof Error ? e.message : String(e) }), "error");
  }
}

async function validateBatchByName(file) {
  try {
    const report = await window.api.dataset.validateBatch(file);
    if (report.errors.length === 0) {
      showToast(t("ds.toast.validate_ok", { file, valid: report.valid, total: report.total }), "success");
    } else {
      showToast(
        t("ds.toast.validate_err", { file, count: report.errors.length, first: report.errors[0] }),
        "error"
      );
    }
  } catch (e) {
    showToast(t("ds.toast.batch_failed", { msg: e instanceof Error ? e.message : String(e) }), "error");
  }
}

async function loadProgress() {
  try {
    STATE.progress = await window.api.dataset.getProgress();
  } catch {
    STATE.progress = null;
  }
}

async function loadReadiness() {
  try {
    STATE.readiness = await window.api.dataset.checkReadiness();
  } catch {
    STATE.readiness = null;
  }
}

async function loadUnfinished() {
  if (!window.api?.resilience?.scanUnfinished) {
    STATE.unfinished = [];
    return;
  }
  try {
    STATE.unfinished = await window.api.resilience.scanUnfinished();
  } catch {
    STATE.unfinished = [];
  }
}

async function resumeBatch(batchName) {
  if (STATE.activeBatchId || STATE.starting) return;
  STATE.starting = true;
  STATE.step = 3;
  STATE.maxReached = Math.max(STATE.maxReached, 3);
  render();

  STATE.lastChunkId = null;
  resetPhases();

  attachProgressSubscription(Date.now());

  try {
    const result = await window.api.batch.resume(batchName);
    STATE.batchResult = result;
    STATE.progress = result.progress;
    STATE.step = 4;
    STATE.maxReached = Math.max(STATE.maxReached, 4);
    showToast(t("ds.resume.toast.resumed", { name: result.batchName, count: result.processedCount }), "success");
  } catch (e) {
    showToast(t("ds.resume.toast.resume_failed", { msg: e instanceof Error ? e.message : String(e) }), "error");
    STATE.step = 2;
  } finally {
    detachProgressSubscription();
    await loadUnfinished();
    render();
  }
}

async function discardBatch(batchName) {
  try {
    await window.api.batch.discard(batchName);
    showToast(t("ds.resume.toast.discarded", { name: batchName }), "success");
  } catch (e) {
    showToast(t("ds.toast.batch_failed", { msg: e instanceof Error ? e.message : String(e) }), "error");
  }
  await loadUnfinished();
  render();
}

function readinessAllGreen(r) {
  if (!r) return false;
  return r.lmStudioOnline && r.bigModelLoaded && r.sourceExists && r.unprocessedCount > 0;
}

function readinessRow(state, label, detail, action) {
  const dotCls =
    state === "ok" ? "readiness-dot ok" : state === "warn" ? "readiness-dot warn" : "readiness-dot err";
  const children = [
    el("div", { class: dotCls }),
    el("div", { class: "readiness-text" }, [
      el("div", { class: "readiness-label" }, label),
      el("div", { class: "readiness-detail" }, detail),
    ]),
  ];
  if (action) children.push(action);
  return el("div", { class: "readiness-row" }, children);
}

function renderStep0() {
  const start = el(
    "button",
    {
      class: "btn btn-gold",
      style: "padding:12px 28px;font-size:13px;",
      onclick: () => {
        markOnboarded();
        STATE.step = 1;
        render();
      },
    },
    t("ds.welcome.start")
  );

  const card = el("div", { class: "card welcome-card" }, [
    el("div", { class: "welcome-card-title" }, t("ds.welcome.title")),
    el("div", { class: "welcome-card-sub" }, t("ds.welcome.sub")),
    el("div", { class: "flow-diagram" }, [
      el("div", { class: "flow-block flow-input" }, [
        el("div", { class: "flow-block-title" }, [
          "source-chunks.json",
          makeGlossaryButton("chunk", "?"),
        ]),
        el("div", { class: "flow-block-body" }, t("ds.welcome.flow.input.body")),
      ]),
      el("div", { class: "flow-arrow" }, "→"),
      el("div", { class: "flow-block flow-engine" }, [
        el("div", { class: "flow-block-title" }, t("ds.welcome.flow.engine.title")),
        el("div", { class: "flow-block-body" }, t("ds.welcome.flow.engine.body")),
        el("div", { class: "flow-tags" }, [
          el("span", { class: "flow-tag t1" }, ["T1", makeGlossaryButton("T1", "?")]),
          el("span", { class: "flow-tag t2" }, ["T2", makeGlossaryButton("T2", "?")]),
          el("span", { class: "flow-tag t3" }, ["T3", makeGlossaryButton("T3", "?")]),
        ]),
      ]),
      el("div", { class: "flow-arrow" }, "→"),
      el("div", { class: "flow-block flow-output" }, [
        el("div", { class: "flow-block-title" }, [
          "batch-NNN.jsonl",
          makeGlossaryButton("batch", "?"),
        ]),
        el("div", { class: "flow-block-body" }, t("ds.welcome.flow.output.body")),
      ]),
    ]),
    el("div", { class: "welcome-steps" }, [
      welcomeStep("1", t("ds.welcome.step.1")),
      welcomeStep("2", t("ds.welcome.step.2")),
      welcomeStep("3", t("ds.welcome.step.3")),
      welcomeStep("4", t("ds.welcome.step.4")),
    ]),
    el("div", { class: "welcome-actions" }, [start]),
  ]);

  STATE.bodyEl.appendChild(card);
}

function welcomeStep(num, label) {
  return el("div", { class: "welcome-step" }, [
    el("span", { class: "welcome-step-num" }, num),
    el("span", null, label),
  ]);
}

function renderStep1() {
  const r = STATE.readiness;
  if (!r) {
    STATE.bodyEl.appendChild(el("div", { class: "card" }, t("ds.checking")));
    return;
  }

  const rows = [];

  rows.push(
    readinessRow(
      r.lmStudioOnline ? "ok" : "err",
      t("ds.step1.lm.label"),
      r.lmStudioOnline
        ? t("ds.step1.lm.online", {
            ver: r.lmStudioVersion ? ` · v${r.lmStudioVersion}` : "",
            url: getLmStudioUrl(),
          })
        : t("ds.step1.lm.offline"),
      r.lmStudioOnline
        ? null
        : el(
            "button",
            {
              class: "btn",
              onclick: async () => {
                await loadReadiness();
                render();
              },
            },
            t("ds.step1.lm.recheck")
          )
    )
  );

  rows.push(
    readinessRow(
      !r.lmStudioOnline ? "warn" : r.bigModelLoaded ? "ok" : "warn",
      t("ds.step1.model.label", { key: r.bigModelKey }),
      !r.lmStudioOnline
        ? t("ds.step1.model.need_lm")
        : r.bigModelLoaded
        ? t("ds.step1.model.loaded")
        : t("ds.step1.model.not_loaded"),
      !r.lmStudioOnline || r.bigModelLoaded
        ? null
        : el(
            "button",
            {
              class: "btn btn-gold",
              onclick: async (e) => {
                e.target.disabled = true;
                e.target.textContent = t("ds.step1.model.loading");
                try {
                  await window.api.dataset.loadBigModel(STATE.settings.contextLength);
                  showToast(t("ds.toast.model_loaded"), "success");
                } catch (err) {
                  showToast(
                    t("ds.toast.load_failed", { msg: err instanceof Error ? err.message : String(err) }),
                    "error"
                  );
                } finally {
                  await loadReadiness();
                  render();
                }
              },
            },
            t("ds.step1.model.load")
          )
    )
  );

  const sourceState = !r.sourceExists ? "err" : r.unprocessedCount === 0 ? "warn" : "ok";
  const sourceDetail = !r.sourceExists
    ? t("ds.step1.source.missing", { path: r.sourcePath, schema: SOURCE_SCHEMA_HINT })
    : r.unprocessedCount === 0
    ? t("ds.step1.source.empty", { total: r.sourceChunkCount })
    : t("ds.step1.source.has", { left: r.unprocessedCount, total: r.sourceChunkCount });
  rows.push(
    readinessRow(
      sourceState,
      t("ds.step1.source.label"),
      sourceDetail,
      el(
        "button",
        {
          class: "btn btn-ghost",
          onclick: async () => {
            await window.api.dataset.openFinetuneFolder();
          },
        },
        t("ds.step1.source.open_folder")
      )
    )
  );

  rows.push(
    readinessRow(
      r.goldExists && r.goldExampleCount > 0 ? "ok" : "warn",
      t("ds.step1.gold.label"),
      r.goldExists && r.goldExampleCount > 0
        ? t("ds.step1.gold.has", { count: r.goldExampleCount })
        : t("ds.step1.gold.missing"),
      null
    )
  );

  const card = el("div", { class: "card wizard-step" }, [
    el("div", { class: "card-title" }, t("ds.step1.title")),
    el("div", { class: "wizard-step-sub" }, t("ds.step1.sub")),
    el("div", { class: "readiness-list" }, rows),
    el("div", { class: "btn-row", style: "margin-top:18px;" }, [
      el(
        "button",
        {
          class: "btn btn-ghost",
          onclick: async () => {
            await loadReadiness();
            await loadProgress();
            render();
          },
        },
        t("ds.step1.recheck_all")
      ),
      el(
        "button",
        {
          class: "btn btn-gold",
          disabled: readinessAllGreen(r) ? null : "true",
          onclick: () => {
            if (!readinessAllGreen(r)) return;
            STATE.step = 2;
            STATE.maxReached = Math.max(STATE.maxReached, 2);
            render();
          },
        },
        t("ds.step1.continue")
      ),
    ]),
  ]);

  STATE.bodyEl.appendChild(card);
}

function renderStep2() {
  const r = STATE.readiness;
  const remaining = r ? r.unprocessedCount : 0;
  const maxBatch = Math.max(1, remaining);
  const initial = Math.min(STATE.settings.batchSize, maxBatch);
  STATE.settings.batchSize = initial;

  const sliderValueLabel = el("span", { id: "ds-quick-value", class: "quick-slider-value" }, String(initial));
  const etaLabel = el("span", { id: "ds-quick-eta", class: "quick-slider-eta" }, "");

  const updateQuick = (n) => {
    sliderValueLabel.textContent = String(n);
    const examples = n * 3;
    const secs = n * SECONDS_PER_CHUNK_ESTIMATE;
    etaLabel.textContent = t("ds.step2.eta", { examples, eta: formatSeconds(secs) });
    STATE.settings.batchSize = n;
    const adv = STATE.bodyEl.querySelector("#ds-batch-size");
    if (adv) adv.value = String(n);
  };

  const slider = el("input", {
    id: "ds-quick-slider",
    type: "range",
    min: "1",
    max: String(maxBatch),
    step: "1",
    value: String(initial),
    class: "quick-slider",
    oninput: (e) => updateQuick(parseInt(e.target.value, 10)),
  });

  const allBtn = el(
    "button",
    {
      class: "btn btn-ghost",
      onclick: () => {
        slider.value = String(maxBatch);
        updateQuick(maxBatch);
      },
    },
    t("ds.step2.all_remaining", { n: maxBatch })
  );

  const quickCard = el("div", { class: "card wizard-step" }, [
    el("div", { class: "card-title" }, t("ds.step2.title")),
    el("div", { class: "wizard-step-sub" }, t("ds.step2.sub")),
    el("div", { class: "quick-slider-row" }, [
      el("div", { class: "field-label" }, t("ds.step2.chunks")),
      el("div", { class: "quick-slider-line" }, [slider, sliderValueLabel, allBtn]),
      etaLabel,
    ]),
    el("div", { class: "remaining-line" }, [
      el("span", null, t("ds.step2.remaining_prefix") + " "),
      el("strong", { style: "color:var(--gold);" }, String(remaining)),
      el("span", null, " " + t("ds.step2.remaining_of", { total: r ? r.sourceChunkCount : 0 })),
    ]),
    el("details", { class: "advanced-toggle" }, [
      el("summary", null, t("ds.step2.show_advanced")),
      el("div", { class: "advanced-body" }, [buildAdvancedCard()]),
    ]),
    el("div", { class: "btn-row", style: "margin-top:18px;" }, [
      el(
        "button",
        {
          class: "btn",
          onclick: () => {
            STATE.step = 1;
            render();
          },
        },
        t("ds.step2.back")
      ),
      el(
        "button",
        {
          class: "btn btn-primary",
          onclick: () => {
            startBatch();
          },
        },
        t("ds.step2.start")
      ),
    ]),
  ]);

  STATE.bodyEl.appendChild(quickCard);
  updateQuick(initial);
}

function renderStep3() {
  const card = el("div", { class: "card wizard-step" }, [
    el("div", { class: "card-title" }, t("ds.step3.title")),
    el("div", { class: "wizard-step-sub" }, t("ds.step3.sub")),
    el("div", { class: "btn-row", style: "margin-bottom:14px;" }, [
      el(
        "button",
        {
          class: "btn btn-primary",
          disabled: STATE.activeBatchId ? null : "true",
          onclick: () => cancelBatch(),
        },
        t("ds.step3.cancel")
      ),
    ]),
  ]);

  card.appendChild(buildProgressCard());
  STATE.bodyEl.appendChild(card);
}

function renderStep4() {
  const result = STATE.batchResult;

  const summaryCard = el("div", { class: "card wizard-step" }, [
    el("div", { class: "card-title" }, t("ds.step4.title")),
    result
      ? el("div", { class: "review-summary" }, [
          reviewLine(t("ds.step4.batch_file"), result.batchFile, "review-val"),
          reviewLine(t("ds.step4.examples_written"), String(result.examplesCount), "review-val ok"),
          reviewLine(t("ds.step4.chunks_processed"), String(result.processedCount), "review-val"),
          reviewLine(
            t("ds.step4.failed"),
            String(result.failedCount),
            result.failedCount > 0 ? "review-val warn" : "review-val ok"
          ),
        ])
      : el("div", { class: "wizard-step-sub" }, t("ds.step4.no_data")),
    el("div", { class: "btn-row", style: "margin-top:18px;" }, [
      el(
        "button",
        {
          class: "btn",
          disabled: result ? null : "true",
          onclick: () => result && validateBatchByName(result.batchFile),
        },
        t("ds.step4.validate")
      ),
      el(
        "button",
        {
          class: "btn btn-ghost",
          onclick: async () => {
            await window.api.dataset.openFinetuneFolder();
          },
        },
        t("ds.step4.open_folder")
      ),
      el(
        "button",
        {
          class: "btn btn-gold",
          onclick: async () => {
            await loadReadiness();
            await loadProgress();
            STATE.step = 2;
            render();
          },
        },
        t("ds.step4.run_another")
      ),
    ]),
  ]);

  STATE.bodyEl.appendChild(summaryCard);

  const progress = STATE.progress;
  const historyCard = el("div", { class: "card" }, [
    el("div", { class: "card-title" }, t("ds.history.title")),
    el("div", { id: "ds-history-list", style: "font-size:12px;color:var(--text-dim);" }),
  ]);

  const list = historyCard.querySelector("#ds-history-list");
  if (!progress || !progress.batches || progress.batches.length === 0) {
    list.textContent = t("ds.history.empty");
  } else {
    const recent = [...progress.batches].reverse().slice(0, 12);
    for (const b of recent) {
      const row = el("div", { class: "list-row" }, [
        el(
          "div",
          { class: "col-main" },
          t("ds.history.line", { name: b.name, chunks: b.chunk_ids.length, examples: b.example_count })
        ),
        el("div", { class: "col-meta" }, b.created_at),
        el(
          "button",
          {
            class: "btn",
            style: "padding:4px 10px;font-size:9px;",
            onclick: () => validateBatchByName(b.file),
          },
          t("ds.step4.validate")
        ),
      ]);
      list.appendChild(row);
    }
  }
  STATE.bodyEl.appendChild(historyCard);
}

function reviewLine(caption, value, valueClass) {
  return el("div", { class: "review-line" }, [
    el("span", { class: "review-cap" }, caption),
    el("span", { class: valueClass }, value),
  ]);
}

function render() {
  if (!STATE.bodyEl || !STATE.headerEl) return;

  STATE.bodyEl.innerHTML = "";
  STATE.headerEl.innerHTML = "";

  if (STATE.step !== 0) {
    const totals = {
      total: STATE.readiness?.sourceChunkCount ?? STATE.progress?.total_chunks ?? 0,
      done: STATE.progress?.processed_count ?? 0,
      left: STATE.readiness?.unprocessedCount ?? STATE.progress?.remaining_count ?? 0,
    };
    const stepper = buildStepper({
      currentStep: STATE.step,
      maxReachedStep: STATE.maxReached,
      totals,
      onJump: (id) => {
        STATE.step = id;
        render();
      },
      onReplay: () => {
        clearOnboarded();
        STATE.step = 0;
        render();
      },
    });
    STATE.headerEl.appendChild(stepper);
  }

  if (STATE.step !== 0 && STATE.step !== 3 && !STATE.resumeBannerDismissed) {
    const banner = buildResumeBanner({
      unfinished: STATE.unfinished,
      onResume: (id) => resumeBatch(id),
      onDiscard: (id) => discardBatch(id),
      onDismiss: () => {
        STATE.resumeBannerDismissed = true;
        render();
      },
    });
    if (banner) STATE.bodyEl.appendChild(banner);
  }

  if (STATE.step === 0) renderStep0();
  else if (STATE.step === 1) renderStep1();
  else if (STATE.step === 2) renderStep2();
  else if (STATE.step === 3) renderStep3();
  else if (STATE.step === 4) renderStep4();
}

/**
 * Возвращает true, если в данный момент идёт активная генерация батча.
 * Роутер использует это, чтобы НЕ перемонтировать вкладку при смене локали
 * во время работы — иначе сбросится `STATE.step` и DOM прогресса будет потерян.
 */
export function isDatasetBatchActive() {
  return Boolean(STATE.activeBatchId) || STATE.starting;
}

export async function mountDataset(root) {
  if (!root || root.dataset.mounted === "1") return;
  root.dataset.mounted = "1";

  // Подтянуть LM Studio URL из env (вместо hardcoded localhost:1234)
  void refreshLmStudioUrl();

  const wasActive = isDatasetBatchActive();
  const preservedStep = STATE.step;
  const preservedMax = STATE.maxReached;

  STATE.rootEl = root;
  STATE.headerEl = el("div", { class: "wizard-header" });
  STATE.bodyEl = el("div", { class: "wizard-body" });
  root.appendChild(STATE.headerEl);
  root.appendChild(STATE.bodyEl);

  if (wasActive) {
    // Активный батч пишет прогресс в DOM — оставляем шаг 3 и доступные шаги.
    STATE.step = preservedStep || 3;
    STATE.maxReached = Math.max(preservedMax, 3);
  } else {
    STATE.step = isOnboarded() ? 1 : 0;
    STATE.maxReached = 1;
    STATE.resumeBannerDismissed = false;
  }

  render();

  await Promise.all([loadReadiness(), loadProgress(), loadUnfinished()]);
  render();
}
