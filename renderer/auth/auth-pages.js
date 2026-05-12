// @ts-check

/**
 * Login + register pages для web-режима.
 *
 * Electron-режим (preload.ts) не выставляет window.api.auth — там
 * single-user без login. Router определяет режим по наличию
 * api.auth.me и в Electron просто пропускает auth gate.
 */

import { clear, el } from "../dom.js";

/** @returns {any} */
function api() {
  return /** @type {any} */ (window).api;
}

const STATE = {
  /** @type {"login" | "register"} */
  mode: "login",
  busy: false,
  error: "",
  /** @type {HTMLElement | null} */
  root: null,
  /** @type {((user: any) => void) | null} */
  onSuccess: null,
};

/**
 * Mount auth UI. Resolves when user authenticated (returns UserInfo).
 *
 * @param {HTMLElement} root
 * @returns {Promise<{sub: string, email: string, role: "user"|"admin"}>}
 */
export function mountAuthPage(root) {
  return new Promise((resolve) => {
    STATE.root = root;
    STATE.onSuccess = (u) => {
      STATE.root = null;
      STATE.onSuccess = null;
      resolve(u);
    };
    render();
  });
}

function render() {
  if (!STATE.root) return;
  clear(STATE.root);
  STATE.root.appendChild(buildCard());
}

function buildCard() {
  const card = el("div", { class: "auth-card" });

  card.appendChild(el("h1", { class: "auth-title" }, "Bibliary"));
  card.appendChild(
    el(
      "p",
      { class: "auth-subtitle" },
      STATE.mode === "login" ? "Войдите в свой аккаунт" : "Создайте новый аккаунт",
    ),
  );

  const form = el("form", {
    class: "auth-form",
    onsubmit: (e) => {
      e.preventDefault();
      void submit(/** @type {HTMLFormElement} */ (e.currentTarget));
    },
  });

  if (STATE.mode === "register") {
    form.appendChild(buildField("name", "Имя", "text", "Иван Петров", false));
  }
  form.appendChild(buildField("email", "Email", "email", "you@example.com", true));
  form.appendChild(
    buildField("password", "Пароль", "password", "минимум 8 символов", true),
  );

  const submitBtn = el(
    "button",
    {
      type: "submit",
      class: "auth-submit",
      disabled: STATE.busy ? "true" : null,
    },
    STATE.busy
      ? "Подождите…"
      : STATE.mode === "login"
        ? "Войти"
        : "Зарегистрироваться",
  );
  form.appendChild(submitBtn);

  if (STATE.error) {
    form.appendChild(el("p", { class: "auth-error" }, STATE.error));
  }

  card.appendChild(form);

  const toggle = el(
    "p",
    { class: "auth-toggle" },
    STATE.mode === "login" ? "Нет аккаунта? " : "Уже есть аккаунт? ",
  );
  toggle.appendChild(
    el(
      "a",
      {
        href: "#",
        onclick: (e) => {
          e.preventDefault();
          STATE.mode = STATE.mode === "login" ? "register" : "login";
          STATE.error = "";
          render();
        },
      },
      STATE.mode === "login" ? "Зарегистрироваться" : "Войти",
    ),
  );
  card.appendChild(toggle);

  return card;
}

/**
 * @param {string} name
 * @param {string} label
 * @param {string} type
 * @param {string} placeholder
 * @param {boolean} required
 */
function buildField(name, label, type, placeholder, required) {
  const wrap = el("label", { class: "auth-field" });
  wrap.appendChild(el("span", { class: "auth-field-label" }, label));
  wrap.appendChild(
    el(
      "input",
      Object.assign(
        {
          type,
          name,
          class: "auth-field-input",
          placeholder,
          autocomplete: type === "password" ? "current-password" : type,
        },
        required ? { required: "true" } : {},
      ),
    ),
  );
  return wrap;
}

/** @param {HTMLFormElement} form */
async function submit(form) {
  if (STATE.busy || !STATE.onSuccess) return;
  const fd = new FormData(form);
  const email = String(fd.get("email") ?? "").trim();
  const password = String(fd.get("password") ?? "");
  const name = String(fd.get("name") ?? "").trim();
  if (!email || password.length < 8) {
    STATE.error = "Email и пароль (≥8 символов) обязательны.";
    render();
    return;
  }
  STATE.busy = true;
  STATE.error = "";
  render();
  try {
    /** @type {any} */ let user;
    if (STATE.mode === "register") {
      const body = name ? { email, password, name } : { email, password };
      user = await api().auth.register(body);
    } else {
      user = await api().auth.login({ email, password });
    }
    STATE.busy = false;
    STATE.onSuccess(user);
  } catch (err) {
    STATE.busy = false;
    STATE.error = err instanceof Error ? err.message : String(err);
    render();
  }
}
