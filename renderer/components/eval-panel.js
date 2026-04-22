// @ts-check
import { el, clear } from "../dom.js";
import { t } from "../i18n.js";

/**
 * Eval Suite panel — A/B compare base vs tuned на eval-set.
 *
 * Pro tier: показывается в Forge wizard Step 5, когда target=local.
 *
 * @param {object} opts
 * @param {string} opts.evalPath
 * @param {string} opts.baseModelDefault
 * @param {string} [opts.tunedModelDefault]
 * @returns {HTMLElement}
 */
export function buildEvalPanel(opts) {
  const root = el("div", { class: "eval-panel" });

  const baseInput = mkText("base", opts.baseModelDefault || "");
  const tunedInput = mkText("tuned", opts.tunedModelDefault || "");
  const judgeInput = mkText("judge", "");
  const limitInput = mkNumber("limit", 20);

  const fields = el("div", { class: "eval-fields" }, [
    labeled(t("eval.base_model"), baseInput),
    labeled(t("eval.tuned_model"), tunedInput),
    labeled(t("eval.judge_model"), judgeInput),
    labeled(t("eval.max_cases"), limitInput),
  ]);
  root.appendChild(fields);

  const progress = el("div", { class: "eval-progress" }, "");
  const summaryHost = el("div", { class: "eval-summary" });

  const runBtn = el("button", { class: "btn btn-gold", type: "button" }, t("eval.run"));
  const cancelBtn = /** @type {HTMLButtonElement} */ (
    el("button", { class: "btn btn-secondary", type: "button" }, t("eval.cancel"))
  );
  cancelBtn.style.display = "none";
  cancelBtn.addEventListener("click", () => {
    cancelBtn.disabled = true;
    window.api.forgeLocal.cancelEval().catch((e) => {
      console.warn("[eval-panel] cancelEval failed:", e);
    });
  });

  const btnRow = el("div", { class: "eval-btn-row" }, [runBtn, cancelBtn]);

  let progressUnsub = null;
  runBtn.addEventListener("click", async () => {
    const baseModel = baseInput.value.trim();
    const tunedModel = tunedInput.value.trim();
    const judgeModel = judgeInput.value.trim() || undefined;
    const maxCases = Number(limitInput.value) || 20;

    if (!baseModel || !tunedModel) {
      progress.textContent = t("eval.error.no_models");
      return;
    }

    runBtn.disabled = true;
    cancelBtn.disabled = false;
    cancelBtn.style.display = "";
    progress.textContent = t("eval.running", { done: 0, total: maxCases });
    clear(summaryHost);

    if (progressUnsub) progressUnsub();
    progressUnsub = window.api.forgeLocal.onEvalProgress(({ done, total }) => {
      progress.textContent = t("eval.running", { done, total });
    });

    try {
      const summary = /** @type {any} */ (await window.api.forgeLocal.runEval({
        evalPath: opts.evalPath,
        baseModel,
        tunedModel,
        judgeModel,
        maxCases,
      }));
      progress.textContent = t("eval.done");
      summaryHost.appendChild(buildSummary(summary));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      /* AbortError из chatWithPolicy → пользовательская отмена, не ошибка. */
      const cancelled = /abort|cancel/i.test(msg);
      progress.textContent = cancelled
        ? t("eval.cancelled")
        : t("eval.error.run", { msg });
    } finally {
      runBtn.disabled = false;
      cancelBtn.style.display = "none";
      if (progressUnsub) progressUnsub();
      progressUnsub = null;
    }
  });
  root.appendChild(btnRow);
  root.appendChild(progress);
  root.appendChild(summaryHost);
  return root;
}

function buildSummary(summary) {
  const wrap = el("div", { class: "eval-summary-inner" });

  const headline = el("div", { class: "eval-headline" }, [
    el("span", { class: "eval-stat" }, [
      el("span", { class: "eval-stat-label" }, "ROUGE-L base"),
      el("span", { class: "eval-stat-value" }, String(summary.meanRougeBase)),
    ]),
    el("span", { class: "eval-stat" }, [
      el("span", { class: "eval-stat-label" }, "ROUGE-L tuned"),
      el("span", { class: "eval-stat-value eval-good" }, String(summary.meanRougeTuned)),
    ]),
    el("span", { class: "eval-stat" }, [
      el("span", { class: "eval-stat-label" }, "Δ"),
      el("span", { class: summary.delta > 0 ? "eval-stat-value eval-good" : "eval-stat-value eval-bad" }, String(summary.delta)),
    ]),
  ]);
  wrap.appendChild(headline);

  if (summary.judgeWins) {
    wrap.appendChild(el("div", { class: "eval-judge" }, [
      el("span", {}, `judge: base ${summary.judgeWins.base}`),
      el("span", {}, `tuned ${summary.judgeWins.tuned}`),
      el("span", {}, `tie ${summary.judgeWins.tie}`),
    ]));
  }

  const tableWrap = el("div", { class: "eval-table-wrap" });
  const table = el("table", { class: "eval-table" });
  const thead = el("thead", {}, [
    el("tr", {}, [
      el("th", {}, t("eval.col.prompt")),
      el("th", {}, t("eval.col.base")),
      el("th", {}, t("eval.col.tuned")),
      el("th", {}, t("eval.col.expected")),
      el("th", {}, "ROUGE base"),
      el("th", {}, "ROUGE tuned"),
      el("th", {}, t("eval.col.judge")),
    ]),
  ]);
  const tbody = el("tbody", {});
  for (const c of summary.cases) {
    tbody.appendChild(
      el("tr", {}, [
        el("td", { class: "eval-cell-prompt" }, c.prompt),
        el("td", { class: "eval-cell" }, c.baseAnswer),
        el("td", { class: "eval-cell" }, c.tunedAnswer),
        el("td", { class: "eval-cell eval-cell-expected" }, c.expected),
        el("td", { class: "eval-cell-num" }, String(c.rougeBase.f1)),
        el("td", { class: "eval-cell-num eval-good" }, String(c.rougeTuned.f1)),
        el("td", { class: "eval-cell-judge" }, c.judgeWinner || "—"),
      ])
    );
  }
  table.appendChild(thead);
  table.appendChild(tbody);
  tableWrap.appendChild(table);
  wrap.appendChild(tableWrap);

  return wrap;
}

function mkText(name, value) {
  const input = /** @type {HTMLInputElement} */ (el("input", { type: "text", class: "forge-input", name, value }));
  return input;
}
function mkNumber(name, value) {
  const input = /** @type {HTMLInputElement} */ (el("input", { type: "number", class: "forge-input", name, min: "1", max: "200", value: String(value) }));
  return input;
}
function labeled(label, control) {
  return el("div", { class: "forge-field" }, [
    el("label", { class: "forge-field-label" }, label),
    control,
  ]);
}
