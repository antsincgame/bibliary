// @ts-check
/**
 * Preflight modal — показывается перед импортом для папки/файлов.
 *
 * Получает PreflightReport из IPC, рендерит summary с разбивкой
 * (ok/image-only/invalid), оценкой OCR-движков, и 4 кнопками действий:
 *   [Continue all]  [Skip image-only]  [Configure OCR]  [Cancel]
 *
 * Возвращает Promise<PreflightDecision>:
 *   { action: "continue" }            — пользователь подтвердил импорт всех
 *   { action: "skip-image-only", paths: string[] } — отфильтрованный список
 *   { action: "configure-ocr" }       — нужно открыть Settings → OCR
 *   { action: "cancel" }              — отменено
 */

import { el } from "../dom.js";
import { t } from "../i18n.js";

/**
 * @typedef {Object} PreflightOcrSection
 * @property {boolean} available
 * @property {NodeJS.Platform | string} [platform]
 * @property {string[]} [languages]
 * @property {string} [modelKey]
 * @property {string} [reason]
 */

/**
 * @typedef {Object} PreflightOcr
 * @property {PreflightOcrSection} systemOcr
 * @property {PreflightOcrSection} visionLlm
 * @property {boolean} anyAvailable
 */

/**
 * @typedef {Object} PreflightEvaluator
 * @property {boolean} ready
 * @property {string} [preferred]
 * @property {string} [willUse]
 * @property {"preferred"|"fallback"|"auto-pick"} [source]
 * @property {string} [reason]
 * @property {boolean} fallbackPolicyEnabled
 */

/**
 * @typedef {Object} PreflightEntry
 * @property {string} path
 * @property {number} size
 * @property {string} ext
 * @property {"ok"|"image-only"|"unknown"|"invalid"} status
 * @property {string} [reason]
 */

/**
 * @typedef {Object} PreflightReport
 * @property {number} totalFiles
 * @property {number} okFiles
 * @property {number} imageOnlyFiles
 * @property {number} unknownFiles
 * @property {number} invalidFiles
 * @property {number} skippedFiles
 * @property {PreflightOcr} ocr
 * @property {PreflightEvaluator} [evaluator]
 * @property {PreflightEntry[]} entries
 * @property {number} elapsedMs
 */

/**
 * @typedef {{action:"continue"}|{action:"skip-image-only", paths:string[]}|{action:"configure-ocr"}|{action:"cancel"}} PreflightDecision
 */

/**
 * Показывает модал с preflight-отчётом и ждёт решения пользователя.
 * @param {PreflightReport} report
 * @returns {Promise<PreflightDecision>}
 */
export function showPreflightModal(report) {
  return new Promise((resolve) => {
    const overlay = el("div", { class: "qdrant-overlay ui-dialog-overlay lib-preflight-overlay" });
    const modal = el("div", { class: "qdrant-dialog ui-dialog lib-preflight-dialog" });

    const body = renderPreflightBody(report);

    /** @type {PreflightDecision} */
    let decision = { action: "cancel" };
    const close = () => {
      try { overlay.remove(); } catch { /* swallow */ }
      document.removeEventListener("keydown", onEsc);
      resolve(decision);
    };
    const onEsc = (/** @type {KeyboardEvent} */ ev) => {
      if (ev.key === "Escape") { decision = { action: "cancel" }; close(); }
    };
    document.addEventListener("keydown", onEsc);
    overlay.addEventListener("click", (ev) => { if (ev.target === overlay) { decision = { action: "cancel" }; close(); } });

    const actions = el("div", { class: "qdrant-dialog-actions ui-dialog-actions lib-preflight-actions" });

    const btnContinue = el("button", {
      type: "button",
      class: "btn-primary",
      onclick: () => { decision = { action: "continue" }; close(); },
    }, t("library.import.preflight.btn.continue"));

    const btnSkip = el("button", {
      type: "button",
      class: "btn-secondary",
      onclick: () => {
        const keep = report.entries.filter((e) => e.status !== "image-only").map((e) => e.path);
        decision = { action: "skip-image-only", paths: keep };
        close();
      },
    }, t("library.import.preflight.btn.skipImageOnly", { n: String(report.imageOnlyFiles) }));

    if (report.imageOnlyFiles === 0) {
      /** @type {HTMLButtonElement} */ (btnSkip).disabled = true;
    }

    const btnOcr = el("button", {
      type: "button",
      class: "btn-secondary",
      onclick: () => { decision = { action: "configure-ocr" }; close(); },
    }, t("library.import.preflight.btn.configureOcr"));

    const btnCancel = el("button", {
      type: "button",
      class: "btn-secondary",
      onclick: () => { decision = { action: "cancel" }; close(); },
    }, t("library.import.preflight.btn.cancel"));

    actions.append(btnCancel, btnOcr, btnSkip, btnContinue);
    modal.append(body, actions);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    overlay.tabIndex = -1;
    try { overlay.focus(); } catch { /* ignore: rare focus failures in embedded contexts */ }
    setTimeout(() => { try { btnContinue.focus(); } catch { /* ignore */ } }, 30);
  });
}

/** @param {PreflightReport} report @returns {HTMLElement} */
function renderPreflightBody(report) {
  const wrap = el("div", { class: "lib-preflight-body" });

  const title = el("div", { class: "lib-preflight-title" }, t("library.import.preflight.title"));

  const summary = el("div", { class: "lib-scan-summary lib-preflight-summary" }, [
    el("div", { class: "lib-scan-stat lib-scan-stat-highlight" }, t("library.import.preflight.summary.total", { n: String(report.totalFiles) })),
    el("div", { class: "lib-scan-stat" }, t("library.import.preflight.summary.ok", { n: String(report.okFiles) })),
    el("div", { class: "lib-scan-stat" }, t("library.import.preflight.summary.imageOnly", { n: String(report.imageOnlyFiles) })),
    ...(report.unknownFiles > 0 ? [el("div", { class: "lib-scan-stat" }, t("library.import.preflight.summary.unknown", { n: String(report.unknownFiles) }))] : []),
    ...(report.invalidFiles > 0 ? [el("div", { class: "lib-scan-stat" }, t("library.import.preflight.summary.invalid", { n: String(report.invalidFiles) }))] : []),
    ...(report.skippedFiles > 0 ? [el("div", { class: "lib-scan-stat lib-scan-stat-muted" }, t("library.import.preflight.summary.skipped", { n: String(report.skippedFiles) }))] : []),
    el("div", { class: "lib-scan-stat lib-scan-stat-muted" }, t("library.import.preflight.elapsed", { ms: String(report.elapsedMs) })),
  ]);

  /* OCR section: показываем только если есть image-only files (иначе не релевантно) */
  let ocrSection = null;
  if (report.imageOnlyFiles > 0) {
    const sysOk = report.ocr.systemOcr.available;
    const sysLine = sysOk
      ? t("library.import.preflight.ocr.system.available", {
          platform: String(report.ocr.systemOcr.platform || "?"),
          langs: (report.ocr.systemOcr.languages ?? []).join(", ") || "—",
        })
      : t("library.import.preflight.ocr.system.unavailable", { reason: report.ocr.systemOcr.reason || "n/a" });

    const visOk = report.ocr.visionLlm.available;
    const visLine = visOk
      ? t("library.import.preflight.ocr.vision.available", { model: report.ocr.visionLlm.modelKey || "?" })
      : t("library.import.preflight.ocr.vision.unavailable", { reason: report.ocr.visionLlm.reason || "n/a" });

    const warn = report.ocr.anyAvailable
      ? el("div", { class: "lib-preflight-warning lib-preflight-warning-info" },
          t("library.import.preflight.warning.imageOnlyHasOcr", { n: String(report.imageOnlyFiles) }))
      : el("div", { class: "lib-preflight-warning lib-preflight-warning-danger" },
          t("library.import.preflight.warning.imageOnlyNoOcr", { n: String(report.imageOnlyFiles) }));

    ocrSection = el("div", { class: "lib-preflight-ocr" }, [
      el("div", { class: "lib-preflight-ocr-title" }, t("library.import.preflight.ocr.title")),
      el("div", { class: "lib-preflight-ocr-line" }, sysLine),
      el("div", { class: "lib-preflight-ocr-line" }, visLine),
      warn,
    ]);
  }

  /* Evaluator section: показываем всегда (даже когда все файлы с text-layer'ом —
     им всё равно нужен evaluator чтобы получить статус "Оценено"). */
  const evaluatorSection = renderEvaluatorSection(report.evaluator);

  wrap.append(title, summary);
  if (ocrSection) wrap.appendChild(ocrSection);
  if (evaluatorSection) wrap.appendChild(evaluatorSection);
  return wrap;
}

/** @param {PreflightEvaluator | undefined} ev @returns {HTMLElement | null} */
function renderEvaluatorSection(ev) {
  if (!ev) return null;

  /** @type {string} */
  let line;
  /** @type {"info" | "warning" | "danger"} */
  let kind;

  if (ev.ready) {
    if (ev.source === "preferred") {
      line = t("library.import.preflight.evaluator.usingPreferred", { model: ev.willUse || "?" });
      kind = "info";
    } else if (ev.source === "fallback") {
      line = t("library.import.preflight.evaluator.usingFallback", {
        preferred: ev.preferred || "?",
        willUse: ev.willUse || "?",
      });
      kind = "warning";
    } else if (ev.source === "auto-pick") {
      const key = ev.preferred
        ? "library.import.preflight.evaluator.usingAutoPick"
        : "library.import.preflight.evaluator.usingAutoPickNoPref";
      line = t(key, { preferred: ev.preferred || "?", willUse: ev.willUse || "?" });
      kind = ev.preferred ? "warning" : "info";
    } else {
      line = t("library.import.preflight.evaluator.usingPreferred", { model: ev.willUse || "?" });
      kind = "info";
    }
  } else {
    if (ev.reason === "preferred-not-loaded") {
      line = t("library.import.preflight.evaluator.notReady.preferredNotLoaded", { preferred: ev.preferred || "?" });
    } else if (ev.reason === "no-llm-loaded") {
      line = t("library.import.preflight.evaluator.notReady.noLlm");
    } else if (ev.reason && ev.reason.startsWith("lm-studio-unreachable")) {
      line = t("library.import.preflight.evaluator.notReady.unreachable", {
        reason: ev.reason.replace(/^lm-studio-unreachable:\s*/, ""),
      });
    } else {
      line = t("library.import.preflight.evaluator.notReady.noLlm");
    }
    kind = "danger";
  }

  const cls = kind === "danger"
    ? "lib-preflight-warning lib-preflight-warning-danger"
    : kind === "warning"
      ? "lib-preflight-warning lib-preflight-warning-info"
      : "lib-preflight-ocr-line";

  return el("div", { class: "lib-preflight-ocr" }, [
    el("div", { class: "lib-preflight-ocr-title" }, t("library.import.preflight.evaluator.title")),
    el("div", { class: cls }, line),
  ]);
}
