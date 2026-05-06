// @ts-check
/**
 * Collection Picker -- reusable component for selecting (and creating)
 * Chroma collections. Used by Library top-bar and (later in Iter 6)
 * by Crystallizer to pick a thematic target collection.
 *
 * Visual: HUD-style native <select> + "+" button matching the existing
 * Chat top-bar pattern (#collection-select + #btn-create-collection)
 * but encapsulated and parametric.
 *
 * Why not a custom dropdown: native <select> works for keyboard nav,
 * accessibility, and zero JS overhead. Dropping it would be over-engineering.
 */
import { el } from "../dom.js";
import { t } from "../i18n.js";
import { showAlert, showConfirm } from "./ui-dialog.js";
import { showCreateCollectionModal } from "./create-collection-modal.js";

/**
 * @typedef {object} CollectionPickerOptions
 * @property {string} id                                  Stable id for select (for tests / aria).
 * @property {string} [labelText]                         Optional visible label. If omitted -- no label.
 * @property {string} [initialValue]                      Pre-selected collection name.
 * @property {(name: string) => void} onChange            Fired when user selects an existing collection.
 * @property {(name: string) => void | Promise<void>} [onCreate]  Fired AFTER successful collection creation. If absent -- "+" hidden.
 * @property {(name: string) => void | Promise<void>} [onDelete]  Fired AFTER user confirms deletion. If absent -- "−" hidden.
 * @property {() => Promise<string[]>} loadCollections    Async loader. Returns list of collection names.
 * @property {(name: string) => Promise<{ ok: boolean, error?: string }>} [createCollection]
 *           Async creator. If absent and onCreate present -- only triggers prompt without backend call.
 * @property {boolean} [autoLoad]                         If true -- list is loaded immediately on mount.
 */

/**
 * @param {CollectionPickerOptions} opts
 * @returns {{ root: HTMLElement, refresh: () => Promise<void>, getValue: () => string, setValue: (name: string) => void }}
 */
export function buildCollectionPicker(opts) {
  const root = el("div", { class: "coll-picker" });

  if (opts.labelText) {
    root.appendChild(el("label", { class: "coll-picker-label", for: opts.id }, opts.labelText));
  }

  const select = /** @type {HTMLSelectElement} */ (
    el("select", { class: "coll-picker-select", id: opts.id })
  );
  const placeholder = el("option", { value: "" }, t("library.collection.loading"));
  select.appendChild(placeholder);
  root.appendChild(select);

  select.addEventListener("change", () => {
    opts.onChange(select.value);
  });

  const refreshBtn = el(
    "button",
    {
      type: "button",
      class: "coll-picker-btn coll-picker-btn-refresh",
      title: t("library.collection.refresh"),
      "aria-label": t("library.collection.refresh"),
    },
    "↻"
  );
  refreshBtn.addEventListener("click", () => {
    void refresh();
  });
  root.appendChild(refreshBtn);

  if (opts.onCreate) {
    const createBtn = el(
      "button",
      {
        type: "button",
        class: "coll-picker-btn coll-picker-btn-create",
        title: t("library.collection.create.title"),
        "aria-label": t("library.collection.create.title"),
      },
      "+"
    );
    createBtn.addEventListener("click", () => {
      void handleCreate();
    });
    root.appendChild(createBtn);
  }

  if (opts.onDelete) {
    const deleteBtn = el(
      "button",
      {
        type: "button",
        class: "coll-picker-btn coll-picker-btn-delete",
        title: t("library.collection.delete.title"),
        "aria-label": t("library.collection.delete.title"),
      },
      "\u2212"
    );
    deleteBtn.addEventListener("click", () => {
      void handleDelete();
    });
    root.appendChild(deleteBtn);
  }

  /* "Open Chroma API" — у Chroma нет полноценного дашборда (как у Chroma), но
     можно открыть REST API root в браузере для отладки. URL читаем из
     preferences.chromaUrl, fallback http://localhost:8000. */
  const dashBtn = el(
    "button",
    {
      type: "button",
      class: "coll-picker-btn coll-picker-btn-dash",
      title: t("library.collection.openDashboard.title"),
      "aria-label": t("library.collection.openDashboard"),
    },
    "\u29C9"
  );
  dashBtn.addEventListener("click", () => {
    void openChromaApi();
  });
  root.appendChild(dashBtn);

  /** @type {string[]} */
  let cached = [];

  async function refresh() {
    select.disabled = true;
    try {
      cached = await opts.loadCollections();
      const previous = opts.initialValue || select.value || "";
      select.innerHTML = "";
      if (cached.length === 0) {
        select.appendChild(el("option", { value: "" }, t("library.collection.empty")));
      } else {
        for (const name of cached) {
          const o = /** @type {HTMLOptionElement} */ (el("option", { value: name }, name));
          if (name === previous) o.selected = true;
          select.appendChild(o);
        }
        if (!cached.includes(previous) && cached[0]) {
          select.value = cached[0];
        }
      }
      opts.onChange(select.value);
    } catch (err) {
      select.innerHTML = "";
      select.appendChild(el("option", { value: "" }, t("library.collection.error")));
      console.error("[collection-picker] load failed:", err);
    } finally {
      select.disabled = false;
    }
  }

  async function handleCreate() {
    if (!opts.onCreate) return;
    const name = await showCreateCollectionModal();
    if (!name) return;
    if (cached.includes(name)) {
      await showAlert(t("library.collection.create.exists"));
      select.value = name;
      opts.onChange(name);
      return;
    }
    if (opts.createCollection) {
      try {
        const result = await opts.createCollection(name);
        if (!result.ok) {
          await offerDashboardFallback(result.error || "unknown");
          return;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await offerDashboardFallback(msg);
        return;
      }
    }
    await refresh();
    select.value = name;
    opts.onChange(name);
    await opts.onCreate(name);
  }

  async function handleDelete() {
    if (!opts.onDelete) return;
    const name = select.value;
    if (!name) {
      await showAlert(t("library.collection.delete.empty"));
      return;
    }
    const ok = await showConfirm(t("library.collection.delete.confirm", { name }));
    if (!ok) return;
    await opts.onDelete(name);
    await refresh();
  }

  if (opts.autoLoad !== false) {
    setTimeout(() => { void refresh(); }, 0);
  }

  return {
    root,
    refresh,
    getValue: () => select.value,
    setValue: (name) => {
      if (cached.includes(name)) {
        select.value = name;
        opts.onChange(name);
      }
    },
  };
}

/**
 * Спросить пользователя про fallback на Chroma API и открыть в браузере.
 * Используется когда автоматическое создание коллекции упало.
 * @param {string} errorMsg
 */
async function offerDashboardFallback(errorMsg) {
  const msg = t("library.collection.create.openDashboardConfirm", { error: errorMsg });
  if (!(await showConfirm(msg))) return;
  await openChromaApi();
}

/**
 * Открыть Chroma REST API root в системном браузере. У Chroma нет
 * полноценного дашборда (как у Chroma), но root URL отдаёт API info /
 * документацию для отладки. URL читаем из preferences.chromaUrl, иначе
 * localhost:8000. Идём через preload (system.openExternal), чтобы не
 * зависеть от webContents.setWindowOpenHandler и CSP.
 */
async function openChromaApi() {
  let baseUrl = "http://localhost:8000";
  try {
    const api = /** @type {any} */ (window).api;
    const prefs = await api?.preferences?.getAll?.();
    if (prefs?.chromaUrl && typeof prefs.chromaUrl === "string" && prefs.chromaUrl.trim()) {
      baseUrl = prefs.chromaUrl.trim().replace(/\/+$/, "");
    }
  } catch (_e) { /* tolerate: pref read non-critical */ }
  /* Chroma корневой path отдаёт статус/info; /api/v1/heartbeat для смока. */
  const url = baseUrl;
  try {
    const api = /** @type {any} */ (window).api;
    if (typeof api?.system?.openExternal === "function") {
      await api.system.openExternal(url);
      return;
    }
  } catch (_e) { /* tolerate: fall through to direct open */ }
  try { window.open(url, "_blank", "noopener,noreferrer"); }
  catch (_e) { await showAlert(`Откройте в браузере: ${url}`); }
}
