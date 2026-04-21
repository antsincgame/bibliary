// @ts-check
/**
 * Qdrant management — отдельная вкладка.
 *
 * Что умеет:
 *   • Список коллекций (имя, точек, размер вектора, статус).
 *   • Карточка коллекции — info + последние точки + поиск.
 *   • Создать новую коллекцию (имя, vectorSize=384/768/1024, distance).
 *   • Удалить коллекцию (с двойным подтверждением).
 *   • Семантический поиск по выбранной коллекции (e5-small embed на main-стороне).
 *
 * Дизайн — две колонки: слева список, справа details / actions.
 */

import { el, clear, fmtBytes } from "./dom.js";
import { t } from "./i18n.js";
import { buildNeonHero, wrapSacredCard, neonSpinner, neonDivider } from "./components/neon-helpers.js";

const STATE = {
  /** @type {Array<{name:string;pointsCount:number;vectorSize?:number;status:string}>} */
  collections: [],
  /** @type {string|null} */
  selected: null,
  /** @type {{url:string;online:boolean;version?:string;collectionsCount:number}|null} */
  cluster: null,
  loading: false,
  search: { query: "", running: false, results: [] },
};

/** @returns {any} */
function api() { return /** @type {any} */ (window).api; }

function fmtNum(n) {
  return new Intl.NumberFormat().format(n || 0);
}

async function loadCluster() {
  try {
    STATE.cluster = await api().qdrant.cluster();
  } catch (e) {
    STATE.cluster = { url: "?", online: false, collectionsCount: 0 };
  }
}

async function loadCollections() {
  STATE.loading = true;
  try {
    STATE.collections = await api().qdrant.listDetailed();
  } catch (e) {
    STATE.collections = [];
  } finally {
    STATE.loading = false;
  }
}

function renderHeader(root) {
  const onLine = STATE.cluster?.online;
  const dotCls = onLine ? "qdrant-dot qdrant-dot-on" : "qdrant-dot qdrant-dot-off";
  return el("div", { class: "qdrant-bar" }, [
    el("div", { class: "qdrant-bar-left" }, [
      el("span", { class: dotCls }),
      el("span", { class: "qdrant-bar-url" }, STATE.cluster?.url || "—"),
      STATE.cluster?.version ? el("span", { class: "qdrant-bar-ver" }, `v${STATE.cluster.version}`) : null,
      el("span", { class: "qdrant-bar-count" }, t("qdrant.bar.count", { n: STATE.collections.length })),
    ]),
    el("div", { class: "qdrant-bar-right" }, [
      el("button", {
        class: "btn-secondary",
        onclick: () => render(root),
      }, t("qdrant.refresh")),
      el("button", {
        class: "btn-primary",
        onclick: () => openCreateDialog(root),
      }, t("qdrant.create")),
    ]),
  ]);
}

function renderList(root) {
  if (STATE.loading) {
    return el("div", { class: "qdrant-list-empty" }, [neonSpinner(), " ", t("qdrant.loading")]);
  }
  if (STATE.collections.length === 0) {
    return el("div", { class: "qdrant-list-empty" }, t("qdrant.empty"));
  }
  const list = el("div", { class: "qdrant-list" });
  for (const c of STATE.collections) {
    const isActive = STATE.selected === c.name;
    const item = el("button", {
      class: `qdrant-item ${isActive ? "qdrant-item-active" : ""}`,
      onclick: async () => {
        STATE.selected = c.name;
        render(root);
      },
    }, [
      el("div", { class: "qdrant-item-name" }, c.name),
      el("div", { class: "qdrant-item-meta" }, [
        el("span", { class: "qdrant-badge" }, t("qdrant.points", { n: fmtNum(c.pointsCount) })),
        c.vectorSize ? el("span", { class: "qdrant-badge qdrant-badge-dim" }, `dim ${c.vectorSize}`) : null,
        el("span", { class: `qdrant-badge qdrant-badge-${c.status}` }, c.status),
      ]),
    ]);
    list.appendChild(item);
  }
  return list;
}

async function renderDetails(root) {
  if (!STATE.selected) {
    return el("div", { class: "qdrant-details-empty" }, [
      el("div", { class: "qdrant-empty-icon" }, "◈"),
      el("div", { class: "qdrant-empty-title" }, t("qdrant.details.pickPrompt")),
      el("div", { class: "qdrant-empty-sub" }, t("qdrant.details.pickPromptSub")),
    ]);
  }
  const wrap = el("div", { class: "qdrant-details" });
  wrap.appendChild(el("div", { class: "qdrant-details-loading" }, t("qdrant.loading")));

  Promise.resolve().then(async () => {
    const info = await api().qdrant.info(STATE.selected);
    if (!info) {
      clear(wrap);
      wrap.appendChild(el("div", { class: "qdrant-details-empty" }, t("qdrant.details.error")));
      return;
    }
    clear(wrap);
    wrap.appendChild(renderInfoCard(info, root));
    wrap.appendChild(renderSearchCard(info.name, root));
  });

  return wrap;
}

function renderInfoCard(info, root) {
  const inner = el("div", {});
  inner.appendChild(el("div", { class: "qdrant-card-head" }, [
    el("div", { class: "qdrant-card-title neon-heading" }, info.name),
    el("button", {
      class: "btn-danger-soft",
      onclick: () => openDeleteDialog(info.name, root),
    }, t("qdrant.delete")),
  ]));

  const grid = el("div", { class: "qdrant-stats" });
  const stat = (label, value, dim) =>
    el("div", { class: "qdrant-stat" }, [
      el("div", { class: "qdrant-stat-label" }, label),
      el("div", { class: `qdrant-stat-value ${dim ? "qdrant-stat-dim" : ""}` }, String(value ?? "--")),
    ]);
  grid.appendChild(stat(t("qdrant.stat.points"), fmtNum(info.pointsCount)));
  grid.appendChild(stat(t("qdrant.stat.vectors"), fmtNum(info.vectorsCount)));
  grid.appendChild(stat(t("qdrant.stat.segments"), fmtNum(info.segmentsCount)));
  grid.appendChild(stat(t("qdrant.stat.dim"), info.vectorSize ?? "--"));
  grid.appendChild(stat(t("qdrant.stat.distance"), info.distance ?? "--"));
  grid.appendChild(stat(t("qdrant.stat.status"), info.status));
  grid.appendChild(stat(t("qdrant.stat.disk"), fmtBytes(info.diskDataSize)));
  grid.appendChild(stat(t("qdrant.stat.ram"), fmtBytes(info.ramDataSize)));
  inner.appendChild(grid);
  return wrapSacredCard([inner], "qdrant-card");
}

function renderSearchCard(name, root) {
  const inner = el("div", {});
  inner.appendChild(el("div", { class: "qdrant-card-title neon-heading" }, t("qdrant.search.title")));
  const input = el("input", {
    type: "text",
    class: "qdrant-search-input",
    placeholder: t("qdrant.search.placeholder"),
    value: STATE.search.query,
  });
  /** @type {HTMLButtonElement} */
  const goBtn = /** @type {any} */ (el("button", {
    class: "btn-primary",
    onclick: async () => {
      const q = /** @type {HTMLInputElement} */(input).value.trim();
      STATE.search.query = q;
      if (!q) return;
      STATE.search.running = true;
      goBtn.disabled = true;
      goBtn.textContent = t("qdrant.search.running");
      try {
        STATE.search.results = await api().qdrant.search({ collection: name, query: q, limit: 12 });
      } catch (e) {
        STATE.search.results = [];
      } finally {
        STATE.search.running = false;
        goBtn.disabled = false;
        goBtn.textContent = t("qdrant.search.go");
        renderSearchResults();
      }
    },
  }, t("qdrant.search.go")));
  inner.appendChild(el("div", { class: "qdrant-search-row" }, [input, goBtn]));

  const results = el("div", { class: "qdrant-search-results", id: "qdrant-search-results" });
  inner.appendChild(results);

  function renderSearchResults() {
    clear(results);
    if (STATE.search.results.length === 0 && STATE.search.query) {
      results.appendChild(el("div", { class: "qdrant-search-empty" }, t("qdrant.search.empty")));
      return;
    }
    for (const r of STATE.search.results) {
      const principle = String(r.payload.principle ?? r.payload.bookTitle ?? r.payload.text ?? "—").slice(0, 200);
      const expl = String(r.payload.explanation ?? r.payload.chapterTitle ?? "").slice(0, 240);
      const score = (r.score * 100).toFixed(0);
      results.appendChild(el("div", { class: "qdrant-hit" }, [
        el("div", { class: "qdrant-hit-head" }, [
          el("span", { class: "qdrant-hit-score" }, `${score}%`),
          el("span", { class: "qdrant-hit-id" }, r.id.slice(0, 8)),
        ]),
        el("div", { class: "qdrant-hit-title" }, principle),
        expl ? el("div", { class: "qdrant-hit-sub" }, expl) : null,
      ]));
    }
  }
  return wrapSacredCard([inner], "qdrant-card");
}

function openCreateDialog(root) {
  const overlay = el("div", { class: "qdrant-overlay" });
  const dialog = el("div", { class: "qdrant-dialog" });
  const close = () => { overlay.remove(); };

  dialog.appendChild(el("div", { class: "qdrant-dialog-title" }, t("qdrant.create.title")));
  dialog.appendChild(el("div", { class: "qdrant-dialog-sub" }, t("qdrant.create.sub")));

  const nameIn = /** @type {HTMLInputElement} */ (el("input", {
    type: "text",
    class: "qdrant-input",
    placeholder: t("qdrant.create.namePlaceholder"),
  }));
  const sizeSel = /** @type {HTMLSelectElement} */ (el("select", { class: "qdrant-input" }, [
    el("option", { value: "384" }, "384 — multilingual-e5-small (default)"),
    el("option", { value: "512" }, "512"),
    el("option", { value: "768" }, "768 — e5-base / bge-base"),
    el("option", { value: "1024" }, "1024 — e5-large / bge-large"),
    el("option", { value: "1536" }, "1536 — OpenAI ada-002"),
  ]));
  const distSel = /** @type {HTMLSelectElement} */ (el("select", { class: "qdrant-input" }, [
    el("option", { value: "Cosine" }, "Cosine"),
    el("option", { value: "Dot" }, "Dot"),
    el("option", { value: "Euclid" }, "Euclid"),
  ]));

  dialog.appendChild(el("label", { class: "qdrant-field" }, [
    el("span", { class: "qdrant-field-label" }, t("qdrant.create.name")),
    nameIn,
  ]));
  dialog.appendChild(el("label", { class: "qdrant-field" }, [
    el("span", { class: "qdrant-field-label" }, t("qdrant.create.dim")),
    sizeSel,
  ]));
  dialog.appendChild(el("label", { class: "qdrant-field" }, [
    el("span", { class: "qdrant-field-label" }, t("qdrant.create.distance")),
    distSel,
  ]));

  const error = el("div", { class: "qdrant-error", style: "display:none" });
  dialog.appendChild(error);

  const actions = el("div", { class: "qdrant-dialog-actions" }, [
    el("button", { class: "btn-secondary", onclick: close }, t("qdrant.cancel")),
    el("button", {
      class: "btn-primary",
      onclick: async () => {
        const name = nameIn.value.trim();
        if (!name) {
          error.textContent = t("qdrant.create.errorName");
          error.style.display = "block";
          return;
        }
        if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
          error.textContent = t("qdrant.create.errorChars");
          error.style.display = "block";
          return;
        }
        const res = await api().qdrant.create({
          name,
          vectorSize: Number(sizeSel.value),
          distance: /** @type {"Cosine"|"Euclid"|"Dot"} */ (distSel.value),
        });
        if (!res.ok) {
          error.textContent = res.error || t("qdrant.create.errorGeneric");
          error.style.display = "block";
          return;
        }
        close();
        STATE.selected = name;
        await loadCollections();
        await loadCluster();
        render(root);
      },
    }, t("qdrant.create.go")),
  ]);
  dialog.appendChild(actions);
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);
  setTimeout(() => nameIn.focus(), 50);
}

function openDeleteDialog(name, root) {
  const overlay = el("div", { class: "qdrant-overlay" });
  const dialog = el("div", { class: "qdrant-dialog" });
  const close = () => { overlay.remove(); };

  dialog.appendChild(el("div", { class: "qdrant-dialog-title qdrant-danger-title" }, t("qdrant.delete.title")));
  dialog.appendChild(el("div", { class: "qdrant-dialog-sub" }, t("qdrant.delete.sub", { name })));

  const confirmIn = /** @type {HTMLInputElement} */ (el("input", {
    type: "text",
    class: "qdrant-input",
    placeholder: name,
  }));
  dialog.appendChild(el("label", { class: "qdrant-field" }, [
    el("span", { class: "qdrant-field-label" }, t("qdrant.delete.confirmLabel", { name })),
    confirmIn,
  ]));
  const error = el("div", { class: "qdrant-error", style: "display:none" });
  dialog.appendChild(error);

  dialog.appendChild(el("div", { class: "qdrant-dialog-actions" }, [
    el("button", { class: "btn-secondary", onclick: close }, t("qdrant.cancel")),
    el("button", {
      class: "btn-danger",
      onclick: async () => {
        if (confirmIn.value !== name) {
          error.textContent = t("qdrant.delete.errorMismatch");
          error.style.display = "block";
          return;
        }
        const res = await api().qdrant.remove(name);
        if (!res.ok) {
          error.textContent = res.error || t("qdrant.delete.errorGeneric");
          error.style.display = "block";
          return;
        }
        close();
        if (STATE.selected === name) STATE.selected = null;
        await loadCollections();
        await loadCluster();
        render(root);
      },
    }, t("qdrant.delete.go")),
  ]));

  overlay.appendChild(dialog);
  document.body.appendChild(overlay);
  setTimeout(() => confirmIn.focus(), 50);
}

async function render(root) {
  clear(root);
  await loadCluster();
  await loadCollections();
  const layout = el("div", { class: "qdrant-screen" });

  const hero = buildNeonHero({
    title: t("qdrant.header.title"),
    subtitle: t("qdrant.header.sub"),
    pattern: "flower",
  });
  layout.appendChild(hero);

  layout.appendChild(renderHeader(root));
  layout.appendChild(neonDivider());

  const main = el("div", { class: "qdrant-main" });
  main.appendChild(el("div", { class: "qdrant-list-wrap" }, [renderList(root)]));
  main.appendChild(el("div", { class: "qdrant-details-wrap" }, [await renderDetails(root)]));
  layout.appendChild(main);
  root.appendChild(layout);
}

export function mountQdrant(root) {
  if (!root) return;
  if (root.dataset.mounted === "1") return;
  root.dataset.mounted = "1";
  STATE.selected = null;
  render(root);
}
