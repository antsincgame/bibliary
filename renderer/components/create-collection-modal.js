// @ts-check
/**
 * Модальное окно создания новой Qdrant-коллекции.
 *
 * UX задача (Iter 14.1, 2026-05-04): пользователь («бабушка-библиотекарь»)
 * нажимает «+» в селекторе коллекций и получает понятный диалог:
 *  - что такое коллекция (одна-две строки)
 *  - поле имени с превью валидации
 *  - подсказка про допустимые символы
 *  - кнопки [Отмена] [Создать пустую базу]
 *
 * Соответствует Modal rules:
 *  - focus trap внутри окна (первый input получает focus)
 *  - Escape закрывает
 *  - клик по backdrop закрывает
 *  - prevent body scroll пока открыт
 *  - return focus на ранее активный элемент
 */
import { el } from "../dom.js";
import { t } from "../i18n.js";

const NAME_REGEX = /^[a-zA-Z0-9_\-:.]{1,128}$/;

/**
 * @typedef {object} CreateCollectionResult
 * @property {string|null} name  — null если отменено / закрыто
 */

/**
 * @returns {Promise<string|null>} имя новой коллекции или null если отменено
 */
export function showCreateCollectionModal() {
  return new Promise((resolve) => {
    const previouslyFocused = /** @type {HTMLElement|null} */ (document.activeElement);
    const previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const overlay = el("div", {
      class: "qdrant-overlay ui-dialog-overlay create-collection-overlay",
      role: "presentation",
    });
    const dialog = el("div", {
      class: "qdrant-dialog ui-dialog create-collection-dialog",
      role: "dialog",
      "aria-modal": "true",
      "aria-labelledby": "create-collection-title",
      tabindex: "-1",
    });

    const title = el("div", {
      id: "create-collection-title",
      class: "qdrant-dialog-title",
    }, t("library.collection.create.modal.title"));

    const intro = el("p", {
      class: "ui-dialog-message create-collection-intro",
    }, t("library.collection.create.modal.intro"));

    const input = /** @type {HTMLInputElement} */ (el("input", {
      type: "text",
      class: "qdrant-input ui-dialog-input create-collection-input",
      placeholder: t("library.collection.create.modal.placeholder"),
      autocomplete: "off",
      spellcheck: "false",
      "aria-describedby": "create-collection-hint create-collection-status",
    }));

    const hint = el("div", {
      id: "create-collection-hint",
      class: "create-collection-hint",
    }, t("library.collection.create.modal.hint"));

    const status = el("div", {
      id: "create-collection-status",
      class: "create-collection-status",
      role: "status",
      "aria-live": "polite",
    }, "");

    const okBtn = /** @type {HTMLButtonElement} */ (el("button", {
      type: "button",
      class: "btn-primary",
      disabled: "true",
    }, t("library.collection.create.modal.ok")));

    const cancelBtn = /** @type {HTMLButtonElement} */ (el("button", {
      type: "button",
      class: "btn-secondary",
    }, t("library.collection.create.modal.cancel")));

    function close(value) {
      document.body.style.overflow = previousBodyOverflow;
      overlay.remove();
      previouslyFocused?.focus?.();
      resolve(value);
    }

    function validate() {
      const value = input.value.trim();
      if (!value) {
        status.textContent = "";
        status.classList.remove("create-collection-status-error", "create-collection-status-ok");
        okBtn.disabled = true;
        return false;
      }
      if (!NAME_REGEX.test(value)) {
        status.textContent = t("library.collection.create.modal.invalid");
        status.classList.add("create-collection-status-error");
        status.classList.remove("create-collection-status-ok");
        okBtn.disabled = true;
        return false;
      }
      status.textContent = t("library.collection.create.modal.valid");
      status.classList.add("create-collection-status-ok");
      status.classList.remove("create-collection-status-error");
      okBtn.disabled = false;
      return true;
    }

    input.addEventListener("input", validate);
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && !okBtn.disabled) {
        ev.preventDefault();
        close(input.value.trim());
      }
    });

    okBtn.addEventListener("click", () => {
      if (validate()) close(input.value.trim());
    });
    cancelBtn.addEventListener("click", () => close(null));

    overlay.addEventListener("click", (ev) => {
      if (ev.target === overlay) close(null);
    });
    overlay.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") {
        ev.preventDefault();
        close(null);
        return;
      }
      if (ev.key === "Tab") {
        const focusables = [input, okBtn.disabled ? null : okBtn, cancelBtn].filter(Boolean);
        if (focusables.length === 0) return;
        const active = document.activeElement;
        const idx = focusables.indexOf(/** @type {HTMLElement} */ (active));
        const dir = ev.shiftKey ? -1 : 1;
        const next = focusables[(idx + dir + focusables.length) % focusables.length];
        if (next instanceof HTMLElement) {
          ev.preventDefault();
          next.focus();
        }
      }
    });

    const actions = el("div", {
      class: "qdrant-dialog-actions ui-dialog-actions create-collection-actions",
    }, [cancelBtn, okBtn]);

    dialog.append(title, intro, input, hint, status, actions);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    setTimeout(() => input.focus(), 0);
  });
}
