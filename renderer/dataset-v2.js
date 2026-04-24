// @ts-check
import { el, clear } from "./dom.js";
import { t } from "./i18n.js";
import { buildNeonHero, neonDivider } from "./components/neon-helpers.js";
import { buildModelSelect } from "./components/model-select.js";
import { showAlert } from "./components/ui-dialog.js";

/**
 * Phase 3.1 — UI экран «Извлечение знаний» (исторически: Crystallizer).
 * Все вызовы — против реальной LM Studio + реального Qdrant.
 *
 * Источник книг — Library history (scanner:list-history) или прямой пик файла.
 * Модель extractor + judge — из загруженных в LM Studio.
 * Live alchemy log через push events `dataset-v2:event`.
 */

const STATE = {
  /** @type {Array<{collection: string, books: Array<{bookSourcePath: string, fileName: string, totalChunks: number, status: string}>}>} */
  history: [],
  selectedBook: "",
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
  /** @type {Array<{conceptId: string, principle: string, domain: string, score: number, rejected?: boolean, rejectError?: string}>} */
  acceptedThisSession: [],
};

let unsub = null;

/** Подсказки для pickBestModel в model-select для extractor/judge (Crystal-специфичные). */
const CRYSTAL_MODEL_HINTS = ["qwen3.6", "qwen3-coder", "mistral-small", "qwen3.5"];

/** Активные экземпляры model-select для extractor/judge. Создаются в renderControls. */
let extractorSelect = /** @type {ReturnType<typeof buildModelSelect> | null} */ (null);
let judgeSelect = /** @type {ReturnType<typeof buildModelSelect> | null} */ (null);

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString();
}

function fmtPct(v) {
  return (v * 100).toFixed(0) + "%";
}

async function loadHistory() {
  try {
    STATE.history = await window.api.scanner.listHistory();
  } catch {
    STATE.history = [];
  }
}

/**
 * Читает глобальный судейский порог из preferences.judgeScoreThreshold.
 * Если pref не задан или не валиден — STATE.scoreThreshold остаётся как есть (0.6 fallback).
 */
async function loadThresholdFromPrefs() {
  try {
    const prefs = /** @type {any} */ (await window.api.preferences.getAll());
    const v = Number(prefs?.judgeScoreThreshold);
    if (Number.isFinite(v) && v >= 0 && v <= 1) {
      STATE.scoreThreshold = v;
    }
  } catch {
    /* ignore — оставляем дефолт STATE.scoreThreshold */
  }
}

/**
 * Сохраняет порог в preferences. Debounced через таймер модульного уровня —
 * пользователь дёргает slider десятки раз, пишем только после паузы.
 */
let _thresholdSaveTimer = /** @type {ReturnType<typeof setTimeout> | null} */ (null);
function saveThresholdToPrefs(value) {
  if (_thresholdSaveTimer) clearTimeout(_thresholdSaveTimer);
  _thresholdSaveTimer = setTimeout(() => {
    _thresholdSaveTimer = null;
    void window.api.preferences.set({ judgeScoreThreshold: value }).catch(() => { /* ignore */ });
  }, 500);
}

function pushEvent(stage, summary, level = "info") {
  STATE.events.push({ ts: Date.now(), stage, summary: String(summary).slice(0, 240), level });
  if (STATE.events.length > 300) STATE.events = STATE.events.slice(-200);
}

function buildSourceRow() {
  const label = el("label", { class: "cv-label" }, t("crystal.src.label"));
  const select = el("select", { class: "cv-select cv-source" });
  if (STATE.history.length === 0) {
    select.appendChild(el("option", { value: "" }, t("crystal.src.empty")));
    select.disabled = true;
  } else {
    select.appendChild(el("option", { value: "" }, "—"));
    for (const grp of STATE.history) {
      const og = el("optgroup", { label: grp.collection });
      for (const b of grp.books) {
        const opt = el("option", { value: b.bookSourcePath }, `${b.fileName} (${b.totalChunks} chunks · ${b.status})`);
        if (b.bookSourcePath === STATE.selectedBook) opt.selected = true;
        og.appendChild(opt);
      }
      select.appendChild(og);
    }
  }
  select.addEventListener("change", () => {
    STATE.selectedBook = select.value;
  });
  return el("div", { class: "cv-row" }, [label, select]);
}

/**
 * Создать строку cv-row с готовым селектом ролевой модели через общий компонент.
 * @param {"extractor"|"judge"} role
 * @returns {{ row: HTMLElement, instance: ReturnType<typeof buildModelSelect> }}
 */
function buildCrystalModelRow(role) {
  const labelKey = role === "extractor" ? "crystal.model.extractor" : "crystal.model.judge";
  const instance = buildModelSelect({
    role,
    label: t(labelKey),
    hints: CRYSTAL_MODEL_HINTS,
    wrapClass: "cv-row",
    labelClass: "cv-label",
    selectClass: "cv-select",
  });
  return { row: instance.wrap, instance };
}

function buildThresholdRow() {
  const label = el("label", { class: "cv-label", title: t("crystal.threshold.tooltip") }, t("crystal.threshold.label"));
  const input = el("input", {
    type: "range",
    min: "0",
    max: "1",
    step: "0.05",
    value: String(STATE.scoreThreshold),
    class: "cv-range",
  });
  const value = el("span", { class: "cv-range-value" }, STATE.scoreThreshold.toFixed(2));
  input.addEventListener("input", () => {
    STATE.scoreThreshold = Number(input.value);
    value.textContent = STATE.scoreThreshold.toFixed(2);
    saveThresholdToPrefs(STATE.scoreThreshold);
  });
  return el("div", { class: "cv-row" }, [label, input, value]);
}

function buildActionsRow(root) {
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
        await Promise.all([
          loadHistory(),
          loadThresholdFromPrefs(),
          extractorSelect?.refresh() ?? Promise.resolve(),
          judgeSelect?.refresh() ?? Promise.resolve(),
        ]);
        renderControls(root);
        renderAcceptedTotal(root);
      },
    },
    "↻"
  );
  return el("div", { class: "cv-row cv-actions" }, [btnStart, btnStop, btnRefresh]);
}

function renderControls(root) {
  const wrap = root.querySelector(".cv-controls");
  if (!wrap) return;
  clear(wrap);

  const extractorRow = buildCrystalModelRow("extractor");
  const judgeRow = buildCrystalModelRow("judge");
  extractorSelect = extractorRow.instance;
  judgeSelect = judgeRow.instance;

  wrap.append(
    buildSourceRow(),
    extractorRow.row,
    judgeRow.row,
    buildThresholdRow(),
    buildActionsRow(root)
  );

  if (STATE.busy) {
    const start = wrap.querySelector("#cv-start");
    const stop = wrap.querySelector("#cv-stop");
    if (start) start.disabled = true;
    if (stop) stop.disabled = false;
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
    wrap.appendChild(buildAcceptedCard(c, root));
  }
}

function buildAcceptedCard(concept, root) {
  const card = el("div", {
    class: `cv-accepted-card${concept.rejected ? " cv-accepted-card-rejected" : ""}`,
    "data-concept-id": concept.conceptId,
  }, [
    el("div", { class: "cv-accepted-row1" }, [
      el("span", { class: "cv-accepted-domain" }, concept.domain || "?"),
      el("span", { class: "cv-accepted-score" }, fmtPct(concept.score)),
      buildRejectButton(concept, root),
    ]),
    el("div", { class: "cv-accepted-principle" }, concept.principle),
    concept.rejectError
      ? el("div", { class: "cv-accepted-error" }, concept.rejectError)
      : null,
  ]);
  return card;
}

function buildRejectButton(concept, root) {
  if (concept.rejected) {
    return el("span", { class: "cv-accepted-rejected-badge", title: t("crystal.accepted.rejectedTooltip") },
      t("crystal.accepted.rejected"));
  }
  if (!concept.conceptId) return null;
  const btn = el("button", {
    class: "cv-accepted-reject-btn",
    type: "button",
    title: t("crystal.accepted.reject.tooltip"),
    "aria-label": t("crystal.accepted.reject.aria"),
  }, "x");
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    try {
      const ok = await window.api.datasetV2.rejectAccepted(concept.conceptId);
      if (ok) {
        concept.rejected = true;
        STATE.stats.accepted = Math.max(0, STATE.stats.accepted - 1);
        STATE.stats.rejected += 1;
        pushEvent("judge", `MANUAL REJECT «${concept.principle}»`, "warn");
        renderStats(root);
        renderAccepted(root);
        renderAcceptedTotal(root);
      } else {
        concept.rejectError = t("crystal.accepted.rejectFailed");
        renderAccepted(root);
      }
    } catch (e) {
      concept.rejectError = t("crystal.accepted.rejectFailed") + ": " + (e instanceof Error ? e.message : String(e));
      renderAccepted(root);
    }
  });
  return btn;
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

/* ───── handleEvent: stage handlers (dispatcher pattern) ───── */

function handleParseEvent(_root, payload) {
  if (String(payload.phase ?? "") !== "done") return;
  pushEvent("parse", `Книга «${payload.bookTitle}» — ${payload.totalChapters} глав`, "info");
}

function handleChunkerEvent(root, payload) {
  STATE.stats.chapter = (Number(payload.chapterIndex) ?? 0) + 1;
  STATE.stats.chapterTitle = String(payload.chapterTitle ?? "");
  STATE.stats.chunks += Number(payload.chunks ?? 0);
  pushEvent("chunker", `Глава #${payload.chapterIndex} → ${payload.chunks} чанков`, "info");
  renderStats(root);
}

function handleExtractEvent(root, payload) {
  const eventType = String(payload.type ?? "");
  if (eventType === "extract.chunk.done") {
    const raw = Number(payload.raw ?? 0);
    const valid = Number(payload.valid ?? 0);
    STATE.stats.extracted += valid;
    pushEvent(
      "extract",
      `chunk ${payload.chunkPart}/${payload.chunkTotal}: raw=${raw} valid=${valid} (${payload.durationMs}ms)`,
      valid > 0 ? "good" : "warn"
    );
    renderStats(root);
  } else if (eventType === "extract.chunk.error") {
    pushEvent("extract", `chunk ${payload.chunkPart}: ${payload.error}`, "bad");
  }
}

function handleDedupEvent(root, payload) {
  const eventType = String(payload.type ?? "");
  if (eventType === "intra-dedup.merge") {
    pushEvent("dedup", `merge sim=${Number(payload.sim).toFixed(3)} «${payload.principleA}» ↔ «${payload.principleB}»`, "warn");
  } else if (eventType === "intra-dedup.done") {
    STATE.stats.deduped = Number(payload.after ?? STATE.stats.deduped);
    pushEvent("dedup", `${payload.before} → ${payload.after} (мерджей: ${payload.mergedPairs})`, "info");
    renderStats(root);
  }
}

function handleJudgeEvent(root, payload) {
  const eventType = String(payload.type ?? "");
  if (eventType === "judge.score") {
    pushEvent(
      "judge",
      `score=${Number(payload.score).toFixed(2)} N=${Number(payload.novelty).toFixed(2)} A=${Number(payload.actionability).toFixed(2)} D=${Number(payload.domain_fit).toFixed(2)}`,
      "info"
    );
    return;
  }
  if (eventType === "judge.accept") {
    STATE.stats.accepted++;
    const score = Number(payload.score ?? 0);
    pushEvent("judge", `ACCEPT ${score.toFixed(2)} «${payload.principle}»`, "good");
    STATE.acceptedThisSession.push({
      conceptId: String(payload.conceptId ?? ""),
      principle: String(payload.principle ?? ""),
      domain: String(payload.domain ?? "?"),
      score,
    });
    renderStats(root);
    renderAccepted(root);
    renderAcceptedTotal(root);
    return;
  }
  if (eventType === "judge.reject.lowscore") {
    STATE.stats.rejected++;
    pushEvent("judge", `REJECT lowscore=${Number(payload.score).toFixed(2)} «${payload.principle}»`, "warn");
    renderStats(root);
    return;
  }
  if (eventType === "judge.crossdupe") {
    STATE.stats.rejected++;
    pushEvent("judge", `REJECT crossdupe sim=${Number(payload.sim).toFixed(3)} «${payload.principle}»`, "warn");
    renderStats(root);
    return;
  }
  if (eventType === "judge.reject.error") {
    STATE.stats.rejected++;
    pushEvent("judge", `REJECT error «${payload.principle}»: ${payload.reason}`, "bad");
    renderStats(root);
  }
}

function handleChapterEvent(_root, payload) {
  if (String(payload.phase ?? "") !== "done") return;
  pushEvent(
    "chapter",
    `done #${payload.chapterIndex}: extracted=${payload.extracted} deduped=${payload.deduped} accepted=${payload.accepted} rejected=${payload.rejected}`,
    "good"
  );
}

function handleJobEvent(root, payload) {
  if (String(payload.phase ?? "") !== "done") return;
  pushEvent("job", "DONE — вся книга обработана", "good");
  setBusy(root, false);
}

const STAGE_HANDLERS = {
  "parse": handleParseEvent,
  "chunker": handleChunkerEvent,
  "extract": handleExtractEvent,
  "intra-dedup": handleDedupEvent,
  "judge": handleJudgeEvent,
  "chapter": handleChapterEvent,
  "job": handleJobEvent,
};

function handleEvent(root, payload) {
  if (payload.jobId) {
    if (!STATE.currentJobId) {
      STATE.currentJobId = payload.jobId;
    } else if (payload.jobId !== STATE.currentJobId) {
      return;
    }
  }
  const handler = STAGE_HANDLERS[String(payload.stage ?? "")];
  if (handler) handler(root, payload);
  renderLog(root);
}

async function startJob(root) {
  if (STATE.busy) return;
  if (!STATE.selectedBook) {
    await showAlert(t("crystal.alert.noBook"));
    return;
  }
  const extractModel = extractorSelect?.getValue() ?? "";
  const judgeModel = judgeSelect?.getValue() ?? "";
  if (!extractModel || !judgeModel) {
    await showAlert(t("crystal.alert.noModel"));
    return;
  }
  resetStats();
  setBusy(root, true);
  renderStats(root);
  renderLog(root);
  renderAccepted(root);
  pushEvent("job", t("crystal.event.started"), "info");
  try {
    const result = await window.api.datasetV2.startExtraction({
      bookSourcePath: STATE.selectedBook,
      extractModel,
      judgeModel,
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
    pushEvent("job", t("crystal.event.stoppedByUser"), "warn");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    pushEvent("job", t("crystal.event.stopFailed") + ": " + msg, "bad");
  }
  setBusy(root, false);
  renderLog(root);
}

export function mountCrystal(root) {
  if (!root) return;
  if (root.dataset.mounted === "1") return;
  root.dataset.mounted = "1";
  clear(root);

  root.appendChild(buildNeonHero({
    title: t("crystal.header.title"),
    subtitle: t("crystal.header.sub"),
    pattern: "metatron",
  }));
  root.appendChild(neonDivider());

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

  /* model-select экземпляры самозагружаются при создании внутри renderControls.
     Здесь параллельно подгружаем history (для buildSourceRow) и threshold (slider).
     AUDIT 2026-04-21: добавлен .catch — без него любая ошибка IPC (preferences,
     scanner.listHistory) превращалась в unhandledrejection и Crystallizer
     оставался полупустым без диагностики. */
  Promise.all([loadHistory(), loadThresholdFromPrefs()])
    .then(() => {
      renderControls(root);
      renderStats(root);
      renderLog(root);
      renderAccepted(root);
      renderAcceptedTotal(root);
    })
    .catch((e) => {
      console.error("[crystal] bootstrap failed:", e);
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
