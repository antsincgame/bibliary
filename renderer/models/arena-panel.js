// @ts-check
import { clear, el } from "../dom.js";
import { t } from "../i18n.js";
import { formatElo, ROLE_ORDER, roleLabel } from "./role-utils.js";

const TOP_RATINGS_PER_ROLE = 4;
const MIN_MATCH_PAIRS_PER_RUN = 1;
const MAX_MATCH_PAIRS_PER_RUN = 10;

function boolToggle(label, checked, onChange) {
  const input = el("input", { type: "checkbox" });
  input.checked = Boolean(checked);
  input.addEventListener("change", () => onChange(input.checked));
  return el("label", { class: "arena-toggle" }, [input, el("span", {}, label)]);
}

function renderRatings(host, ratings) {
  clear(host);
  for (const role of ROLE_ORDER) {
    const roleRatings = ratings?.roles?.[role] ?? {};
    const ranked = Object.entries(roleRatings)
      .sort((a, b) => b[1] - a[1])
      .slice(0, TOP_RATINGS_PER_ROLE);
    host.appendChild(el("div", { class: "arena-rating-row" }, [
      el("div", { class: "arena-rating-role" }, roleLabel(role)),
      el("div", { class: "arena-rating-models" }, ranked.length > 0
        ? ranked.map(([model, elo], index) =>
          el("span", { class: index === 0 ? "elo-badge elo-top" : "elo-badge" }, `${model}: ${formatElo(elo)}`))
        : el("span", { class: "muted" }, t("models.arena.no_ratings"))),
    ]));
  }
}

export function buildArenaPanel({ progress, onRefresh, onError }) {
  const configHost = el("div", { class: "arena-config" }, t("models.card.loading"));
  const ratingsHost = el("div", { class: "arena-ratings" });
  const lockHost = el("div", { class: "arena-lock" }, t("models.card.loading"));

  function reportError(err) {
    if (onError) onError(err instanceof Error ? err : new Error(String(err)));
  }

  async function setConfigAndRefresh(partial) {
    try {
      await window.api.arena.setConfig(partial);
      await refreshPanel();
      if (onRefresh) await onRefresh();
    } catch (err) {
      reportError(err);
      await refreshPanel();
    }
  }

  async function refreshPanel() {
    const [config, ratings, lock] = await Promise.all([
      window.api.arena.getConfig(),
      window.api.arena.getRatings(),
      window.api.arena.getLockStatus(),
    ]);
    clear(configHost);
    configHost.append(
      boolToggle(t("models.arena.enabled"), config.arenaEnabled, (value) => {
        void setConfigAndRefresh({ arenaEnabled: value });
      }),
      boolToggle(t("models.arena.llm_judge"), config.arenaUseLlmJudge, (value) => {
        void setConfigAndRefresh({ arenaUseLlmJudge: value });
      }),
      boolToggle(t("models.arena.auto_promote"), config.arenaAutoPromoteWinner, (value) => {
        if (value && !confirm(t("models.arena.auto_promote_confirm"))) {
          void refreshPanel();
          return;
        }
        void setConfigAndRefresh({ arenaAutoPromoteWinner: value });
      }),
      el("label", { class: "arena-number" }, [
        el("span", {}, t("models.arena.pairs")),
        (() => {
          const input = el("input", {
            type: "number",
            min: String(MIN_MATCH_PAIRS_PER_RUN),
            max: String(MAX_MATCH_PAIRS_PER_RUN),
            value: String(config.arenaMatchPairsPerCycle),
          });
          input.addEventListener("change", () => {
            void setConfigAndRefresh({
              arenaMatchPairsPerCycle: Math.max(
                MIN_MATCH_PAIRS_PER_RUN,
                Math.min(MAX_MATCH_PAIRS_PER_RUN, Number(input.value) || MIN_MATCH_PAIRS_PER_RUN),
              ),
            });
          });
          return input;
        })(),
      ]),
    );
    lockHost.textContent = lock.busy
      ? t("models.arena.lock_busy", { reason: lock.reasons.join(", ") })
      : t("models.arena.lock_idle", { count: lock.skipCount });
    renderRatings(ratingsHost, ratings);
  }

  const runBtn = el("button", { class: "cyber-button cyber-button-primary", type: "button" }, t("models.arena.run_now"));
  runBtn.addEventListener("click", async () => {
    runBtn.disabled = true;
    progress?.start(t("models.calibration.pro_cycle"));
    try {
      const report = await window.api.arena.runCycle({ manual: true });
      progress?.finish(report.ok, report.message);
      await refreshPanel();
      if (onRefresh) await onRefresh();
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      progress?.finish(false, error.message);
      reportError(error);
    } finally {
      runBtn.disabled = false;
    }
  });

  const resetBtn = el("button", { class: "cyber-button cyber-button-danger", type: "button" }, t("models.arena.reset"));
  resetBtn.addEventListener("click", async () => {
    if (!confirm(t("models.arena.reset_confirm"))) return;
    resetBtn.disabled = true;
    try {
      await window.api.arena.resetRatings();
      await refreshPanel();
      if (onRefresh) await onRefresh();
    } catch (err) {
      reportError(err);
    } finally {
      resetBtn.disabled = false;
    }
  });

  const panel = el("div", { class: "arena-panel" }, [
    el("div", { class: "arena-actions" }, [runBtn, resetBtn]),
    lockHost,
    configHost,
    ratingsHost,
  ]);
  void refreshPanel().catch(reportError);
  return panel;
}
