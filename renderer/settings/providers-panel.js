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

const STATE = {
  /** @type {Array<{providerId: string, configured: boolean, hint?: string}>} */
  providers: [],
  /** @type {Record<string, {state: "idle"|"working"|"ok"|"error", message?: string}>} */
  status: {},
  /** @type {Record<string, string>} */
  drafts: {},
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

  await loadProviders();
  renderProviders(list);
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
