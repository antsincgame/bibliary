// @ts-check
import { el, clear } from "./dom.js";
import { t, onLocaleChange } from "./i18n.js";

const ROLE_LABELS = {
  crystallizer: "arena.role.crystallizer",
  judge: "arena.role.judge",
  evaluator: "arena.role.evaluator",
  vision_meta: "arena.role.vision",
};

const REFRESH_MS = 10_000;
const FEEDBACK_HOLD_MS = 6_000;

let root = null;
let refreshTimer = null;
let lockTimer = null;
let localeUnsub = null;

export function mountArena(container) {
  if (!container || container.dataset.mounted) return;
  container.dataset.mounted = "1";
  root = container;
  render();
  localeUnsub = onLocaleChange(() => render());
}

export function unmountArena() {
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
  if (lockTimer) { clearInterval(lockTimer); lockTimer = null; }
  if (localeUnsub) { localeUnsub(); localeUnsub = null; }
  if (root) { delete root.dataset.mounted; }
  root = null;
}

async function render() {
  if (!root) return;
  clear(root);

  const [config, ratings] = await Promise.all([
    window.api.arena.getConfig(),
    window.api.arena.getRatings(),
  ]);

  const enabled = /** @type {boolean} */ (config.arenaEnabled);

  const header = el("div", { class: "arena-header" }, [
    el("h2", { class: "arena-title" }, t("arena.title")),
    el("p", { class: "arena-subtitle" }, t("arena.subtitle")),
  ]);

  const reqBox = el("div", { class: "arena-requirements" }, [
    el("div", { class: "arena-requirements-title" }, t("arena.requirements.title")),
    el("ul", { class: "arena-requirements-list" }, [
      el("li", {}, t("arena.requirements.models")),
      el("li", {}, t("arena.requirements.lmFree")),
      el("li", {}, t("arena.requirements.time")),
    ]),
  ]);

  const lockStatusEl = el("div", { class: "arena-lock-status" }, t("arena.lock.checking"));

  const toggleRow = el("div", { class: "arena-toggle-row" }, [
    el("label", { class: "arena-toggle-label" }, [
      el("span", { class: "arena-toggle-text" }, [
        el("span", { class: "arena-toggle-title" }, t("arena.autoCalibrate")),
        el("span", { class: "arena-toggle-hint" }, t("arena.autoCalibrate.hint")),
      ]),
      createToggle(enabled, async (val) => {
        await window.api.arena.setConfig({ arenaEnabled: val });
        render();
      }),
    ]),
  ]);

  const feedbackEl = el("div", { class: "arena-feedback", hidden: true });

  const runBtn = el("button", {
    class: "arena-run-btn",
    onclick: async () => {
      runBtn.disabled = true;
      runBtn.textContent = t("arena.running");
      showFeedback(feedbackEl, t("arena.running"), "info");
      try {
        const result = await window.api.arena.runCycle({ manual: true });
        applyCycleResult(result, runBtn, feedbackEl);
        setTimeout(() => render(), 2500);
      } catch (e) {
        runBtn.textContent = t("arena.failed");
        showFeedback(
          feedbackEl,
          t("arena.feedback.exception", { msg: e instanceof Error ? e.message : String(e) }),
          "error",
        );
        setTimeout(() => render(), 3000);
      } finally {
        runBtn.disabled = false;
      }
    },
  }, t("arena.runNow"));

  const statusLine = buildStatusLine(ratings);
  const table = buildRatingsTable(ratings);

  const settingsSection = buildSettings(config);

  root.appendChild(
    el("div", { class: "arena-page" }, [
      header,
      reqBox,
      lockStatusEl,
      toggleRow,
      el("div", { class: "arena-actions" }, [runBtn, statusLine]),
      feedbackEl,
      table,
      settingsSection,
    ]),
  );

  refreshLockStatus(lockStatusEl);
  if (lockTimer) clearInterval(lockTimer);
  lockTimer = setInterval(() => refreshLockStatus(lockStatusEl), 5000);

  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(() => refreshRatings(), REFRESH_MS);
}

/**
 * Превращает CycleReport в человекочитаемое сообщение.
 * @param {{ok: boolean; message?: string; skipped?: boolean; skipReasons?: string[]; perRole?: Array<{role: string; matches: number; skipped?: string}>}} result
 * @param {HTMLButtonElement} btn
 * @param {HTMLElement} fb
 */
function applyCycleResult(result, btn, fb) {
  if (result.skipped) {
    btn.textContent = t("arena.failed");
    const reasons = (result.skipReasons || []).join(", ") || result.message || "";
    showFeedback(fb, t("arena.feedback.skippedLock", { reasons }), "warn");
    return;
  }

  if (!result.ok) {
    btn.textContent = t("arena.failed");
    const msg = result.message || "";
    if (/at least 2 loaded/i.test(msg)) {
      showFeedback(fb, t("arena.feedback.fewModels"), "warn");
    } else if (/no calibratable roles/i.test(msg)) {
      showFeedback(fb, t("arena.feedback.noRoles"), "warn");
    } else {
      showFeedback(fb, t("arena.feedback.failed", { msg }), "error");
    }
    return;
  }

  const perRole = result.perRole || [];
  const totalMatches = perRole.reduce((acc, r) => acc + (r.matches || 0), 0);

  if (totalMatches === 0) {
    btn.textContent = t("arena.done");
    const skipped = perRole.filter((r) => r.skipped);
    if (skipped.length > 0) {
      const skipText = skipped
        .map((r) => `${roleHuman(r.role)}: ${humanizeSkip(r.skipped || "")}`)
        .join("; ");
      showFeedback(fb, t("arena.feedback.zeroMatches", { details: skipText }), "warn");
    } else {
      showFeedback(fb, t("arena.feedback.zeroMatchesNoSkips"), "warn");
    }
    return;
  }

  btn.textContent = t("arena.done");
  const rolesPlayed = perRole
    .filter((r) => r.matches > 0)
    .map((r) => roleHuman(r.role))
    .join(", ");
  showFeedback(
    fb,
    t("arena.feedback.success", { matches: String(totalMatches), roles: rolesPlayed || "—" }),
    "ok",
  );
}

/** @param {string} role */
function roleHuman(role) {
  const key = ROLE_LABELS[role];
  return key ? t(key) : role;
}

/** @param {string} reason */
function humanizeSkip(reason) {
  const r = reason.toLowerCase();
  if (r.includes("need at least 2 eligible models")) {
    if (r.includes("vision_meta")) return t("arena.skip.fewVision");
    return t("arena.skip.fewModels");
  }
  if (r.includes("no golden prompt")) return t("arena.skip.noPrompt");
  return reason;
}

/**
 * @param {HTMLElement} el
 * @param {string} text
 * @param {"info"|"ok"|"warn"|"error"} kind
 */
function showFeedback(el, text, kind) {
  el.hidden = false;
  el.className = `arena-feedback arena-feedback-${kind}`;
  el.textContent = text;
  if (kind === "ok" || kind === "warn" || kind === "error") {
    setTimeout(() => {
      if (el.textContent === text) {
        el.hidden = true;
        el.textContent = "";
      }
    }, FEEDBACK_HOLD_MS);
  }
}

async function refreshLockStatus(target) {
  if (!target) return;
  try {
    const status = await window.api.arena.getLockStatus();
    if (status.busy) {
      target.className = "arena-lock-status arena-lock-busy";
      target.textContent = t("arena.lock.busy", {
        reasons: (status.reasons || []).join(", ") || "—",
      });
    } else {
      target.className = "arena-lock-status arena-lock-free";
      target.textContent = t("arena.lock.free");
    }
  } catch {
    target.className = "arena-lock-status arena-lock-unknown";
    target.textContent = t("arena.lock.unknown");
  }
}

function createToggle(on, onChange) {
  const input = el("input", {
    type: "checkbox",
    class: "arena-checkbox",
    ...(on ? { checked: "" } : {}),
    onchange: () => onChange(input.checked),
  });
  if (on) input.checked = true;
  return el("span", { class: "arena-switch" }, input);
}

function buildStatusLine(ratings) {
  if (ratings.lastCycleAt) {
    const d = new Date(ratings.lastCycleAt);
    const ago = timeSince(d);
    return el("span", { class: "arena-status" },
      t("arena.lastRun", { time: ago }));
  }
  if (ratings.lastError) {
    return el("span", { class: "arena-status arena-status-error" },
      t("arena.lastError"));
  }
  return el("span", { class: "arena-status arena-status-idle" },
    t("arena.neverRun"));
}

function buildRatingsTable(ratings) {
  const roles = ratings.roles || {};
  const roleKeys = Object.keys(ROLE_LABELS);
  const hasAny = roleKeys.some((r) => roles[r] && Object.keys(roles[r]).length > 0);

  if (!hasAny) {
    return el("div", { class: "arena-empty" }, t("arena.noData"));
  }

  const rows = [];
  for (const role of roleKeys) {
    const bucket = roles[role];
    if (!bucket || Object.keys(bucket).length === 0) continue;

    const sorted = Object.entries(bucket)
      .sort((a, b) => /** @type {number} */ (b[1]) - /** @type {number} */ (a[1]));
    const best = sorted[0];

    rows.push(
      el("tr", { class: "arena-row" }, [
        el("td", { class: "arena-cell arena-cell-role" }, t(ROLE_LABELS[role])),
        el("td", { class: "arena-cell arena-cell-model" }, shortModelName(best[0])),
        el("td", { class: "arena-cell arena-cell-elo" }, String(Math.round(/** @type {number} */ (best[1])))),
        el("td", { class: "arena-cell arena-cell-count" }, String(sorted.length)),
      ]),
    );
  }

  return el("table", { class: "arena-table" }, [
    el("thead", {}, el("tr", {}, [
      el("th", {}, t("arena.col.role")),
      el("th", {}, t("arena.col.best")),
      el("th", {}, t("arena.col.elo")),
      el("th", {}, t("arena.col.models")),
    ])),
    el("tbody", {}, rows),
  ]);
}

function buildSettings(config) {
  const items = [
    {
      key: "arenaUseLlmJudge",
      label: "arena.setting.llmJudge",
      hint: "arena.setting.llmJudge.hint",
      value: config.arenaUseLlmJudge,
    },
    {
      key: "arenaAutoPromoteWinner",
      label: "arena.setting.autoPromote",
      hint: "arena.setting.autoPromote.hint",
      value: config.arenaAutoPromoteWinner,
    },
  ];

  return el("details", { class: "arena-settings" }, [
    el("summary", {}, t("arena.settings")),
    el("div", { class: "arena-settings-body" },
      items.map((item) =>
        el("label", { class: "arena-setting-row" }, [
          el("span", { class: "arena-setting-text" }, [
            el("span", { class: "arena-setting-title" }, t(item.label)),
            el("span", { class: "arena-setting-hint" }, t(item.hint)),
          ]),
          createToggle(item.value, async (val) => {
            await window.api.arena.setConfig({ [item.key]: val });
          }),
        ]),
      ),
    ),
    el("div", { class: "arena-settings-body" }, [
      el("button", {
        class: "arena-reset-btn",
        title: t("arena.reset.tooltip"),
        onclick: async () => {
          await window.api.arena.resetRatings();
          render();
        },
      }, t("arena.reset")),
    ]),
  ]);
}

function shortModelName(key) {
  if (!key) return "—";
  const parts = key.split("/");
  return parts[parts.length - 1] || key;
}

function timeSince(date) {
  const s = Math.floor((Date.now() - date.getTime()) / 1000);
  if (s < 60) return t("arena.time.justNow");
  if (s < 3600) return t("arena.time.minAgo", { n: Math.floor(s / 60) });
  if (s < 86400) return t("arena.time.hrAgo", { n: Math.floor(s / 3600) });
  return t("arena.time.dayAgo", { n: Math.floor(s / 86400) });
}

async function refreshRatings() {
  if (!root) return;
  try {
    const ratings = await window.api.arena.getRatings();
    const tbody = root.querySelector(".arena-table tbody");
    if (tbody) {
      const roles = ratings.roles || {};
      const roleKeys = Object.keys(ROLE_LABELS);
      const rows = tbody.querySelectorAll(".arena-row");
      let i = 0;
      for (const role of roleKeys) {
        const bucket = roles[role];
        if (!bucket || Object.keys(bucket).length === 0) continue;
        const sorted = Object.entries(bucket).sort((a, b) => b[1] - a[1]);
        const row = rows[i];
        if (row) {
          const cells = row.querySelectorAll(".arena-cell");
          if (cells[1]) cells[1].textContent = shortModelName(sorted[0][0]);
          if (cells[2]) cells[2].textContent = String(Math.round(sorted[0][1]));
          if (cells[3]) cells[3].textContent = String(sorted.length);
        }
        i++;
      }
    }
  } catch { /* silent refresh failure */ }
}

export function isArenaBusy() { return false; }
