// @ts-check
import { el, clear } from "./dom.js";
import { t } from "./i18n.js";
import { buildNeonHero, neonDivider } from "./components/neon-helpers.js";
import { openWelcomeWizard, resetWelcomeWizard } from "./components/welcome-wizard.js";
import { showAlert, showConfirm } from "./components/ui-dialog.js";
import { SECTIONS } from "./settings/sections.js";

/** @returns {any} */
function api() { return /** @type {any} */ (window).api; }

const STATE = {
  /** @type {Record<string, unknown>} */
  prefs: {},
  /** @type {Record<string, unknown>} */
  defaults: {},
  dirty: false,
  saving: false,
  activeSectionId: "ingest",
  searchQuery: "",
};

function optionalT(key) {
  const value = t(key);
  return value === key ? "" : value;
}

function getVisibleSections() {
  return [...SECTIONS];
}

function filteredFields(section) {
  const query = STATE.searchQuery.trim().toLowerCase();
  if (!query) return section.fields;
  return section.fields.filter((field) => t(field.labelKey).toLowerCase().includes(query));
}

function getMatchesBySection(visibleSections) {
  return visibleSections
    .map((section) => ({ section, fields: filteredFields(section) }))
    .filter((entry) => entry.fields.length > 0);
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
    const next = field.type === "float" ? parseFloat(input.value) : parseInt(input.value, 10);
    if (!isNaN(next) && next >= field.min && next <= field.max) {
      STATE.prefs[field.key] = next;
      STATE.dirty = true;
      updateSaveUi(root);
    }
  });
  const resetBtn = buildResetBtn(field.key, dflt, () => { input.value = String(dflt); }, isDefault, root);
  return wrapFieldCard(field, [input, resetBtn], `${field.min} -- ${field.max}`);
}

function buildBoolField(field, root) {
  const value = Boolean(STATE.prefs[field.key] ?? STATE.defaults[field.key]);
  const dflt = STATE.defaults[field.key];
  const cb = el("input", { type: "checkbox", class: "settings-input settings-input-bool" });
  cb.checked = value;
  cb.addEventListener("change", () => {
    STATE.prefs[field.key] = cb.checked;
    STATE.dirty = true;
    updateSaveUi(root);
  });
  const resetBtn = buildResetBtn(field.key, dflt, () => { cb.checked = Boolean(dflt); }, value === dflt, root);
  return wrapFieldCard(field, [cb, resetBtn], "");
}

function buildEnumField(field, root) {
  const value = String(STATE.prefs[field.key] ?? STATE.defaults[field.key]);
  const dflt = STATE.defaults[field.key];
  const select = el("select", { class: "settings-input settings-input-select" });
  for (const option of field.options || []) {
    const opt = el("option", { value: option }, option);
    if (option === value) opt.selected = true;
    select.appendChild(opt);
  }
  select.addEventListener("change", () => {
    STATE.prefs[field.key] = select.value;
    STATE.dirty = true;
    updateSaveUi(root);
  });
  const resetBtn = buildResetBtn(field.key, dflt, () => { select.value = String(dflt); }, value === dflt, root);
  return wrapFieldCard(field, [select, resetBtn], (field.options || []).join(" / "));
}

function buildTagsField(field, root) {
  const value = Array.isArray(STATE.prefs[field.key]) ? STATE.prefs[field.key] : (STATE.defaults[field.key] || []);
  const dflt = STATE.defaults[field.key] || [];
  const input = el("input", {
    type: "text",
    class: "settings-input",
    value: value.join(", "),
    placeholder: field.placeholder || "en, ru",
  });
  input.addEventListener("input", () => {
    const next = String(input.value)
      .split(/[,\s]+/)
      .map((part) => part.trim())
      .filter((part) => part.length > 0 && part.length <= 10);
    STATE.prefs[field.key] = next;
    STATE.dirty = true;
    updateSaveUi(root);
  });
  const resetBtn = buildResetBtn(
    field.key,
    dflt,
    () => { input.value = (dflt || []).join(", "); },
    value.join(",") === (dflt || []).join(","),
    root,
  );
  return wrapFieldCard(field, [input, resetBtn], t("settings.tags.hint"));
}

function buildPasswordField(field, root) {
  const value = String(STATE.prefs[field.key] ?? STATE.defaults[field.key] ?? "");
  const dflt = String(STATE.defaults[field.key] ?? "");
  const input = el("input", {
    type: "password",
    class: "settings-input",
    value,
    placeholder: field.placeholder || "",
    autocomplete: "off",
    spellcheck: "false",
  });
  input.addEventListener("input", () => {
    STATE.prefs[field.key] = String(input.value);
    STATE.dirty = true;
    updateSaveUi(root);
  });
  const resetBtn = buildResetBtn(field.key, dflt, () => { input.value = dflt; }, value === dflt, root);
  return wrapFieldCard(field, [input, resetBtn], t("settings.password.hint"));
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

function buildTextField(field, root) {
  const value = String(STATE.prefs[field.key] ?? STATE.defaults[field.key] ?? "");
  const dflt = String(STATE.defaults[field.key] ?? "");
  const input = el("input", {
    type: "text",
    class: "settings-input",
    value,
    placeholder: field.placeholder || "",
    spellcheck: "false",
    autocomplete: "off",
  });
  input.addEventListener("input", () => {
    STATE.prefs[field.key] = String(input.value);
    STATE.dirty = true;
    updateSaveUi(root);
  });
  const resetBtn = buildResetBtn(field.key, dflt, () => { input.value = dflt; }, value === dflt, root);
  return wrapFieldCard(field, [input, resetBtn], "");
}

function buildField(field, root) {
  if (field.type === "bool") return buildBoolField(field, root);
  if (field.type === "enum") return buildEnumField(field, root);
  if (field.type === "tags") return buildTagsField(field, root);
  if (field.type === "password") return buildPasswordField(field, root);
  if (field.type === "url") return buildUrlField(field, root);
  if (field.type === "text") return buildTextField(field, root);
  return buildNumberField(field, root);
}

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

function buildFieldsStack(root, section, fields) {
  const stack = el("div", { class: "settings-fields-stack" });
  for (const field of fields) {
    try {
      stack.appendChild(buildField(field, root));
    } catch (e) {
      console.error(`[settings] buildField failed for "${field.key}"`, e);
      stack.appendChild(el("div", { class: "settings-field-card settings-field-error" },
        `⚠ ${field.key}: ${e instanceof Error ? e.message : String(e)}`));
    }
  }
  if (!fields.length) {
    stack.appendChild(el("div", { class: "settings-field-card settings-field-empty" }, t("settings.search.noMatches")));
  }
  return stack;
}

function renderPanelContent(root, visibleSections) {
  const panel = el("section", { class: "settings-panel" });
  const query = STATE.searchQuery.trim();
  if (query) {
    const groups = getMatchesBySection(visibleSections);
    panel.appendChild(el("div", { class: "settings-panel-header" }, [
      el("h2", { class: "settings-panel-title" }, t("settings.search.results")),
      el("p", { class: "settings-panel-subtitle" }, `"${query}"`),
    ]));
    for (const { section, fields } of groups) {
      panel.appendChild(el("div", { class: "settings-group-title" }, t(section.titleKey)));
      panel.appendChild(buildFieldsStack(root, section, fields));
    }
    if (!groups.length) {
      panel.appendChild(buildFieldsStack(root, { id: "none" }, []));
    }
    return panel;
  }

  const current = visibleSections.find((section) => section.id === STATE.activeSectionId) || visibleSections[0];
  if (!current) return panel;
  STATE.activeSectionId = current.id;
  panel.appendChild(el("div", { class: "settings-panel-header" }, [
    el("h2", { class: "settings-panel-title" }, t(current.titleKey)),
    el("p", { class: "settings-panel-subtitle" }, optionalT(current.descriptionKey)),
  ]));
  panel.appendChild(buildFieldsStack(root, current, current.fields));
  return panel;
}

function render(root) {
  clear(root);
  const visibleSections = getVisibleSections();
  if (!visibleSections.some((section) => section.id === STATE.activeSectionId)) {
    STATE.activeSectionId = visibleSections[0]?.id || "";
  }

  root.appendChild(buildNeonHero({
    title: t("settings.header.title"),
    subtitle: t("settings.header.sub"),
    pattern: "flower",
  }));
  root.appendChild(neonDivider());

  const search = el("div", { class: "settings-search" }, [
    el("input", {
      class: "settings-search-input",
      type: "search",
      value: STATE.searchQuery,
      placeholder: t("settings.search.placeholder"),
      oninput: (event) => {
        STATE.searchQuery = /** @type {HTMLInputElement} */ (event.currentTarget).value;
        render(root);
      },
    }),
  ]);
  root.appendChild(search);

  const shell = el("div", { class: "settings-shell" });
  const rail = el("nav", { class: "settings-rail", "aria-label": "Settings sections" });
  for (const section of visibleSections) {
    const matches = filteredFields(section).length;
    const isActive = !STATE.searchQuery && section.id === STATE.activeSectionId;
    const item = el("button", {
      class: `settings-rail-item${isActive ? " settings-rail-item-active" : ""}`,
      type: "button",
      "aria-current": isActive ? "page" : undefined,
      onclick: () => {
        STATE.activeSectionId = section.id;
        STATE.searchQuery = "";
        render(root);
      },
    }, [
      el("span", { class: "settings-rail-icon" }, section.icon),
      el("span", { class: "settings-rail-label" }, t(section.titleKey)),
      STATE.searchQuery ? el("span", { class: "settings-rail-count" }, String(matches)) : null,
    ].filter(Boolean));
    rail.appendChild(item);
  }
  shell.appendChild(rail);
  shell.appendChild(renderPanelContent(root, visibleSections));
  root.appendChild(shell);

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
  ]);
  root.appendChild(actions);
  updateSaveUi(root);
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
