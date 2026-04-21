// @ts-check
/**
 * Settings page -- user-tunable preferences with mode-gated sections.
 *
 * Simple: RAG top-k, temperature, ingest parallelism, toast TTL.
 * Advanced: chunker params, judge thresholds, dedup, timeouts.
 * Pro: resilience policies, forge watchdog, Qdrant tuning.
 */
import { el, clear } from "./dom.js";
import { t } from "./i18n.js";
import { getMode } from "./ui-mode.js";
import { buildNeonHero, wrapSacredCard, neonDivider } from "./components/neon-helpers.js";

/** @returns {any} */
function api() { return /** @type {any} */ (window).api; }

const STATE = {
  /** @type {Record<string, unknown>} */
  prefs: {},
  /** @type {Record<string, unknown>} */
  defaults: {},
  dirty: false,
  saving: false,
};

const SECTIONS = [
  {
    id: "chat",
    titleKey: "settings.section.chat",
    mode: "simple",
    fields: [
      { key: "ragTopK", type: "int", min: 1, max: 100, labelKey: "settings.ragTopK" },
      { key: "ragScoreThreshold", type: "float", min: 0, max: 1, step: 0.05, labelKey: "settings.ragScoreThreshold" },
      { key: "chatTemperature", type: "float", min: 0, max: 2, step: 0.1, labelKey: "settings.chatTemperature" },
      { key: "chatTopP", type: "float", min: 0, max: 1, step: 0.05, labelKey: "settings.chatTopP" },
      { key: "chatMaxTokens", type: "int", min: 256, max: 131072, labelKey: "settings.chatMaxTokens" },
    ],
  },
  {
    id: "ingest",
    titleKey: "settings.section.ingest",
    mode: "simple",
    fields: [
      { key: "ingestParallelism", type: "int", min: 1, max: 16, labelKey: "settings.ingestParallelism" },
      { key: "searchPerSourceLimit", type: "int", min: 1, max: 50, labelKey: "settings.searchPerSourceLimit" },
      { key: "qdrantSearchLimit", type: "int", min: 1, max: 100, labelKey: "settings.qdrantSearchLimit" },
    ],
  },
  {
    id: "chunker",
    titleKey: "settings.section.chunker",
    mode: "advanced",
    fields: [
      { key: "chunkSafeLimit", type: "int", min: 500, max: 20000, labelKey: "settings.chunkSafeLimit" },
      { key: "chunkMinWords", type: "int", min: 50, max: 2000, labelKey: "settings.chunkMinWords" },
      { key: "driftThreshold", type: "float", min: 0, max: 1, step: 0.05, labelKey: "settings.driftThreshold" },
      { key: "maxParagraphsForDrift", type: "int", min: 100, max: 5000, labelKey: "settings.maxParagraphsForDrift" },
      { key: "overlapParagraphs", type: "int", min: 0, max: 10, labelKey: "settings.overlapParagraphs" },
    ],
  },
  {
    id: "judge",
    titleKey: "settings.section.judge",
    mode: "advanced",
    fields: [
      { key: "judgeScoreThreshold", type: "float", min: 0, max: 1, step: 0.05, labelKey: "settings.judgeScoreThreshold" },
      { key: "crossLibDupeThreshold", type: "float", min: 0, max: 1, step: 0.01, labelKey: "settings.crossLibDupeThreshold" },
      { key: "intraDedupThreshold", type: "float", min: 0, max: 1, step: 0.01, labelKey: "settings.intraDedupThreshold" },
    ],
  },
  {
    id: "resilience",
    titleKey: "settings.section.resilience",
    mode: "pro",
    fields: [
      { key: "policyMaxRetries", type: "int", min: 0, max: 20, labelKey: "settings.policyMaxRetries" },
      { key: "policyBaseBackoffMs", type: "int", min: 100, max: 30000, labelKey: "settings.policyBaseBackoffMs" },
      { key: "hardTimeoutCapMs", type: "int", min: 30000, max: 3600000, labelKey: "settings.hardTimeoutCapMs" },
    ],
  },
  {
    id: "forge",
    titleKey: "settings.section.forge",
    mode: "pro",
    fields: [
      { key: "forgeHeartbeatMs", type: "int", min: 60000, max: 7200000, labelKey: "settings.forgeHeartbeatMs" },
      { key: "forgeMaxWallMs", type: "int", min: 3600000, max: 172800000, labelKey: "settings.forgeMaxWallMs" },
      { key: "downloadMaxRetries", type: "int", min: 1, max: 10, labelKey: "settings.downloadMaxRetries" },
      { key: "qdrantTimeoutMs", type: "int", min: 1000, max: 60000, labelKey: "settings.qdrantTimeoutMs" },
    ],
  },
  {
    id: "ui",
    titleKey: "settings.section.ui",
    mode: "simple",
    fields: [
      { key: "refreshIntervalMs", type: "int", min: 2000, max: 60000, labelKey: "settings.refreshIntervalMs" },
      { key: "toastTtlMs", type: "int", min: 1000, max: 30000, labelKey: "settings.toastTtlMs" },
    ],
  },
];

function modeRank(mode) {
  return mode === "pro" ? 2 : mode === "advanced" ? 1 : 0;
}

function buildField(field, root) {
  const value = STATE.prefs[field.key] ?? STATE.defaults[field.key];
  const dflt = STATE.defaults[field.key];
  const isDefault = value === dflt;

  const input = el("input", {
    type: "number",
    class: "settings-input",
    value: String(value),
    min: String(field.min),
    max: String(field.max),
    step: String(field.step || 1),
  });
  input.addEventListener("input", () => {
    const v = field.type === "float" ? parseFloat(input.value) : parseInt(input.value, 10);
    if (!isNaN(v) && v >= field.min && v <= field.max) {
      STATE.prefs[field.key] = v;
      STATE.dirty = true;
      updateSaveBtn(root);
    }
  });

  const resetBtn = el("button", {
    class: "settings-reset-btn",
    type: "button",
    title: `Default: ${dflt}`,
    style: isDefault ? "opacity:0.3" : "",
    onclick: () => {
      STATE.prefs[field.key] = dflt;
      input.value = String(dflt);
      STATE.dirty = true;
      resetBtn.style.opacity = "0.3";
      updateSaveBtn(root);
    },
  }, "\u21BA");

  return el("div", { class: "settings-field" }, [
    el("label", { class: "settings-label" }, [
      el("span", { class: "settings-label-text" }, t(field.labelKey)),
      el("span", { class: "settings-label-range" }, `${field.min} -- ${field.max}`),
    ]),
    el("div", { class: "settings-input-wrap" }, [input, resetBtn]),
  ]);
}

function updateSaveBtn(root) {
  const btn = root.querySelector("#settings-save-btn");
  if (btn) btn.disabled = !STATE.dirty || STATE.saving;
}

async function save(root) {
  if (STATE.saving) return;
  STATE.saving = true;
  updateSaveBtn(root);
  try {
    STATE.prefs = await api().preferences.set(STATE.prefs);
    STATE.dirty = false;
  } catch (e) {
    alert(t("settings.saveFailed") + ": " + (e instanceof Error ? e.message : String(e)));
  } finally {
    STATE.saving = false;
    updateSaveBtn(root);
  }
}

async function resetAll(root) {
  if (!confirm(t("settings.confirmReset"))) return;
  try {
    STATE.prefs = await api().preferences.reset();
    STATE.dirty = false;
    render(root);
  } catch (e) {
    alert(String(e));
  }
}

function render(root) {
  clear(root);
  const currentMode = getMode();
  const currentRank = modeRank(currentMode);

  root.appendChild(buildNeonHero({
    title: t("settings.header.title"),
    subtitle: t("settings.header.sub"),
    pattern: "flower",
  }));
  root.appendChild(neonDivider());

  const actions = el("div", { class: "settings-actions" }, [
    el("button", {
      class: "neon-btn neon-btn-primary",
      id: "settings-save-btn",
      type: "button",
      disabled: "true",
      onclick: () => save(root),
    }, t("settings.save")),
    el("button", {
      class: "neon-btn",
      type: "button",
      onclick: () => resetAll(root),
    }, t("settings.resetAll")),
  ]);
  root.appendChild(actions);

  for (const section of SECTIONS) {
    const sectionRank = modeRank(section.mode);
    if (sectionRank > currentRank) continue;

    const fields = el("div", { class: "settings-fields" });
    for (const f of section.fields) fields.appendChild(buildField(f, root));

    const badge = section.mode !== "simple"
      ? el("span", { class: `settings-mode-badge settings-mode-${section.mode}` }, section.mode.toUpperCase())
      : null;

    const header = el("div", { class: "settings-section-header" }, [
      el("span", { class: "neon-heading settings-section-title" }, t(section.titleKey)),
      badge,
    ]);

    root.appendChild(wrapSacredCard([header, fields], "settings-section"));
  }
}

export async function mountSettings(root) {
  if (!root) return;
  if (root.dataset.mounted === "1") return;
  root.dataset.mounted = "1";
  clear(root);

  root.appendChild(el("div", { class: "settings-loading" }, t("settings.loading")));

  try {
    const [prefs, defaults] = await Promise.all([
      api().preferences.getAll(),
      api().preferences.getDefaults(),
    ]);
    STATE.prefs = prefs;
    STATE.defaults = defaults;
    STATE.dirty = false;
  } catch (e) {
    clear(root);
    root.appendChild(el("div", { class: "settings-error" }, t("settings.loadFailed") + ": " + String(e)));
    return;
  }

  render(root);
}
