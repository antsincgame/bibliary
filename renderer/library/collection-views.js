// @ts-check
/**
 * Collection Views — виртуальные представления каталога.
 * Рендерит четыре вкладки: Домены, Авторы, Годы, Теги.
 * Данные берутся из SQLite через IPC, никаких физических .bookref.md.
 */
import { el, clear } from "../dom.js";
import { t, getLocale } from "../i18n.js";

/** @typedef {{ label: string; count: number; bookIds: string[] }} CollectionGroup */

/** @type {'domain' | 'author' | 'year' | 'tag' | 'sphere'} */
let activeTab = "domain";

/** @type {HTMLElement | null} */
let viewRoot = null;

/** @type {((bookIds: string[]) => void) | null} */
let onFilterCallback = null;

/**
 * Build and mount collection views panel.
 * @param {HTMLElement} container
 * @param {(bookIds: string[]) => void} onFilter - callback to filter catalog by selected group
 */
export function mountCollectionViews(container, onFilter) {
  onFilterCallback = onFilter;
  viewRoot = el("div", { class: "lib-collections" });
  container.appendChild(viewRoot);
  renderTabs();
  loadActiveTab();
}

function renderTabs() {
  if (!viewRoot) return;
  clear(viewRoot);

  const tabs = [
    { id: "domain", label: t("library.collections.domains") || "Домены" },
    { id: "author", label: t("library.collections.authors") || "Авторы" },
    { id: "year", label: t("library.collections.years") || "Годы" },
    { id: "tag", label: t("library.collections.tags") || "Теги" },
    { id: "sphere", label: t("library.collections.spheres") || "Сферы" },
  ];

  const tabBar = el("div", { class: "lib-collections-tabs" },
    tabs.map((tab) =>
      el("button", {
        class: `lib-collections-tab ${tab.id === activeTab ? "active" : ""}`,
        type: "button",
        onclick: () => {
          activeTab = /** @type {typeof activeTab} */ (tab.id);
          renderTabs();
          loadActiveTab();
        },
      }, tab.label)
    )
  );

  const content = el("div", { class: "lib-collections-content", id: "lib-collections-content" });
  viewRoot.append(tabBar, content);
}

async function loadActiveTab() {
  const content = viewRoot?.querySelector("#lib-collections-content");
  if (!content) return;

  clear(/** @type {HTMLElement} */ (content));
  content.appendChild(el("div", { class: "lib-collections-loading" }, t("library.collections.loading") || "Loading..."));

  try {
    /** @type {CollectionGroup[]} */
    let groups;
    switch (activeTab) {
      case "domain":
        groups = await window.api.library.collectionByDomain();
        break;
      case "author":
        groups = await window.api.library.collectionByAuthor(getLocale() === "ru" ? "ru" : "en");
        break;
      case "year":
        groups = await window.api.library.collectionByYear();
        break;
      case "tag":
        groups = await window.api.library.collectionByTag(getLocale() === "ru" ? "ru" : "en");
        break;
      case "sphere":
        groups = await window.api.library.collectionBySphere();
        break;
      default:
        groups = [];
    }
    renderGroups(/** @type {HTMLElement} */ (content), groups);
  } catch (err) {
    clear(/** @type {HTMLElement} */ (content));
    content.appendChild(el("div", { class: "lib-collections-error" },
      `Error: ${err instanceof Error ? err.message : String(err)}`));
  }
}

/**
 * @param {HTMLElement} container
 * @param {CollectionGroup[]} groups
 */
function renderGroups(container, groups) {
  clear(container);
  if (groups.length === 0) {
    container.appendChild(el("div", { class: "lib-collections-empty" },
      t("library.collections.empty") || "Нет данных"));
    return;
  }

  const maxCount = Math.max(...groups.map((g) => g.count));

  const list = el("div", { class: "lib-collections-cloud" },
    groups.map((group) => {
      const scale = 0.7 + 0.6 * (group.count / Math.max(maxCount, 1));
      const pill = el("button", {
        class: "lib-collections-pill",
        type: "button",
        style: `font-size: ${scale}em; opacity: ${0.5 + 0.5 * (group.count / Math.max(maxCount, 1))}`,
        onclick: () => {
          if (onFilterCallback) onFilterCallback(group.bookIds);
        },
      }, [
        el("span", { class: "lib-collections-pill-label" }, group.label),
        el("span", { class: "lib-collections-pill-count" }, `(${group.count})`),
      ]);
      return pill;
    })
  );

  const resetBtn = el("button", {
    class: "lib-btn lib-collections-reset",
    type: "button",
    onclick: () => {
      if (onFilterCallback) onFilterCallback([]);
    },
  }, t("library.collections.showAll") || "Показать все");

  container.append(list, resetBtn);
}

export function refreshCollectionViews() {
  if (viewRoot) loadActiveTab();
}
