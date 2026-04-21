// @ts-check
import { el, clear } from "./dom.js";
import { t } from "./i18n.js";

/**
 * Phase 3.1 — UI экран «Кристаллизатор концептов».
 * Все вызовы — против реальной LM Studio + реального Qdrant.
 *
 * Источник книг — Library history (scanner:list-history) или прямой пик файла.
 * Модель extractor + judge — из загруженных в LM Studio.
 * Live alchemy log через push events `dataset-v2:event`.
 */

const STATE = {
  /** @type {Array<{collection: string, books: Array<{bookSourcePath: string, fileName: string, totalChunks: number, status: string}>}>} */
  history: [],
  /** @type {Array<{identifier: string, modelKey: string}>} */
  loadedModels: [],
  selectedBook: "",
  selectedExtractor: "",
  selectedJudge: "",
  scoreThreshold: 0.6,
  /** @type {string | null} */
  currentJobId: null,
  busy: false,
  /** Live stats — обновляются в реалтайме из событий */
  stats: {
    chapter: 0,
    chapterTitle: "",
    chunks: 0,
    extracted: 0,
    deduped: 0,
    accepted: 0,
    rejected: 0,
  },
  /** Last 200 events для alchemy log */
  /** @type {Array<{ts: number, stage: string, summary: string, level: "info"|"good"|"warn"|"bad"}>} */
  events: [],
  /** Accepted в этой сессии (для bottom-list) */
  /** @type {Array<{principle: string, domain: string, score: number}>} */
  acceptedThisSession: [],
};

let unsub = null;

const TOOL_HINTS = ["qwen3.6", "qwen3-coder", "mistral-small", "qwen3.5"];

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString();
}

function fmtPct(v) {
  return (v * 100).toFixed(0) + "%";
}

function pickModel(models, hints = TOOL_HINTS) {
  for (const h of hints) {
    const m = models.find((x) => x.modelKey.toLowerCase().includes(h));
    if (m) return m.modelKey;
  }
  return models[0]?.modelKey ?? "";
}

async function loadHistory() {
  try {
    STATE.history = await window.api.scanner.listHistory();
  } catch {
    STATE.history = [];
  }
}

async function loadModels() {
  try {
    STATE.loadedModels = await window.api.lmstudio.listLoaded();
    if (!STATE.selectedExtractor) STATE.selectedExtractor = pickModel(STATE.loadedModels);
    if (!STATE.selectedJudge) STATE.selectedJudge = STATE.selectedExtractor;
  } catch {
    STATE.loadedModels = [];
  }
}

function pushEvent(stage, summary, level = "info") {
  STATE.events.push({ ts: Date.now(), stage, summary: String(summary).slice(0, 240), level });
  if (STATE.events.length > 300) STATE.events = STATE.events.slice(-200);
}

function renderControls(root) {
  const wrap = root.querySelector(".cv-controls");
  if (!wrap) return;
  clear(wrap);

  /* Source selector */
  const srcLabel = el("label", { class: "cv-label" }, t("crystal.src.label"));
  const srcSelect = el("select", { class: "cv-select cv-source" });
  if (STATE.history.length === 0) {
    srcSelect.appendChild(el("option", { value: "" }, t("crystal.src.empty")));
    srcSelect.disabled = true;
  } else {
    srcSelect.appendChild(el("option", { value: "" }, "—"));
    for (const grp of STATE.history) {
      const og = el("optgroup", { label: grp.collection });
      for (const b of grp.books) {
        const opt = el("option", { value: b.bookSourcePath }, `${b.fileName} (${b.totalChunks} chunks · ${b.status})`);
        if (b.bookSourcePath === STATE.selectedBook) opt.selected = true;
        og.appendChild(opt);
      }
      srcSelect.appendChild(og);
    }
  }
  srcSelect.addEventListener("change", () => {
    STATE.selectedBook = srcSelect.value;
  });

  /* Extractor model */
  const extLabel = el("label", { class: "cv-label" }, t("crystal.model.extractor"));
  const extSelect = el("select", { class: "cv-select" });
  if (STATE.loadedModels.length === 0) {
    extSelect.appendChild(el("option", { value: "" }, t("crystal.model.empty")));
    extSelect.disabled = true;
  } else {
    for (const m of STATE.loadedModels) {
      const opt = el("option", { value: m.modelKey }, m.modelKey);
      if (m.modelKey === STATE.selectedExtractor) opt.selected = true;
      extSelect.appendChild(opt);
    }
  }
  extSelect.addEventListener("change", () => {
    STATE.selectedExtractor = extSelect.value;
  });

  /* Judge model */
  const judgeLabel = el("label", { class: "cv-label" }, t("crystal.model.judge"));
  const judgeSelect = el("select", { class: "cv-select" });
  if (STATE.loadedModels.length === 0) {
    judgeSelect.appendChild(el("option", { value: "" }, t("crystal.model.empty")));
    judgeSelect.disabled = true;
  } else {
    for (const m of STATE.loadedModels) {
      const opt = el("option", { value: m.modelKey }, m.modelKey);
      if (m.modelKey === STATE.selectedJudge) opt.selected = true;
      judgeSelect.appendChild(opt);
    }
  }
  judgeSelect.addEventListener("change", () => {
    STATE.selectedJudge = judgeSelect.value;
  });

  /* Score threshold */
  const thLabel = el("label", { class: "cv-label" }, t("crystal.threshold.label"));
  const thInput = el("input", {
    type: "range",
    min: "0.4",
    max: "0.9",
    step: "0.05",
    value: String(STATE.scoreThreshold),
    class: "cv-range",
  });
  const thValue = el("span", { class: "cv-range-value" }, STATE.scoreThreshold.toFixed(2));
  thInput.addEventListener("input", () => {
    STATE.scoreThreshold = Number(thInput.value);
    thValue.textContent = STATE.scoreThreshold.toFixed(2);
  });

  /* Buttons */
  const btnStart = el(
    "button",
    {
      class: "cv-btn cv-btn-accent",
      type: "button",
      id: "cv-start",
      onclick: () => startJob(root),
    },
    t("crystal.btn.start")
  );
  const btnStop = el(
    "button",
    {
      class: "cv-btn",
      type: "button",
      id: "cv-stop",
      disabled: "true",
      onclick: () => stopJob(root),
    },
    t("crystal.btn.stop")
  );
  const btnRefresh = el(
    "button",
    {
      class: "cv-btn",
      type: "button",
      title: t("crystal.btn.refresh.title"),
      onclick: async () => {
        await Promise.all([loadHistory(), loadModels()]);
        renderControls(root);
        renderAcceptedTotal(root);
      },
    },
    "↻"
  );

  wrap.append(
    el("div", { class: "cv-row" }, [srcLabel, srcSelect]),
    el("div", { class: "cv-row" }, [extLabel, extSelect]),
    el("div", { class: "cv-row" }, [judgeLabel, judgeSelect]),
    el("div", { class: "cv-row" }, [thLabel, thInput, thValue]),
    el("div", { class: "cv-row cv-actions" }, [btnStart, btnStop, btnRefresh])
  );

  if (STATE.busy) {
    btnStart.disabled = true;
    btnStop.disabled = false;
  }
}

function renderStats(root) {
  const wrap = root.querySelector(".cv-stats");
  if (!wrap) return;
  clear(wrap);
  const s = STATE.stats;
  const cells = [
    { label: t("crystal.stats.chapter"), value: s.chapter > 0 ? `#${s.chapter} «${s.chapterTitle.slice(0, 30)}»` : "—" },
    { label: t("crystal.stats.chunks"), value: s.chunks },
    { label: t("crystal.stats.extracted"), value: s.extracted, kind: "info" },
    { label: t("crystal.stats.deduped"), value: s.deduped, kind: "info" },
    { label: t("crystal.stats.accepted"), value: s.accepted, kind: "good" },
    { label: t("crystal.stats.rejected"), value: s.rejected, kind: "warn" },
  ];
  for (const c of cells) {
    wrap.appendChild(
      el("div", { class: "cv-stat-cell" }, [
        el("div", { class: "cv-stat-label" }, c.label),
        el("div", { class: `cv-stat-value cv-stat-${c.kind ?? "default"}` }, String(c.value)),
      ])
    );
  }
}

function renderLog(root) {
  const wrap = root.querySelector(".cv-log");
  if (!wrap) return;
  clear(wrap);
  if (STATE.events.length === 0) {
    wrap.appendChild(el("div", { class: "cv-log-empty" }, t("crystal.log.empty")));
    return;
  }
  for (const ev of STATE.events.slice().reverse()) {
    wrap.appendChild(
      el("div", { class: `cv-log-row cv-log-${ev.level}` }, [
        el("span", { class: "cv-log-time" }, fmtTime(ev.ts)),
        el("span", { class: "cv-log-stage" }, ev.stage),
        el("span", { class: "cv-log-summary" }, ev.summary),
      ])
    );
  }
}

function renderAccepted(root) {
  const wrap = root.querySelector(".cv-accepted");
  if (!wrap) return;
  clear(wrap);
  const head = el("div", { class: "cv-accepted-head" }, t("crystal.accepted.title"));
  wrap.appendChild(head);
  if (STATE.acceptedThisSession.length === 0) {
    wrap.appendChild(el("div", { class: "cv-accepted-empty" }, t("crystal.accepted.empty")));
    return;
  }
  for (const c of STATE.acceptedThisSession.slice().reverse()) {
    wrap.appendChild(
      el("div", { class: "cv-accepted-card" }, [
        el("div", { class: "cv-accepted-row1" }, [
          el("span", { class: "cv-accepted-domain" }, c.domain),
          el("span", { class: "cv-accepted-score" }, fmtPct(c.score)),
        ]),
        el("div", { class: "cv-accepted-principle" }, c.principle),
      ])
    );
  }
}

async function renderAcceptedTotal(root) {
  const node = root.querySelector("#cv-accepted-total");
  if (!node) return;
  try {
    const info = await window.api.datasetV2.listAccepted();
    node.textContent = String(info?.total ?? 0);
  } catch {
    node.textContent = "?";
  }
}

function setBusy(root, busy) {
  STATE.busy = busy;
  const start = root.querySelector("#cv-start");
  const stop = root.querySelector("#cv-stop");
  if (start) start.disabled = busy;
  if (stop) stop.disabled = !busy;
}

function resetStats() {
  STATE.stats = { chapter: 0, chapterTitle: "", chunks: 0, extracted: 0, deduped: 0, accepted: 0, rejected: 0 };
  STATE.events = [];
  STATE.acceptedThisSession = [];
}

function handleEvent(root, payload) {
  if (payload.jobId && !STATE.currentJobId) {
    STATE.currentJobId = payload.jobId;
  }
  const stage = String(payload.stage ?? "");
  const phase = String(payload.phase ?? "");

  if (stage === "parse" && phase === "done") {
    pushEvent("parse", `Книга «${payload.bookTitle}» — ${payload.totalChapters} глав`, "info");
  } else if (stage === "chunker") {
    STATE.stats.chapter = (Number(payload.chapterIndex) ?? 0) + 1;
    STATE.stats.chapterTitle = String(payload.chapterTitle ?? "");
    STATE.stats.chunks += Number(payload.chunks ?? 0);
    pushEvent("chunker", `Глава #${payload.chapterIndex} → ${payload.chunks} чанков`, "info");
    renderStats(root);
  } else if (stage === "extract") {
    const t2 = String(payload.type ?? "");
    if (t2 === "extract.chunk.done") {
      const raw = Number(payload.raw ?? 0);
      const valid = Number(payload.valid ?? 0);
      STATE.stats.extracted += valid;
      pushEvent(
        "extract",
        `chunk ${payload.chunkPart}/${payload.chunkTotal}: raw=${raw} valid=${valid} (${payload.durationMs}ms)`,
        valid > 0 ? "good" : "warn"
      );
      renderStats(root);
    } else if (t2 === "extract.chunk.error") {
      pushEvent("extract", `chunk ${payload.chunkPart}: ${payload.error}`, "bad");
    }
  } else if (stage === "intra-dedup") {
    const t2 = String(payload.type ?? "");
    if (t2 === "intra-dedup.merge") {
      pushEvent("dedup", `merge sim=${Number(payload.sim).toFixed(3)} «${payload.principleA}» ↔ «${payload.principleB}»`, "warn");
    } else if (t2 === "intra-dedup.done") {
      STATE.stats.deduped = Number(payload.after ?? STATE.stats.deduped);
      pushEvent("dedup", `${payload.before} → ${payload.after} (мерджей: ${payload.mergedPairs})`, "info");
      renderStats(root);
    }
  } else if (stage === "judge") {
    const t2 = String(payload.type ?? "");
    if (t2 === "judge.score") {
      pushEvent(
        "judge",
        `score=${Number(payload.score).toFixed(2)} N=${Number(payload.novelty).toFixed(2)} A=${Number(payload.actionability).toFixed(2)} D=${Number(payload.domain_fit).toFixed(2)}`,
        "info"
      );
    } else if (t2 === "judge.accept") {
      STATE.stats.accepted++;
      const score = Number(payload.score ?? 0);
      pushEvent("judge", `ACCEPT ${score.toFixed(2)} «${payload.principle}»`, "good");
      STATE.acceptedThisSession.push({
        principle: String(payload.principle ?? ""),
        domain: "?",
        score,
      });
      renderStats(root);
      renderAccepted(root);
      renderAcceptedTotal(root);
    } else if (t2 === "judge.reject.lowscore") {
      STATE.stats.rejected++;
      pushEvent("judge", `REJECT lowscore=${Number(payload.score).toFixed(2)} «${payload.principle}»`, "warn");
      renderStats(root);
    } else if (t2 === "judge.crossdupe") {
      STATE.stats.rejected++;
      pushEvent("judge", `REJECT crossdupe sim=${Number(payload.sim).toFixed(3)} «${payload.principle}»`, "warn");
      renderStats(root);
    } else if (t2 === "judge.reject.error") {
      STATE.stats.rejected++;
      pushEvent("judge", `REJECT error «${payload.principle}»: ${payload.reason}`, "bad");
      renderStats(root);
    }
  } else if (stage === "chapter" && phase === "done") {
    pushEvent(
      "chapter",
      `done #${payload.chapterIndex}: extracted=${payload.extracted} deduped=${payload.deduped} accepted=${payload.accepted} rejected=${payload.rejected}`,
      "good"
    );
  } else if (stage === "job" && phase === "done") {
    pushEvent("job", "DONE — вся книга обработана", "good");
    setBusy(root, false);
  }
  renderLog(root);
}

async function startJob(root) {
  if (STATE.busy) return;
  if (!STATE.selectedBook) {
    alert(t("crystal.alert.noBook"));
    return;
  }
  if (!STATE.selectedExtractor || !STATE.selectedJudge) {
    alert(t("crystal.alert.noModel"));
    return;
  }
  resetStats();
  setBusy(root, true);
  renderStats(root);
  renderLog(root);
  renderAccepted(root);
  pushEvent("job", "Старт кристаллизации…", "info");
  try {
    const result = await window.api.datasetV2.startExtraction({
      bookSourcePath: STATE.selectedBook,
      extractModel: STATE.selectedExtractor,
      judgeModel: STATE.selectedJudge,
      scoreThreshold: STATE.scoreThreshold,
    });
    STATE.currentJobId = result.jobId;
    pushEvent(
      "job",
      `Финал: extracted=${result.totalConcepts.extractedRaw}, accepted=${result.totalConcepts.accepted}, rejected=${result.totalConcepts.rejected}`,
      "good"
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    pushEvent("job", `ERROR: ${msg}`, "bad");
  } finally {
    STATE.currentJobId = null;
    setBusy(root, false);
    renderLog(root);
  }
}

async function stopJob(root) {
  if (!STATE.currentJobId) return;
  try {
    await window.api.datasetV2.cancel(STATE.currentJobId);
  } catch {
    /* ignore */
  }
  pushEvent("job", "Остановлено пользователем", "warn");
  setBusy(root, false);
  renderLog(root);
}

export function mountCrystal(root) {
  if (!root) return;
  if (root.dataset.mounted === "1") return;
  root.dataset.mounted = "1";
  clear(root);

  const controls = el("div", { class: "cv-controls" });
  const stats = el("div", { class: "cv-stats" });
  const totalsBar = el("div", { class: "cv-totals-bar" }, [
    el("span", { class: "cv-totals-label" }, t("crystal.totals.acceptedAll") + ":"),
    el("span", { class: "cv-totals-value", id: "cv-accepted-total" }, "—"),
    el("span", { class: "cv-totals-hint" }, t("crystal.totals.hint")),
  ]);

  const log = el("div", { class: "cv-log" });
  const accepted = el("div", { class: "cv-accepted" });

  const layout = el("div", { class: "cv-layout" }, [
    el("div", { class: "cv-left" }, [controls, stats, totalsBar]),
    el("div", { class: "cv-center" }, [log]),
    el("div", { class: "cv-right" }, [accepted]),
  ]);

  root.appendChild(layout);

  Promise.all([loadHistory(), loadModels()]).then(() => {
    renderControls(root);
    renderStats(root);
    renderLog(root);
    renderAccepted(root);
    renderAcceptedTotal(root);
  });

  if (unsub) unsub();
  unsub = window.api.datasetV2.onEvent((payload) => handleEvent(root, payload));
}

export function isCrystalBusy() {
  return STATE.busy;
}
