// @ts-check
/**
 * Tag Cloud modal — WordPress-style tag visualization with AND filtering.
 *
 * Tags are sized proportionally to book count. Clicking toggles AND-filter.
 * Selected tags are written back to CATALOG.filters.tags and the catalog
 * is re-rendered on apply.
 */
import { el } from "../dom.js";
import { t } from "../i18n.js";
import { CATALOG } from "./state.js";

const MIN_FONT = 12;
const MAX_FONT = 36;

/**
 * @param {object} deps
 * @param {(root: HTMLElement) => void} deps.renderCatalogTable
 * @param {HTMLElement} deps.root
 */
export async function openTagCloudModal(deps) {
  /** @type {{ tag: string; count: number }[]} */
  let stats = [];
  try {
    stats = await window.api.library.tagStats();
  } catch (e) {
    console.warn("[tag-cloud] failed to load tag stats:", e);
    return;
  }
  if (stats.length === 0) {
    const overlay = buildOverlay();
    const dialog = el("div", { class: "qdrant-dialog ui-dialog tag-cloud-dialog" }, [
      el("div", { class: "qdrant-dialog-title" }, t("library.tagCloud.title")),
      el("div", { class: "ui-dialog-message" }, t("library.tagCloud.empty")),
      el("div", { class: "qdrant-dialog-actions ui-dialog-actions" }, [
        el("button", { class: "btn-primary", type: "button", onclick: () => overlay.remove() },
          t("dialog.ok")),
      ]),
    ]);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    overlay.tabIndex = -1;
    overlay.focus();
    return;
  }

  const selected = new Set(CATALOG.filters.tags || []);

  const minCount = Math.min(...stats.map((s) => s.count));
  const maxCount = Math.max(...stats.map((s) => s.count));
  const range = maxCount - minCount || 1;

  const overlay = buildOverlay();
  const title = el("div", { class: "qdrant-dialog-title" }, t("library.tagCloud.title"));
  const matchCounter = el("span", { class: "tag-cloud-match-count" }, "");

  const cloud = el("div", { class: "tag-cloud-container" });

  /** @type {Map<string, HTMLElement>} */
  const pillMap = new Map();

  for (const { tag, count } of stats) {
    const fontSize = MIN_FONT + ((count - minCount) / range) * (MAX_FONT - MIN_FONT);
    const opacity = 0.5 + ((count - minCount) / range) * 0.5;

    const pill = el("button", {
      type: "button",
      class: `tag-cloud-pill${selected.has(tag) ? " tag-cloud-pill-active" : ""}`,
      style: `font-size:${Math.round(fontSize)}px;opacity:${opacity.toFixed(2)}`,
      title: `${tag} (${count})`,
      onclick: () => {
        if (selected.has(tag)) {
          selected.delete(tag);
          pill.classList.remove("tag-cloud-pill-active");
        } else {
          selected.add(tag);
          pill.classList.add("tag-cloud-pill-active");
        }
        updateMatchCount();
      },
    }, `${tag} (${count})`);
    pillMap.set(tag, pill);
    cloud.appendChild(pill);
  }

  function updateMatchCount() {
    if (selected.size === 0) {
      matchCounter.textContent = "";
      return;
    }
    const tags = Array.from(selected);
    const matching = CATALOG.rows.filter((row) =>
      tags.every((tg) => row.tags?.includes(tg))
    );
    matchCounter.textContent = t("library.tagCloud.matchCount", {
      n: String(matching.length),
      tags: String(selected.size),
    });
  }

  updateMatchCount();

  const clearBtn = el("button", {
    class: "btn-secondary", type: "button",
    onclick: () => {
      selected.clear();
      for (const pill of pillMap.values()) pill.classList.remove("tag-cloud-pill-active");
      updateMatchCount();
    },
  }, t("library.tagCloud.clearAll"));

  const applyBtn = el("button", {
    class: "btn-primary", type: "button",
    onclick: () => {
      CATALOG.filters.tags = selected.size > 0 ? Array.from(selected) : [];
      overlay.remove();
      deps.renderCatalogTable(deps.root);
    },
  }, t("library.tagCloud.apply"));

  const cancelBtn = el("button", {
    class: "btn-secondary", type: "button",
    onclick: () => overlay.remove(),
  }, t("dialog.cancel"));

  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
  overlay.addEventListener("keydown", (e) => { if (e.key === "Escape") overlay.remove(); });

  const actions = el("div", { class: "qdrant-dialog-actions ui-dialog-actions" }, [
    clearBtn, cancelBtn, applyBtn,
  ]);

  const dialog = el("div", {
    class: "qdrant-dialog ui-dialog tag-cloud-dialog",
    role: "dialog",
    "aria-modal": "true",
  }, [title, matchCounter, cloud, actions]);

  dialog.addEventListener("click", (e) => e.stopPropagation());
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);
  overlay.tabIndex = -1;
  overlay.focus();
}

function buildOverlay() {
  return el("div", { class: "qdrant-overlay ui-dialog-overlay" });
}
