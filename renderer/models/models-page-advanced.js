// @ts-check
/**
 * Панель «Дополнительные настройки» для страницы Models (Иt 8Б — упрощена).
 *
 * История:
 *   - До Иt 8Б: содержала 6 дублирующих полей (lmStudioUrl, chromaUrl,
 *     ingestParallelism, metadataOnlineLookup, visionMetaEnabled, ocrEnabled),
 *     которые ДУБЛИРОВАЛИ Settings UI. Это нарушало принцип single source
 *     of truth (Perplexity research 2026-05-01).
 *   - Иt 8Б (приказ Примарха): все дубли удалены. Панель теперь — лишь
 *     навигационный shortcut к /settings, чтобы пользователь страницы Models
 *     знал, что тонкая настройка живёт в Settings.
 */

import { el } from "../dom.js";
import { t } from "../i18n.js";

/** Строит навигационный <details> со ссылкой на Settings.
 * @returns {HTMLDetailsElement}
 */
export function buildAdvancedPanel() {
  const details = /** @type {HTMLDetailsElement} */ (
    el("details", { class: "mp-adv-panel" })
  );

  details.appendChild(
    el("summary", { class: "mp-adv-summary" }, t("models.advanced.summary")),
  );

  const link = /** @type {HTMLAnchorElement} */ (
    el("a", {
      class: "mp-adv-link",
      href: "#settings",
      onclick: (event) => {
        /** @type {MouseEvent} */ (event).preventDefault();
        const btn = /** @type {HTMLButtonElement | null} */ (
          document.querySelector('.sidebar-icon[data-route="settings"]')
        );
        if (btn) btn.click();
      },
    }, t("models.advanced.linkToSettings"))
  );

  details.appendChild(
    el("div", { class: "mp-adv-body" }, [
      el("p", { class: "mp-adv-hint" }, t("models.advanced.hint")),
      link,
    ]),
  );

  return details;
}
