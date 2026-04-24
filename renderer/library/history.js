// @ts-check
/**
 * History tab: ingestion history grouped by collection.
 */
import { el, clear } from "../dom.js";
import { t } from "../i18n.js";
import { STATE } from "./state.js";
import { fmtDate } from "./format.js";

export async function loadHistory() {
  try {
    STATE.history = await window.api.scanner.listHistory();
    STATE.knownPaths.clear();
    for (const g of STATE.history) for (const b of g.books) STATE.knownPaths.add(b.bookSourcePath);
  } catch (_e) {
    console.warn("[history] loadHistory failed:", _e);
    STATE.history = [];
  }
}

export function renderHistory(root) {
  const wrap = root.querySelector(".lib-history");
  if (!wrap) return;
  clear(wrap);
  if (STATE.history.length === 0) {
    wrap.appendChild(el("div", { class: "lib-empty" }, t("library.history.empty")));
    return;
  }
  for (const group of STATE.history) {
    const head = el("div", { class: "lib-hist-group-head" }, [
      el("strong", { class: "lib-hist-collection" }, group.collection),
      el("span", { class: "lib-hist-meta" }, ` - ${group.totalBooks} ${t("library.history.books")} - ${group.totalChunks} ${t("library.history.chunks")}`),
    ]);
    const list = el("div", { class: "lib-hist-list" });
    for (const b of group.books) {
      const isIngesting = STATE.activeIngests.has(b.bookSourcePath);
      const delBtnAttrs = isIngesting
        ? { class: "lib-btn lib-btn-small", type: "button", disabled: "true", title: t("library.history.btn.deleteDisabled") }
        : {
            class: "lib-btn lib-btn-small",
            type: "button",
            onclick: async () => {
              if (STATE.activeIngests.has(b.bookSourcePath)) {
                alert(t("library.history.deleteWhileIngest"));
                return;
              }
              if (!confirm(t("library.history.confirmDelete").replace("{book}", b.fileName).replace("{collection}", group.collection))) return;
              try {
                await window.api.scanner.deleteFromCollection(b.bookSourcePath, group.collection);
                await loadHistory();
                renderHistory(root);
              } catch (e) {
                alert(t("library.history.deleteFailed") + ": " + (e instanceof Error ? e.message : String(e)));
              }
            },
          };
      list.appendChild(
        el("div", { class: "lib-hist-row" }, [
          el("span", { class: `lib-hist-status lib-hist-status-${b.status}` }, b.status),
          el("div", { class: "lib-hist-name", title: b.bookSourcePath }, b.fileName),
          el("div", { class: "lib-hist-counts" }, `${b.processedChunks}/${b.totalChunks}`),
          el("div", { class: "lib-hist-date" }, fmtDate(b.lastUpdatedAt)),
          el("button", delBtnAttrs, t("library.history.btn.delete")),
        ])
      );
    }
    wrap.appendChild(el("div", { class: "lib-hist-group" }, [head, list]));
  }
}
