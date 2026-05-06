// @ts-check
import { el } from "../dom.js";
import { t } from "../i18n.js";

/**
 * @typedef {object} DialogOptions
 * @property {string} [title]
 * @property {string} [okText]
 * @property {string} [cancelText]
 * @property {"default"|"danger"} [okVariant]
 */

/**
 * Non-blocking replacement for browser alert().
 * @param {string} message
 * @param {DialogOptions} [opts]
 * @returns {Promise<void>}
 */
export async function showAlert(message, opts = {}) {
  await showDialog({ kind: "alert", message, ...opts });
}

/**
 * Non-blocking replacement for browser confirm().
 * @param {string} message
 * @param {DialogOptions} [opts]
 * @returns {Promise<boolean>}
 */
export function showConfirm(message, opts = {}) {
  return showDialog({ kind: "confirm", message, ...opts });
}

/**
 * Non-blocking replacement for browser prompt().
 * @param {string} message
 * @param {string} [defaultValue]
 * @param {DialogOptions} [opts]
 * @returns {Promise<string|null>}
 */
export function showPrompt(message, defaultValue = "", opts = {}) {
  return showDialog({ kind: "prompt", message, defaultValue, ...opts });
}

/**
 * @param {{
 *   kind: "alert"|"confirm"|"prompt";
 *   message: string;
 *   defaultValue?: string;
 *   title?: string;
 *   okText?: string;
 *   cancelText?: string;
 * }} config
 * @returns {Promise<any>}
 */
function showDialog(config) {
  return new Promise((resolve) => {
    const overlay = el("div", { class: "ui-dialog-overlay" });
    const dialog = el("div", {
      class: "ui-dialog",
      role: "dialog",
      "aria-modal": "true",
      "aria-label": config.title || "Bibliary",
    });
    if (config.title) {
      dialog.appendChild(el("div", { class: "ui-dialog-title" }, config.title));
    }
    dialog.appendChild(el("div", { class: "ui-dialog-message" }, config.message));

    /** @type {HTMLInputElement | null} */
    let input = null;
    if (config.kind === "prompt") {
      input = /** @type {HTMLInputElement} */ (
        el("input", {
          type: "text",
          class: "ui-dialog-input",
          value: config.defaultValue || "",
        })
      );
      dialog.appendChild(input);
    }

    const actions = el("div", { class: "ui-dialog-actions" });
    const okBtn = /** @type {HTMLButtonElement} */ (
      el("button", {
        class: config.okVariant === "danger" ? "btn-danger" : "btn-primary",
        type: "button",
      }, config.okText || t("dialog.ok"))
    );
    const cancelBtn = /** @type {HTMLButtonElement} */ (
      el("button", { class: "btn-secondary", type: "button" }, config.cancelText || t("dialog.cancel"))
    );

    const close = (value) => {
      overlay.remove();
      resolve(value);
    };

    okBtn.addEventListener("click", () => {
      if (config.kind === "prompt") close(input ? input.value : "");
      else if (config.kind === "confirm") close(true);
      else close(undefined);
    });
    cancelBtn.addEventListener("click", () => {
      if (config.kind === "prompt") close(null);
      else if (config.kind === "confirm") close(false);
      else close(undefined);
    });
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) cancelBtn.click();
    });
    dialog.addEventListener("click", (e) => e.stopPropagation());
    overlay.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        cancelBtn.click();
      }
      if (e.key === "Enter") {
        e.preventDefault();
        okBtn.click();
      }
    });

    if (config.kind === "alert") {
      actions.appendChild(okBtn);
    } else {
      actions.append(cancelBtn, okBtn);
    }
    dialog.appendChild(actions);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    overlay.tabIndex = -1;
    overlay.focus();
    if (input) setTimeout(() => input?.focus(), 0);
    else setTimeout(() => okBtn.focus(), 0);
  });
}
