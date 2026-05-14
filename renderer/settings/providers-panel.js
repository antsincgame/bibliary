// @ts-check

/**
 * Settings → Providers panel.
 *
 * UI:
 *   - Список 3 провайдеров (lmstudio / anthropic / openai)
 *   - lmstudio показан read-only (global admin URL)
 *   - anthropic / openai — поле API key (password) + кнопки Save / Test / Clear
 *   - На «configured» badge показываем hint "sk-...c7d8"
 *
 * Backend: window.api.llm.{listProviders, setSecret, clearSecret, test}.
 */

import { clear, el } from "../dom.js";

/** @returns {any} */
function api() {
  return /** @type {any} */ (window).api;
}

/* Only the two roles the server actually resolves (see server's
 * LLMRole type). The legacy Electron build had vision_*/translator/
 * lang_detector/ukrainian_specialist — re-add a role here only when
 * the server grows a real resolver call site for it, otherwise the
 * Settings UI offers an assignment dropdown that does nothing. */
const ROLES = /** @type {const} */ ([
  "crystallizer",
  "evaluator",
]);

const ROLE_LABEL = {
  crystallizer: "Crystallizer (извлечение знаний)",
  evaluator: "Evaluator (оценка качества)",
};

const STATE = {
  /** @type {Array<{providerId: string, configured: boolean, hint?: string}>} */
  providers: [],
  /** @type {Record<string, {state: "idle"|"working"|"ok"|"error", message?: string}>} */
  status: {},
  /** @type {Record<string, string>} */
  drafts: {},
  /** @type {Record<string, {provider: string, model: string}>} */
  assignments: {},
  /** @type {Record<string, Array<{modelId: string, displayName?: string}>>} */
  modelsByProvider: {},
  assignmentsSaving: false,
  /** @type {{state: "idle"|"working"|"ok"|"error", message?: string}} */
  assignmentsStatus: { state: "idle" },
};

/** @param {Element} root */
export async function mountProvidersPanel(root) {
  clear(root);
  root.appendChild(el("h3", { class: "providers-header" }, "LLM Providers"));
  root.appendChild(
    el(
      "p",
      { class: "providers-help" },
      "API ключи хранятся зашифрованными в твоём профиле. " +
        "LM Studio управляется администратором (общий URL).",
    ),
  );

  const list = el("div", { class: "providers-list" });
  root.appendChild(list);

  const assignmentsEl = el("div", { class: "providers-assignments" });
  root.appendChild(assignmentsEl);

  await Promise.all([loadProviders(), loadAssignments()]);
  renderProviders(list);
  void loadAvailableModels().then(() => renderAssignments(assignmentsEl));
  renderAssignments(assignmentsEl);
}

async function loadProviders() {
  try {
    STATE.providers = await api().llm.listProviders();
  } catch (err) {
    console.error("[providers-panel] listProviders failed:", err);
    STATE.providers = [];
  }
}

/** @param {Element} list */
function renderProviders(list) {
  clear(list);
  for (const p of STATE.providers) {
    list.appendChild(renderProviderCard(list, p));
  }
}

/**
 * @param {Element} list
 * @param {{providerId: string, configured: boolean, hint?: string}} p
 */
function renderProviderCard(list, p) {
  const card = el("div", { class: `provider-card provider-${p.providerId}` });

  const head = el("div", { class: "provider-head" });
  head.appendChild(el("strong", null, prettyName(p.providerId)));
  const badge = el(
    "span",
    { class: "provider-badge", "data-configured": String(p.configured) },
    p.providerId === "lmstudio"
      ? "global"
      : p.configured
        ? `configured · ${p.hint ?? ""}`
        : "not configured",
  );
  head.appendChild(badge);
  card.appendChild(head);

  if (p.providerId === "lmstudio") {
    const note = el(
      "p",
      { class: "provider-note" },
      "Управляется через настройку lmStudioUrl выше.",
    );
    card.appendChild(note);
    return card;
  }

  const draft = STATE.drafts[p.providerId] ?? "";
  const input = el("input", {
    type: "password",
    class: "provider-key-input",
    placeholder: p.configured ? "Заменить ключ…" : "Введите API key",
    value: draft,
    oninput: (e) => {
      const value = String(/** @type {HTMLInputElement} */ (e.target).value || "");
      STATE.drafts[p.providerId] = value;
    },
  });
  card.appendChild(input);

  const actions = el("div", { class: "provider-actions" });
  actions.appendChild(
    el(
      "button",
      {
        type: "button",
        class: "btn btn-primary",
        onclick: () =>
          saveSecret(list, p.providerId, /** @type {HTMLInputElement} */ (input)),
      },
      "Сохранить",
    ),
  );
  actions.appendChild(
    el(
      "button",
      {
        type: "button",
        class: "btn",
        onclick: () => testProvider(list, p.providerId),
      },
      "Test connection",
    ),
  );
  if (p.configured) {
    actions.appendChild(
      el(
        "button",
        {
          type: "button",
          class: "btn btn-danger",
          onclick: () => clearSecret(list, p.providerId),
        },
        "Забыть ключ",
      ),
    );
  }
  card.appendChild(actions);

  const status = STATE.status[p.providerId];
  if (status) {
    card.appendChild(
      el(
        "p",
        {
          class: `provider-status provider-status-${status.state}`,
        },
        status.message ?? "",
      ),
    );
  }
  return card;
}

/**
 * @param {Element} list
 * @param {string} providerId
 * @param {HTMLInputElement} input
 */
async function saveSecret(list, providerId, input) {
  const apiKey = (STATE.drafts[providerId] ?? input.value ?? "").trim();
  if (apiKey.length < 8) {
    setStatus(list, providerId, "error", "API key слишком короткий (мин. 8 символов).");
    return;
  }
  setStatus(list, providerId, "working", "Сохраняю…");
  try {
    const result = await api().llm.setSecret(providerId, apiKey);
    delete STATE.drafts[providerId];
    setStatus(list, providerId, "ok", `Сохранено: ${result.hint ?? ""}`);
    await loadProviders();
    renderProviders(list);
  } catch (err) {
    setStatus(list, providerId, "error", err instanceof Error ? err.message : String(err));
  }
}

/** @param {Element} list @param {string} providerId */
async function testProvider(list, providerId) {
  setStatus(list, providerId, "working", "Проверяю соединение…");
  try {
    const result = await api().llm.test(providerId);
    if (result.ok) {
      setStatus(
        list,
        providerId,
        "ok",
        `OK · ${result.modelsCount} моделей · напр. ${(result.sampleModels ?? []).slice(0, 3).join(", ")}`,
      );
    } else {
      setStatus(list, providerId, "error", String(result.error ?? "unknown error"));
    }
  } catch (err) {
    setStatus(list, providerId, "error", err instanceof Error ? err.message : String(err));
  }
}

/** @param {Element} list @param {string} providerId */
async function clearSecret(list, providerId) {
  setStatus(list, providerId, "working", "Удаляю ключ…");
  try {
    await api().llm.clearSecret(providerId);
    delete STATE.drafts[providerId];
    setStatus(list, providerId, "ok", "Ключ удалён.");
    await loadProviders();
    renderProviders(list);
  } catch (err) {
    setStatus(list, providerId, "error", err instanceof Error ? err.message : String(err));
  }
}

/**
 * @param {Element} list
 * @param {string} providerId
 * @param {"idle"|"working"|"ok"|"error"} state
 * @param {string} message
 */
function setStatus(list, providerId, state, message) {
  STATE.status[providerId] = { state, message };
  renderProviders(list);
}

/** @param {string} id */
function prettyName(id) {
  switch (id) {
    case "lmstudio":
      return "LM Studio";
    case "anthropic":
      return "Anthropic (Claude)";
    case "openai":
      return "OpenAI";
    default:
      return id;
  }
}

/* ─── Role assignments ──────────────────────────────────────────── */

async function loadAssignments() {
  try {
    const data = await api().llm.getAssignments();
    STATE.assignments = data && typeof data === "object" ? data : {};
  } catch (err) {
    console.error("[providers-panel] getAssignments failed:", err);
    STATE.assignments = {};
  }
}

/**
 * Fetch model lists from all CONFIGURED providers (включая lmstudio).
 * Не configured cloud провайдеры пропускаются — пустой список.
 */
async function loadAvailableModels() {
  const promises = [];
  for (const p of STATE.providers) {
    if (p.providerId !== "lmstudio" && !p.configured) continue;
    promises.push(
      api().llm
        .listModels(p.providerId)
        .then((models) => {
          STATE.modelsByProvider[p.providerId] = Array.isArray(models) ? models : [];
        })
        .catch((err) => {
          console.warn(`[providers-panel] listModels(${p.providerId}) failed:`, err);
          STATE.modelsByProvider[p.providerId] = [];
        }),
    );
  }
  await Promise.all(promises);
}

/** @param {Element} root */
function renderAssignments(root) {
  clear(root);
  root.appendChild(el("h3", { class: "providers-header" }, "Назначения по ролям"));
  root.appendChild(
    el(
      "p",
      { class: "providers-help" },
      "Каждая роль pipeline отправляется в выбранный провайдер. " +
        "Не выбрано → fallback на LM Studio с первой загруженной моделью.",
    ),
  );

  const grid = el("div", { class: "role-assignments-grid" });
  for (const role of ROLES) {
    grid.appendChild(renderAssignmentRow(role));
  }
  root.appendChild(grid);

  const actions = el("div", { class: "providers-assignments-actions" });
  const saveBtn = el(
    "button",
    {
      type: "button",
      class: "btn btn-primary",
      disabled: STATE.assignmentsSaving ? "true" : null,
      onclick: () => saveAssignments(root),
    },
    STATE.assignmentsSaving ? "Сохраняю…" : "Сохранить назначения",
  );
  actions.appendChild(saveBtn);
  root.appendChild(actions);

  if (STATE.assignmentsStatus.state !== "idle" && STATE.assignmentsStatus.message) {
    root.appendChild(
      el(
        "p",
        {
          class: `provider-status provider-status-${STATE.assignmentsStatus.state}`,
        },
        STATE.assignmentsStatus.message,
      ),
    );
  }
}

/** @param {string} role */
function renderAssignmentRow(role) {
  const row = el("div", { class: "role-assignment-row" });
  row.appendChild(
    el("div", { class: "role-assignment-label" }, ROLE_LABEL[role] ?? role),
  );

  const current = STATE.assignments[role] ?? { provider: "", model: "" };
  const providerSelect = el(
    "select",
    {
      class: "role-assignment-provider",
      onchange: (e) => {
        const v = String(/** @type {HTMLSelectElement} */ (e.target).value || "");
        if (!v) {
          delete STATE.assignments[role];
        } else {
          STATE.assignments[role] = {
            provider: v,
            model: pickDefaultModel(v),
          };
        }
        rerenderAssignments();
      },
    },
    [
      el("option", { value: "" }, "— не назначено —"),
      ...STATE.providers
        .filter((p) => p.providerId === "lmstudio" || p.configured)
        .map((p) =>
          el(
            "option",
            {
              value: p.providerId,
              ...(current.provider === p.providerId ? { selected: "selected" } : {}),
            },
            prettyName(p.providerId),
          ),
        ),
    ],
  );
  row.appendChild(providerSelect);

  const modelsForProvider = STATE.modelsByProvider[current.provider] ?? [];
  const modelSelect = el(
    "select",
    {
      class: "role-assignment-model",
      disabled: !current.provider ? "true" : null,
      onchange: (e) => {
        const v = String(/** @type {HTMLSelectElement} */ (e.target).value || "");
        if (STATE.assignments[role]) STATE.assignments[role].model = v;
      },
    },
    current.provider
      ? modelsForProvider.length > 0
        ? modelsForProvider.map((m) =>
            el(
              "option",
              {
                value: m.modelId,
                ...(current.model === m.modelId ? { selected: "selected" } : {}),
              },
              m.displayName ?? m.modelId,
            ),
          )
        : [el("option", { value: current.model }, current.model || "(загружаю…)")]
      : [el("option", null, "—")],
  );
  row.appendChild(modelSelect);
  return row;
}

/** @param {string} providerId */
function pickDefaultModel(providerId) {
  const list = STATE.modelsByProvider[providerId];
  if (!list || list.length === 0) return "";
  return list[0].modelId;
}

function rerenderAssignments() {
  const root = document.querySelector(".providers-assignments");
  if (root instanceof HTMLElement) renderAssignments(root);
}

/** @param {Element} root */
async function saveAssignments(root) {
  if (STATE.assignmentsSaving) return;
  STATE.assignmentsSaving = true;
  STATE.assignmentsStatus = { state: "working", message: "Сохраняю…" };
  renderAssignments(root);
  try {
    /* Filter out empty rows — backend схема требует provider+model
     * непустыми обоими. */
    /** @type {Record<string, {provider: string, model: string}>} */
    const cleaned = {};
    for (const [role, value] of Object.entries(STATE.assignments)) {
      if (value && value.provider && value.model) cleaned[role] = value;
    }
    await api().llm.setAssignments(cleaned);
    STATE.assignmentsStatus = { state: "ok", message: "Назначения сохранены." };
  } catch (err) {
    STATE.assignmentsStatus = {
      state: "error",
      message: err instanceof Error ? err.message : String(err),
    };
  } finally {
    STATE.assignmentsSaving = false;
    renderAssignments(root);
  }
}
