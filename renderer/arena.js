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

let root = null;
let refreshTimer = null;
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
  if (localeUnsub) { localeUnsub(); localeUnsub = null; }
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

  const toggleRow = el("div", { class: "arena-toggle-row" }, [
    el("label", { class: "arena-toggle-label" }, [
      el("span", {}, t("arena.autoCalibrate")),
      createToggle(enabled, async (val) => {
        await window.api.arena.setConfig({ arenaEnabled: val });
        render();
      }),
    ]),
  ]);

  const runBtn = el("button", {
    class: "arena-run-btn",
    onclick: async () => {
      runBtn.disabled = true;
      runBtn.textContent = t("arena.running");
      try {
        const result = await window.api.arena.runCycle({ manual: true });
        runBtn.textContent = result.ok ? t("arena.done") : t("arena.failed");
        setTimeout(() => render(), 1500);
      } catch {
        runBtn.textContent = t("arena.failed");
        setTimeout(() => render(), 2000);
      }
    },
  }, t("arena.runNow"));

  const statusLine = buildStatusLine(ratings);
  const table = buildRatingsTable(ratings);

  const settingsSection = buildSettings(config);

  root.appendChild(
    el("div", { class: "arena-page" }, [
      header,
      toggleRow,
      el("div", { class: "arena-actions" }, [runBtn, statusLine]),
      table,
      settingsSection,
    ]),
  );

  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(() => refreshRatings(), REFRESH_MS);
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
      value: config.arenaUseLlmJudge,
    },
    {
      key: "arenaAutoPromoteWinner",
      label: "arena.setting.autoPromote",
      value: config.arenaAutoPromoteWinner,
    },
  ];

  return el("details", { class: "arena-settings" }, [
    el("summary", {}, t("arena.settings")),
    el("div", { class: "arena-settings-body" },
      items.map((item) =>
        el("label", { class: "arena-setting-row" }, [
          el("span", {}, t(item.label)),
          createToggle(item.value, async (val) => {
            await window.api.arena.setConfig({ [item.key]: val });
          }),
        ]),
      ),
    ),
    el("div", { class: "arena-settings-body" }, [
      el("button", {
        class: "arena-reset-btn",
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
