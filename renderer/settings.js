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
import { openWelcomeWizard, resetWelcomeWizard } from "./components/welcome-wizard.js";

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
      { key: "lockRetries", type: "int", min: 0, max: 20, labelKey: "settings.lockRetries" },
      { key: "lockStaleMs", type: "int", min: 1000, max: 60000, labelKey: "settings.lockStaleMs" },
      { key: "healthPollIntervalMs", type: "int", min: 1000, max: 60000, labelKey: "settings.healthPollIntervalMs" },
      { key: "healthFailThreshold", type: "int", min: 1, max: 20, labelKey: "settings.healthFailThreshold" },
      { key: "watchdogLivenessTimeoutMs", type: "int", min: 500, max: 15000, labelKey: "settings.watchdogLivenessTimeoutMs" },
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
      { key: "spinDurationMs", type: "int", min: 100, max: 3000, labelKey: "settings.spinDurationMs" },
      { key: "resilienceBarHideDelayMs", type: "int", min: 1000, max: 30000, labelKey: "settings.resilienceBarHideDelayMs" },
    ],
  },
  {
    id: "ocr",
    titleKey: "settings.section.ocr",
    mode: "simple",
    fields: [
      { key: "ocrEnabled", type: "bool", labelKey: "settings.ocrEnabled" },
      { key: "ocrAccuracy", type: "enum", options: ["fast", "accurate"], labelKey: "settings.ocrAccuracy" },
      { key: "ocrLanguages", type: "tags", labelKey: "settings.ocrLanguages", placeholder: "en, ru, fr" },
      { key: "ocrPdfDpi", type: "int", min: 100, max: 400, labelKey: "settings.ocrPdfDpi" },
    ],
  },
  {
    id: "connectivity",
    titleKey: "settings.section.connectivity",
    mode: "simple",
    fields: [
      { key: "lmStudioUrl", type: "url", labelKey: "settings.lmStudioUrl", placeholder: "http://localhost:1234", probe: "lmstudio" },
      { key: "qdrantUrl", type: "url", labelKey: "settings.qdrantUrl", placeholder: "http://localhost:6333", probe: "qdrant" },
    ],
  },
];

function modeRank(mode) {
  return mode === "pro" ? 2 : mode === "advanced" ? 1 : 0;
}

function buildNumberField(field, root) {
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

  const resetBtn = buildResetBtn(field.key, dflt, () => { input.value = String(dflt); }, isDefault, root);
  return wrapField(field, [input, resetBtn], `${field.min} -- ${field.max}`);
}

function buildBoolField(field, root) {
  const value = Boolean(STATE.prefs[field.key] ?? STATE.defaults[field.key]);
  const dflt = STATE.defaults[field.key];
  const cb = el("input", { type: "checkbox", class: "settings-input settings-input-bool" });
  if (value) cb.checked = true;
  cb.addEventListener("change", () => {
    STATE.prefs[field.key] = cb.checked;
    STATE.dirty = true;
    updateSaveBtn(root);
  });
  const resetBtn = buildResetBtn(field.key, dflt, () => { cb.checked = Boolean(dflt); }, value === dflt, root);
  return wrapField(field, [cb, resetBtn], "");
}

function buildEnumField(field, root) {
  const value = String(STATE.prefs[field.key] ?? STATE.defaults[field.key]);
  const dflt = STATE.defaults[field.key];
  const sel = el("select", { class: "settings-input settings-input-select" });
  for (const opt of field.options) {
    const o = el("option", { value: opt }, opt);
    if (opt === value) o.selected = true;
    sel.appendChild(o);
  }
  sel.addEventListener("change", () => {
    STATE.prefs[field.key] = sel.value;
    STATE.dirty = true;
    updateSaveBtn(root);
  });
  const resetBtn = buildResetBtn(field.key, dflt, () => { sel.value = String(dflt); }, value === dflt, root);
  return wrapField(field, [sel, resetBtn], field.options.join(" / "));
}

function buildTagsField(field, root) {
  const arr = Array.isArray(STATE.prefs[field.key]) ? STATE.prefs[field.key] : (STATE.defaults[field.key] || []);
  const dflt = STATE.defaults[field.key] || [];
  const input = el("input", {
    type: "text",
    class: "settings-input",
    value: arr.join(", "),
    placeholder: field.placeholder || "tag1, tag2",
  });
  input.addEventListener("input", () => {
    const next = String(input.value)
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && s.length <= 10);
    STATE.prefs[field.key] = next;
    STATE.dirty = true;
    updateSaveBtn(root);
  });
  const resetBtn = buildResetBtn(field.key, dflt, () => { input.value = (dflt || []).join(", "); }, arr.join(",") === (dflt || []).join(","), root);
  return wrapField(field, [input, resetBtn], t("settings.tags.hint"));
}

function buildResetBtn(key, dflt, applyToInput, isDefault, root) {
  const btn = el("button", {
    class: "settings-reset-btn",
    type: "button",
    title: `Default: ${Array.isArray(dflt) ? dflt.join(", ") : dflt}`,
    style: isDefault ? "opacity:0.3" : "",
  }, "\u21BA");
  btn.addEventListener("click", () => {
    STATE.prefs[key] = Array.isArray(dflt) ? [...dflt] : dflt;
    applyToInput();
    STATE.dirty = true;
    btn.style.opacity = "0.3";
    updateSaveBtn(root);
  });
  return btn;
}

function wrapField(field, inputs, hint) {
  return el("div", { class: "settings-field" }, [
    el("label", { class: "settings-label" }, [
      el("span", { class: "settings-label-text" }, t(field.labelKey)),
      hint ? el("span", { class: "settings-label-range" }, hint) : null,
    ].filter(Boolean)),
    el("div", { class: "settings-input-wrap" }, inputs),
  ]);
}

function buildField(field, root) {
  if (field.type === "bool") return buildBoolField(field, root);
  if (field.type === "enum") return buildEnumField(field, root);
  if (field.type === "tags") return buildTagsField(field, root);
  if (field.type === "url") return buildUrlField(field, root);
  return buildNumberField(field, root);
}

/**
 * URL input with Test button. Empty value = "use env var or default".
 * Test button calls api.system.envSummary() after a quick save to a
 * scratch in-memory buffer + a real probe to the entered endpoint.
 */
function buildUrlField(field, root) {
  const value = String(STATE.prefs[field.key] ?? STATE.defaults[field.key] ?? "");
  const dflt = STATE.defaults[field.key] ?? "";
  const input = el("input", {
    type: "url",
    class: "settings-input",
    value,
    placeholder: field.placeholder || "https://...",
    spellcheck: "false",
    autocomplete: "off",
  });
  const status = el("span", { class: "settings-url-status" }, "");
  let validateTimer = null;
  function validate() {
    const v = String(input.value).trim();
    if (v === "") {
      status.textContent = t("settings.url.empty");
      status.className = "settings-url-status settings-url-status-info";
      return true;
    }
    try {
      // eslint-disable-next-line no-new
      new URL(v);
      if (v.endsWith("/")) {
        status.textContent = t("settings.url.noTrailingSlash");
        status.className = "settings-url-status settings-url-status-error";
        return false;
      }
      status.textContent = "";
      status.className = "settings-url-status";
      return true;
    } catch {
      status.textContent = t("settings.url.invalid");
      status.className = "settings-url-status settings-url-status-error";
      return false;
    }
  }
  input.addEventListener("input", () => {
    STATE.prefs[field.key] = String(input.value).trim();
    STATE.dirty = true;
    updateSaveBtn(root);
    if (validateTimer) clearTimeout(validateTimer);
    validateTimer = setTimeout(validate, 200);
  });

  const testBtn = el("button", {
    class: "settings-test-btn",
    type: "button",
    title: t("settings.url.test.tooltip"),
  }, t("settings.url.test"));
  testBtn.addEventListener("click", async () => {
    if (!validate()) return;
    testBtn.disabled = true;
    status.textContent = t("settings.url.testing");
    status.className = "settings-url-status settings-url-status-info";
    try {
      const probeUrl = String(input.value).trim();
      const ok = await probeEndpoint(field.probe, probeUrl);
      if (ok) {
        status.textContent = t("settings.url.ok");
        status.className = "settings-url-status settings-url-status-ok";
      } else {
        status.textContent = t("settings.url.unreachable");
        status.className = "settings-url-status settings-url-status-error";
      }
    } catch (e) {
      status.textContent = t("settings.url.error") + ": " + (e instanceof Error ? e.message : String(e));
      status.className = "settings-url-status settings-url-status-error";
    } finally {
      testBtn.disabled = false;
    }
  });

  const resetBtn = buildResetBtn(field.key, dflt, () => { input.value = String(dflt); validate(); }, value === dflt, root);
  return el("div", { class: "settings-field settings-field-url" }, [
    el("label", { class: "settings-label" }, [
      el("span", { class: "settings-label-text" }, t(field.labelKey)),
      el("span", { class: "settings-label-range" }, t("settings.url.hint")),
    ]),
    el("div", { class: "settings-input-wrap" }, [input, testBtn, resetBtn]),
    status,
  ]);
}

/**
 * Probe the entered endpoint by hitting a known harmless GET endpoint.
 * - lmstudio: GET /v1/models (returns 200 if running)
 * - qdrant:   GET /collections (returns 200 if running)
 *
 * Note: this fires from the renderer using window.fetch. Most local
 * Bibliary setups have CORS open or are localhost (no preflight).
 * Failures show a generic "unreachable" -- user has to read DevTools
 * for details. That's fine for an MVP probe; server-side probe via IPC
 * is a follow-up if users hit CORS in the wild.
 */
async function probeEndpoint(kind, baseUrl) {
  const path = kind === "lmstudio" ? "/v1/models" : "/collections";
  const url = baseUrl.replace(/\/+$/, "") + path;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 5000);
  try {
    const resp = await fetch(url, { signal: ctl.signal });
    return resp.ok;
  } finally {
    clearTimeout(timer);
  }
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
    el("button", {
      class: "neon-btn",
      type: "button",
      title: t("settings.replayOnboarding.tooltip"),
      onclick: async () => {
        await resetWelcomeWizard();
        openWelcomeWizard({ force: true });
      },
    }, t("settings.replayOnboarding")),
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
