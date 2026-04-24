// @ts-check
/**
 * Collection Picker -- reusable component for selecting (and creating)
 * Qdrant collections. Used by Library top-bar and (later in Iter 6)
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

/**
 * @typedef {object} CollectionPickerOptions
 * @property {string} id                                  Stable id for select (for tests / aria).
 * @property {string} [labelText]                         Optional visible label. If omitted -- no label.
 * @property {string} [initialValue]                      Pre-selected collection name.
 * @property {(name: string) => void} onChange            Fired when user selects an existing collection.
 * @property {(name: string) => void | Promise<void>} [onCreate]  Fired AFTER successful collection creation. If absent -- "+" hidden.
 * @property {() => Promise<string[]>} loadCollections    Async loader. Returns list of collection names.
 * @property {(name: string) => Promise<{ ok: boolean, error?: string }>} [createCollection]
 *           Async creator. If absent and onCreate present -- only triggers prompt without backend call.
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

  /* Открыть Qdrant Dashboard в системном браузере. Полезно когда автоматическое
     создание коллекции упало (Qdrant офлайн / не localhost / нужен ручной выбор
     vector size / distance). URL берём из preferences (qdrantUrl) с fallback'ом
     на http://localhost:6333. */
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
    void openQdrantDashboard();
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
    const raw = window.prompt(t("library.collection.create.prompt"), "");
    if (raw === null) return;
    const name = raw.trim();
    if (!name) {
      window.alert(t("library.collection.create.empty"));
      return;
    }
    if (!/^[a-zA-Z0-9_\-:.]{1,128}$/.test(name)) {
      window.alert(t("library.collection.create.invalid"));
      return;
    }
    if (cached.includes(name)) {
      window.alert(t("library.collection.create.exists"));
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
 * Спросить пользователя про fallback на Qdrant Dashboard и открыть в браузере.
 * Используется когда автоматическое создание коллекции упало.
 * @param {string} errorMsg
 */
async function offerDashboardFallback(errorMsg) {
  const msg = t("library.collection.create.openDashboardConfirm", { error: errorMsg });
  if (!window.confirm(msg)) return;
  await openQdrantDashboard();
}

/**
 * Открыть Qdrant web UI в системном браузере.
 * URL читаем из preferences.qdrantUrl, иначе localhost:6333.
 * Идём через preload (system.openExternal), чтобы не зависеть от
 * webContents.setWindowOpenHandler и CSP.
 */
async function openQdrantDashboard() {
  let baseUrl = "http://localhost:6333";
  try {
    const api = /** @type {any} */ (window).api;
    const prefs = await api?.preferences?.getAll?.();
    if (prefs?.qdrantUrl && typeof prefs.qdrantUrl === "string" && prefs.qdrantUrl.trim()) {
      baseUrl = prefs.qdrantUrl.trim().replace(/\/+$/, "");
    }
  } catch (_e) { /* tolerate: pref read non-critical */ }
  const url = `${baseUrl}/dashboard`;
  try {
    const api = /** @type {any} */ (window).api;
    if (typeof api?.system?.openExternal === "function") {
      await api.system.openExternal(url);
      return;
    }
  } catch (_e) { /* tolerate: fall through to direct open */ }
  try { window.open(url, "_blank", "noopener,noreferrer"); }
  catch (_e) { window.alert(`Откройте в браузере: ${url}`); }
}
