// @ts-check

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

let activeBatchId = null;
let unsubscribeProgress = null;

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "style") node.setAttribute("style", v);
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null) node.setAttribute(k, String(v));
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

function field(label, control) {
  return el("div", { class: "field" }, [el("label", { class: "field-label" }, label), control]);
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

function fmtPct(processed, total) {
  if (!total) return "0%";
  return `${Math.round((processed / total) * 100)}%`;
}

function readSettings(root) {
  return {
    profile: root.querySelector("#ds-profile").value,
    contextLength: parseInt(root.querySelector("#ds-context").value, 10),
    batchSize: parseInt(root.querySelector("#ds-batch-size").value, 10),
    delayMs: parseInt(root.querySelector("#ds-delay").value, 10),
    fewShotCount: parseInt(root.querySelector("#ds-fewshot").value, 10),
    sampling: {
      temperature: parseFloat(root.querySelector("#ds-temp").value),
      top_p: parseFloat(root.querySelector("#ds-topp").value),
      top_k: parseInt(root.querySelector("#ds-topk").value, 10),
      min_p: parseFloat(root.querySelector("#ds-minp").value),
      presence_penalty: parseFloat(root.querySelector("#ds-presence").value),
      max_tokens: parseInt(root.querySelector("#ds-maxtokens").value, 10),
    },
  };
}

function buildSettingsCard() {
  return el("div", { class: "card" }, [
    el("div", { class: "card-title" }, "Generator settings"),
    el("div", { class: "card-grid" }, [
      field(
        "Profile (generation always uses BIG)",
        selectInput("ds-profile", [{ value: "BIG", label: "BIG — Qwen3.6-35B-A3B" }], DEFAULTS.profile)
      ),
      field("Context window", selectInput("ds-context", CONTEXT_PRESETS, DEFAULTS.contextLength)),
      field("Batch size (chunks)", numberInput("ds-batch-size", DEFAULTS.batchSize, 1, 1, 100)),
      field("Delay between calls, ms", numberInput("ds-delay", DEFAULTS.delayMs, 50, 0, 10000)),
      field("Few-shot per phase", numberInput("ds-fewshot", DEFAULTS.fewShotCount, 1, 0, 5)),
    ]),
    el("div", { class: "card-title", style: "margin-top:18px" }, "Sampling (Qwen Team preset)"),
    el("div", { class: "card-grid" }, [
      field("temperature", numberInput("ds-temp", DEFAULTS.sampling.temperature, 0.05, 0, 2)),
      field("top_p", numberInput("ds-topp", DEFAULTS.sampling.top_p, 0.05, 0, 1)),
      field("top_k", numberInput("ds-topk", DEFAULTS.sampling.top_k, 1, 1, 200)),
      field("min_p", numberInput("ds-minp", DEFAULTS.sampling.min_p, 0.01, 0, 1)),
      field("presence_penalty", numberInput("ds-presence", DEFAULTS.sampling.presence_penalty, 0.1, 0, 2)),
      field("max_tokens", numberInput("ds-maxtokens", DEFAULTS.sampling.max_tokens, 256, 256, 65536)),
    ]),
  ]);
}

function buildProgressCard() {
  return el("div", { class: "card", id: "ds-progress-card" }, [
    el("div", { class: "card-title" }, "Live progress"),
    el("div", { id: "ds-progress-info", style: "font-size:12px;color:var(--text-dim);margin-bottom:10px;" },
      "Idle. Press Start batch."
    ),
    el("div", { class: "progress-bar-track" }, el("div", { class: "progress-bar-fill", id: "ds-bar-fill", style: "width:0%" })),
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
  return el("div", { class: "phase-col", id: `ds-phase-${name}` }, [
    el("div", { class: "phase-col-label" }, name),
    el("div", { id: `ds-phase-${name}-text`, style: "min-height:80px;color:var(--text);" }, ""),
  ]);
}

function buildHistoryCard() {
  return el("div", { class: "card", id: "ds-history-card" }, [
    el("div", { class: "card-title" }, "Batch history"),
    el("div", { id: "ds-history-list", style: "font-size:12px;color:var(--text-dim);" }, "Loading…"),
  ]);
}

function buildHeader() {
  return el("div", { class: "card" }, [
    el("div", { class: "card-title" }, "Status"),
    el("div", { id: "ds-status-line", style: "font-size:12px;color:var(--text);" }, "Loading progress…"),
    el("div", { class: "btn-row", style: "margin-top:14px;" }, [
      el("button", { id: "ds-btn-start", class: "btn btn-primary" }, "Start batch"),
      el("button", { id: "ds-btn-cancel", class: "btn btn-ghost", disabled: "true" }, "Cancel"),
      el("button", { id: "ds-btn-validate", class: "btn" }, "Validate latest"),
      el("button", { id: "ds-btn-refresh", class: "btn btn-ghost" }, "Refresh"),
    ]),
    el("div", { id: "ds-toast-area", style: "margin-top:14px;" }),
  ]);
}

function showToast(root, message, kind = "error") {
  const area = root.querySelector("#ds-toast-area");
  const toast = el("div", { class: `toast toast-${kind}` }, message);
  area.appendChild(toast);
  setTimeout(() => toast.remove(), 6000);
}

async function refreshStatus(root) {
  const progress = await window.api.dataset.getProgress();
  const line = root.querySelector("#ds-status-line");
  if (!progress) {
    line.textContent = "progress.json not found.";
    return;
  }
  const pct = fmtPct(progress.processed_count, progress.total_chunks);
  line.innerHTML = `Processed <strong style="color:var(--cyan);">${progress.processed_count}</strong> / ${progress.total_chunks} (${pct}) — next batch index <strong style="color:var(--gold);">${progress.next_batch_index}</strong>`;
}

async function refreshHistory(root) {
  const list = root.querySelector("#ds-history-list");
  const progress = await window.api.dataset.getProgress();
  if (!progress || progress.batches.length === 0) {
    list.textContent = "No batches yet.";
    return;
  }
  list.innerHTML = "";
  const recent = [...progress.batches].reverse().slice(0, 12);
  for (const b of recent) {
    const row = el("div", { class: "list-row" }, [
      el("div", { class: "col-main" }, `${b.name} · ${b.chunk_ids.length} chunks · ${b.example_count} examples`),
      el("div", { class: "col-meta" }, b.created_at),
      el(
        "button",
        {
          class: "btn",
          style: "padding:4px 10px;font-size:9px;",
          onclick: async () => {
            const report = await window.api.dataset.validateBatch(b.file);
            if (report.errors.length === 0) {
              showToast(root, `${b.file}: ${report.valid}/${report.total} valid`, "success");
            } else {
              showToast(root, `${b.file}: ${report.errors.length} errors — ${report.errors[0]}`, "error");
            }
          },
        },
        "Validate"
      ),
    ]);
    list.appendChild(row);
  }
}

function resetPhases(root) {
  for (const t of ["T1", "T2", "T3"]) {
    const col = root.querySelector(`#ds-phase-${t}`);
    if (!col) continue;
    col.classList.remove("is-active", "is-error", "is-done");
    root.querySelector(`#ds-phase-${t}-text`).textContent = "";
  }
}

function setPhaseActive(root, phase) {
  for (const t of ["T1", "T2", "T3"]) {
    const col = root.querySelector(`#ds-phase-${t}`);
    if (!col) continue;
    col.classList.toggle("is-active", t === phase);
  }
}

function setPhaseText(root, phase, text) {
  const node = root.querySelector(`#ds-phase-${phase}-text`);
  if (node) node.textContent = text;
}

const STATE = { lastChunkId: null };

function applyProgressEvent(root, event, startedAt, completedCount) {
  const grid = root.querySelector("#ds-phase-grid");
  grid.style.display = "grid";

  if (STATE.lastChunkId !== event.chunkId) {
    STATE.lastChunkId = event.chunkId;
    resetPhases(root);
  }

  const bar = root.querySelector("#ds-bar-fill");
  const pct = Math.round(((event.index - 1) / event.total) * 100);
  bar.style.width = `${pct}%`;

  const info = root.querySelector("#ds-progress-info");
  info.innerHTML = `chunk <strong style="color:var(--cyan);">${event.index}</strong> / ${event.total} — phase <strong style="color:var(--gold);">${event.phase}</strong>`;

  const current = root.querySelector("#ds-current-chunk");
  current.textContent = `[${event.domain}] ${event.principleHead}`;

  if (event.phase === "T1" || event.phase === "T2" || event.phase === "T3") {
    if (event.preview) {
      setPhaseText(root, event.phase, event.preview);
    } else {
      setPhaseActive(root, event.phase);
    }
  } else if (event.phase === "done") {
    setPhaseActive(root, null);
    bar.style.width = `${Math.round((event.index / event.total) * 100)}%`;
    const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
    const avgPerChunk = (elapsedSec / event.index).toFixed(1);
    const remaining = (event.total - event.index) * parseFloat(avgPerChunk);
    root.querySelector("#ds-live-stats").innerHTML = `
      <div>Elapsed <strong>${elapsedSec}s</strong></div>
      <div>Avg/chunk <strong>${avgPerChunk}s</strong></div>
      <div>ETA <strong>${Math.round(remaining)}s</strong></div>
      <div>Done <strong>${completedCount}</strong></div>
    `;
  } else if (event.phase === "error") {
    const col = root.querySelector("#ds-phase-T1");
    if (col) col.classList.add("is-error");
    setPhaseText(root, "T1", `ERROR: ${event.error || "unknown"}`);
  }
}

async function startBatch(root) {
  if (activeBatchId) return;
  const settings = readSettings(root);
  const btnStart = root.querySelector("#ds-btn-start");
  const btnCancel = root.querySelector("#ds-btn-cancel");
  btnStart.disabled = true;
  btnCancel.disabled = false;
  STATE.lastChunkId = null;
  resetPhases(root);
  root.querySelector("#ds-progress-info").textContent = "Loading model & preparing…";

  const startedAt = Date.now();
  let completedCount = 0;

  unsubscribeProgress = window.api.dataset.onChunkProgress((event) => {
    if (event.phase === "done") completedCount++;
    activeBatchId = event.batchId;
    applyProgressEvent(root, event, startedAt, completedCount);
  });

  try {
    const result = await window.api.dataset.startBatch(settings);
    showToast(root, `Batch ${result.batchName} done — ${result.examplesCount} examples (${result.failedCount} failed)`, "success");
    await refreshStatus(root);
    await refreshHistory(root);
  } catch (e) {
    showToast(root, `Batch failed: ${e instanceof Error ? e.message : String(e)}`, "error");
  } finally {
    if (unsubscribeProgress) {
      unsubscribeProgress();
      unsubscribeProgress = null;
    }
    activeBatchId = null;
    btnStart.disabled = false;
    btnCancel.disabled = true;
  }
}

async function cancelBatch(root) {
  if (!activeBatchId) return;
  const ok = await window.api.dataset.cancelBatch(activeBatchId);
  if (ok) showToast(root, "Cancellation requested. Saving partial batch…", "success");
}

async function validateLatest(root) {
  const files = await window.api.dataset.listBatches();
  if (files.length === 0) {
    showToast(root, "No batches to validate", "error");
    return;
  }
  const latest = files[files.length - 1];
  const report = await window.api.dataset.validateBatch(latest);
  if (report.errors.length === 0) {
    showToast(root, `${latest}: ${report.valid}/${report.total} valid`, "success");
  } else {
    showToast(root, `${latest}: ${report.errors.length} errors`, "error");
  }
}

export function mountDataset(root) {
  if (!root || root.dataset.mounted === "1") return;
  root.dataset.mounted = "1";

  root.appendChild(buildHeader());
  root.appendChild(buildSettingsCard());
  root.appendChild(buildProgressCard());
  root.appendChild(buildHistoryCard());

  root.querySelector("#ds-btn-start").addEventListener("click", () => startBatch(root));
  root.querySelector("#ds-btn-cancel").addEventListener("click", () => cancelBatch(root));
  root.querySelector("#ds-btn-validate").addEventListener("click", () => validateLatest(root));
  root.querySelector("#ds-btn-refresh").addEventListener("click", async () => {
    await refreshStatus(root);
    await refreshHistory(root);
  });

  refreshStatus(root);
  refreshHistory(root);
}
