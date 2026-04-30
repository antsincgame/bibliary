// @ts-check
/**
 * Запуск синтеза + рендер прогресса/результата + IPC event handler.
 *
 * Извлечено из `renderer/dataset-v2.js` (Phase 3.4 cross-platform roadmap,
 * 2026-04-30).
 */

import { el, clear } from "./dom.js";
import { t } from "./i18n.js";
import { showAlert, showConfirm } from "./components/ui-dialog.js";
import { recordDataset } from "./datasets-history.js";
import { STATE, phaseToLabel } from "./dataset-v2-state.js";

export async function onSynthStart(root) {
  if (STATE.busy) return;
  if (!STATE.collection) {
    await showAlert(t("dataset.alert.noCollection"));
    return;
  }
  if (!STATE.outputDir) {
    await showAlert(t("dataset.alert.noFolder"));
    return;
  }
  const model = STATE.refs.synthModelSelect?.getValue() ?? "";
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

export async function onSynthStop(root) {
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

export function buildProgress() {
  return el("div", { class: "ds-progress", id: "ds-progress" });
}

export function renderProgress(root) {
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

/** Обработчик IPC-событий dataset-v2:event для UI прогресса синтеза. */
export function handleEvent(root, payload) {
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
