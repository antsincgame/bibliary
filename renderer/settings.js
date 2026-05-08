// @ts-check
import { el, clear } from "./dom.js";
import { t } from "./i18n.js";
import { buildNeonHero, neonDivider } from "./components/neon-helpers.js";
import { openWelcomeWizard, resetWelcomeWizard } from "./components/welcome-wizard.js";
import { showAlert, showConfirm } from "./components/ui-dialog.js";
import { SECTIONS } from "./settings/sections.js";

/** @returns {any} */
function api() { return /** @type {any} */ (window).api; }

/**
 * Iter 14.1 (2026-05-04): настройки сильно упрощены.
 * Только базовые URL (LM Studio + vectordb) — остальное живёт в Zod-дефолтах
 * (electron/lib/preferences/store.ts) и работает «из коробки».
 */

const STATE = {
  /** @type {Record<string, unknown>} */
  prefs: {},
  /** @type {Record<string, unknown>} */
  defaults: {},
  dirty: false,
  saving: false,
};

function optionalT(key) {
  const value = t(key);
  return value === key ? "" : value;
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
    updateSaveUi(root);
  });
  return btn;
}

function wrapFieldCard(field, controls, hint) {
  const description = optionalT(`settings.field.${field.key}.desc`);
  return el("div", { class: "settings-field-card" }, [
    el("div", { class: "settings-field-top" }, [
      el("div", { class: "settings-field-title" }, t(field.labelKey)),
      hint ? el("div", { class: "settings-field-range" }, hint) : null,
    ].filter(Boolean)),
    description ? el("div", { class: "settings-field-desc" }, description) : null,
    el("div", { class: "settings-field-control" }, controls),
  ].filter(Boolean));
}

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
    const next = String(input.value).trim();
    if (!next) {
      status.textContent = t("settings.url.empty");
      status.className = "settings-url-status settings-url-status-info";
      return true;
    }
    try {
      new URL(next);
      if (next.endsWith("/")) {
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
    updateSaveUi(root);
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
      const ok = await probeEndpoint(field.probe, String(input.value).trim());
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
  return wrapFieldCard(field, [input, testBtn, resetBtn, status], t("settings.url.hint"));
}

function buildBoolField(field, root) {
  const value = STATE.prefs[field.key] === true;
  const dflt = STATE.defaults[field.key] === true;
  const checkbox = el("input", {
    type: "checkbox",
    class: "settings-checkbox",
    ...(value ? { checked: "checked" } : {}),
  });
  /** @type {HTMLInputElement} */(checkbox).checked = value;
  checkbox.addEventListener("change", () => {
    STATE.prefs[field.key] = /** @type {HTMLInputElement} */(checkbox).checked;
    STATE.dirty = true;
    updateSaveUi(root);
  });
  const resetBtn = buildResetBtn(field.key, dflt, () => {
    /** @type {HTMLInputElement} */(checkbox).checked = STATE.defaults[field.key] === true;
  }, value === dflt, root);
  return wrapFieldCard(field, [checkbox, resetBtn], "");
}

function buildNumberField(field, root) {
  const isInt = field.type === "int";
  const dflt = STATE.defaults[field.key];
  const value = STATE.prefs[field.key] ?? dflt;
  const input = el("input", {
    type: "number",
    class: "settings-input",
    value: String(value),
    ...(field.min !== undefined ? { min: String(field.min) } : {}),
    ...(field.max !== undefined ? { max: String(field.max) } : {}),
    ...(field.step !== undefined ? { step: String(field.step) } : {}),
  });
  input.addEventListener("input", () => {
    const raw = /** @type {HTMLInputElement} */(input).value;
    const parsed = isInt ? parseInt(raw, 10) : parseFloat(raw);
    if (Number.isFinite(parsed)) {
      STATE.prefs[field.key] = parsed;
      STATE.dirty = true;
      updateSaveUi(root);
    }
  });
  const resetBtn = buildResetBtn(field.key, dflt, () => {
    /** @type {HTMLInputElement} */(input).value = String(dflt);
  }, value === dflt, root);
  const range = field.min !== undefined && field.max !== undefined
    ? `${field.min} … ${field.max}` : "";
  return wrapFieldCard(field, [input, resetBtn], range);
}

function buildField(field, root) {
  if (field.type === "url") return buildUrlField(field, root);
  if (field.type === "bool") return buildBoolField(field, root);
  if (field.type === "int" || field.type === "float") return buildNumberField(field, root);
  throw new Error(`[settings] unexpected field type for "${field.key}": ${field.type}`);
}

async function probeEndpoint(kind, baseUrl) {
  const path = kind === "lmstudio" ? "/v1/models" : "/api/v1/heartbeat";
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

function updateSaveUi(root) {
  const saveBtn = root.querySelector("#settings-save-btn");
  if (saveBtn) saveBtn.disabled = !STATE.dirty || STATE.saving;
  const dirtyCount = root.querySelector("#settings-unsaved-count");
  if (dirtyCount) {
    const changedKeys = Object.keys(STATE.prefs).filter((key) => STATE.prefs[key] !== STATE.defaults[key]).length;
    dirtyCount.textContent = t("settings.unsaved", { n: changedKeys });
  }
}

async function save(root) {
  if (STATE.saving) return;
  STATE.saving = true;
  updateSaveUi(root);
  try {
    STATE.prefs = await api().preferences.set(STATE.prefs);
    STATE.dirty = false;
  } catch (e) {
    await showAlert(t("settings.saveFailed") + ": " + (e instanceof Error ? e.message : String(e)));
  } finally {
    STATE.saving = false;
    updateSaveUi(root);
  }
}

async function resetAll(root) {
  if (!(await showConfirm(t("settings.confirmReset")))) return;
  try {
    STATE.prefs = await api().preferences.reset();
    STATE.dirty = false;
    render(root);
  } catch (e) {
    await showAlert(String(e));
  }
}

function buildFieldsStack(root, fields) {
  const stack = el("div", { class: "settings-fields-stack" });
  for (const field of fields) {
    try {
      stack.appendChild(buildField(field, root));
    } catch (e) {
      console.error(`[settings] buildField failed for "${field.key}"`, e);
      stack.appendChild(el("div", { class: "settings-field-card settings-field-error" },
        `\u26A0 ${field.key}: ${e instanceof Error ? e.message : String(e)}`));
    }
  }
  if (!fields.length) {
    stack.appendChild(el("div", { class: "settings-field-card settings-field-empty" }, t("settings.search.noMatches")));
  }
  return stack;
}

function renderPanelContent(root) {
  /* Один общий контейнер, секции рендерятся последовательно.
     `panel-solo` оставлен на первой секции для backward-compat стилей. */
  const container = el("div", { class: "settings-panels-stack" });
  for (let i = 0; i < SECTIONS.length; i++) {
    const section = SECTIONS[i];
    const panel = el("section", {
      class: i === 0 ? "settings-panel settings-panel-solo" : "settings-panel",
    });
    panel.appendChild(el("div", { class: "settings-panel-header" }, [
      el("h2", { class: "settings-panel-title" }, t(section.titleKey)),
      el("p", { class: "settings-panel-subtitle" }, optionalT(section.descriptionKey)),
    ]));
    panel.appendChild(buildFieldsStack(root, section.fields));
    container.appendChild(panel);
  }
  return container;
}

function render(root) {
  clear(root);

  root.appendChild(buildNeonHero({
    title: t("settings.header.title"),
    subtitle: t("settings.header.sub"),
    pattern: "flower",
  }));
  root.appendChild(neonDivider());

  root.appendChild(renderPanelContent(root));

  const actions = el("div", { class: "settings-actions" }, [
    el("span", { id: "settings-unsaved-count", class: "settings-unsaved-count" }, ""),
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
    buildBurnLibraryBtn(),
  ]);
  root.appendChild(actions);
  updateSaveUi(root);
}

/**
 * Кнопка «Сжечь библиотеку» — destructive операция (удаляет ВСЁ под
 * data/library/, bibliary-cache.db и vectordb коллекции bibliary-*).
 * Защищена двойным confirm.
 */
function buildBurnLibraryBtn() {
  const btn = el("button", {
    class: "neon-btn neon-btn-danger",
    type: "button",
    title: t("settings.burnLibrary.tooltip"),
  }, t("settings.burnLibrary"));
  btn.addEventListener("click", async () => {
    if (!(await showConfirm(t("settings.burnLibrary.confirm1"), {
      title: t("settings.burnLibrary"),
      okText: t("settings.burnLibrary.proceed"),
      okVariant: "danger",
    }))) return;
    if (!(await showConfirm(t("settings.burnLibrary.confirm2"), {
      title: t("settings.burnLibrary"),
      okText: t("settings.burnLibrary.proceed"),
      okVariant: "danger",
    }))) return;
    btn.disabled = true;
    const originalLabel = btn.textContent;
    btn.textContent = t("settings.burnLibrary.running");
    try {
      const r = await api().library.burnAll();
      if (!r?.ok) {
        await showAlert(t("settings.burnLibrary.failed") + ": " + (r?.reason || "unknown"));
        return;
      }
      const summary = t("settings.burnLibrary.done", {
        files: String(r.removedFiles ?? 0),
        dirs: String(r.removedDirs ?? 0),
        chroma: String(r.vectorCollectionsCleaned ?? 0),
      });
      const errs = Array.isArray(r.vectorCollectionsErrors) && r.vectorCollectionsErrors.length > 0
        ? "\n\nVectorDB warnings:\n" + r.vectorCollectionsErrors.slice(0, 5).join("\n")
        : "";
      await showAlert(summary + errs);
    } catch (e) {
      await showAlert(t("settings.burnLibrary.failed") + ": " + (e instanceof Error ? e.message : String(e)));
    } finally {
      btn.disabled = false;
      btn.textContent = originalLabel || t("settings.burnLibrary");
    }
  });
  return btn;
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
    delete root.dataset.mounted;
    root.appendChild(el("div", { class: "settings-error" }, t("settings.loadFailed") + ": " + String(e)));
    return;
  }
  render(root);
}
