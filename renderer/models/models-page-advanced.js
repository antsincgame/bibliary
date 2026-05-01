// @ts-check
/**
 * Панель «Дополнительные настройки» для страницы Models.
 *
 * Едва заметный <details> элемент под списком ролей — для технически
 * подготовленных пользователей. Не отображается по умолчанию, раскрывается
 * по клику на «⚙ Настройки».
 *
 * Настройки загружаются из preferences при открытии и сохраняются
 * немедленно при изменении через window.api.preferences.set.
 */

import { el, clear } from "../dom.js";

/** Строит панель дополнительных настроек.
 * @returns {HTMLDetailsElement}
 */
export function buildAdvancedPanel() {
  const details = /** @type {HTMLDetailsElement} */ (
    el("details", { class: "mp-adv-panel" })
  );

  details.appendChild(
    el("summary", { class: "mp-adv-summary" }, "⚙ Настройки"),
  );

  const body = el("div", { class: "mp-adv-body" });
  details.appendChild(body);

  details.addEventListener("toggle", () => {
    if (details.open) void loadAndRender(body);
  });

  return details;
}

/** @param {HTMLElement} container */
async function loadAndRender(container) {
  clear(container);

  /** @type {Record<string, unknown>} */
  let prefs = {};
  try {
    prefs = (await window.api?.preferences?.getAll()) ?? {};
  } catch {
    /* ignore — no prefs available */
  }

  /**
   * @param {string} key
   * @param {unknown} value
   */
  const save = async (key, value) => {
    try {
      await window.api?.preferences?.set({ [key]: value });
    } catch (e) {
      console.warn("[mp-adv] save failed:", e);
    }
  };

  /**
   * @param {string} label
   * @param {string} key
   * @param {string} [placeholder]
   */
  const textRow = (label, key, placeholder = "") => {
    const inp = /** @type {HTMLInputElement} */ (
      el("input", {
        type: "text",
        class: "mp-adv-input",
        value: String(prefs[key] ?? ""),
        placeholder,
      })
    );
    inp.addEventListener("change", () => void save(key, inp.value.trim()));
    return el("div", { class: "mp-adv-row" }, [
      el("span", { class: "mp-adv-label" }, label),
      inp,
    ]);
  };

  /**
   * @param {string} label
   * @param {string} key
   * @param {number} min
   * @param {number} max
   */
  const numRow = (label, key, min, max) => {
    const inp = /** @type {HTMLInputElement} */ (
      el("input", {
        type: "number",
        class: "mp-adv-input mp-adv-input-num",
        value: String(prefs[key] ?? ""),
        min: String(min),
        max: String(max),
      })
    );
    inp.addEventListener("change", () => {
      const v = Number(inp.value);
      if (!isNaN(v) && v >= min && v <= max) void save(key, v);
    });
    return el("div", { class: "mp-adv-row" }, [
      el("span", { class: "mp-adv-label" }, label),
      inp,
    ]);
  };

  /**
   * @param {string} label
   * @param {string} key
   */
  const boolRow = (label, key) => {
    const inp = /** @type {HTMLInputElement} */ (
      el("input", { type: "checkbox", class: "mp-adv-check" })
    );
    inp.checked = Boolean(prefs[key]);
    inp.addEventListener("change", () => void save(key, inp.checked));
    return el("label", { class: "mp-adv-row mp-adv-row-check" }, [
      inp,
      el("span", { class: "mp-adv-label" }, label),
    ]);
  };

  container.appendChild(
    el("div", { class: "mp-adv-section" }, [
      el("div", { class: "mp-adv-section-title" }, "Подключение"),
      textRow("LM Studio URL", "lmStudioUrl", "http://localhost:1234"),
      textRow("Qdrant URL", "qdrantUrl", "http://localhost:6333"),
    ]),
  );

  container.appendChild(
    el("div", { class: "mp-adv-section" }, [
      el("div", { class: "mp-adv-section-title" }, "Обработка"),
      numRow("Параллелизм импорта", "ingestParallelism", 1, 16),
      boolRow("Онлайн-поиск ISBN", "metadataOnlineLookup"),
      boolRow("Vision-meta (LLM обложки)", "visionMetaEnabled"),
      boolRow("OCR (системный)", "ocrEnabled"),
    ]),
  );
}
