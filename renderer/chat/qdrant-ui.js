// @ts-check
import { t } from "../i18n.js";
import { showConfirm } from "../components/ui-dialog.js";

/**
 * In-app input dialog for collection name.
 * @returns {Promise<string | null>}
 */
export function promptCollectionName() {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "qdrant-overlay";
    const dialog = document.createElement("div");
    dialog.className = "qdrant-dialog";
    const title = document.createElement("div");
    title.className = "qdrant-dialog-title";
    title.textContent = t("chat.toast.create_collection_prompt");
    const input = /** @type {HTMLInputElement} */ (document.createElement("input"));
    input.type = "text";
    input.className = "qdrant-input";
    input.placeholder = t("qdrant.create.namePlaceholder");
    const error = document.createElement("div");
    error.className = "qdrant-error";
    error.style.display = "none";

    const actions = document.createElement("div");
    actions.className = "qdrant-dialog-actions";
    const btnCancel = document.createElement("button");
    btnCancel.className = "btn-secondary";
    btnCancel.type = "button";
    btnCancel.textContent = t("qdrant.cancel");
    const btnCreate = document.createElement("button");
    btnCreate.className = "btn-primary";
    btnCreate.type = "button";
    btnCreate.textContent = t("qdrant.create.go");
    actions.append(btnCancel, btnCreate);

    const close = (/** @type {string|null} */ value = null) => {
      overlay.remove();
      resolve(value);
    };

    btnCancel.addEventListener("click", () => close(null));
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close(null);
    });
    dialog.addEventListener("click", (e) => e.stopPropagation());
    btnCreate.addEventListener("click", () => {
      const value = input.value.trim();
      if (!value) {
        error.style.display = "block";
        error.textContent = t("qdrant.create.errorName");
        input.focus();
        return;
      }
      if (!/^[a-zA-Z0-9_\-:.]{1,128}$/.test(value)) {
        error.style.display = "block";
        error.textContent = t("library.collection.create.invalid");
        input.focus();
        return;
      }
      close(value);
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        btnCreate.click();
      }
      if (e.key === "Escape") {
        e.preventDefault();
        close(null);
      }
    });

    dialog.append(title, input, error, actions);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    setTimeout(() => input.focus(), 0);
  });
}

/** @param {string} errorMsg */
export async function maybeOpenQdrantDashboard(errorMsg) {
  const shouldOpen = await showConfirm(
    t("library.collection.create.openDashboardConfirm", { error: errorMsg })
  );
  if (!shouldOpen) return;
  let baseUrl = "http://localhost:6333";
  try {
    const prefs = await window.api?.preferences?.getAll?.();
    if (prefs?.qdrantUrl && typeof prefs.qdrantUrl === "string" && prefs.qdrantUrl.trim()) {
      baseUrl = prefs.qdrantUrl.trim().replace(/\/+$/, "");
    }
  } catch (_e) { /* pref read non-critical */ }
  const url = `${baseUrl}/dashboard`;
  try {
    if (typeof window.api?.system?.openExternal === "function") {
      await window.api.system.openExternal(url);
      return;
    }
  } catch (_e) { /* fall through to direct open */ }
  window.open(url, "_blank", "noopener,noreferrer");
}
