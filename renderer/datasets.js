// @ts-check
import { el, clear } from "./dom.js";
import { t } from "./i18n.js";
import { showAlert, showConfirm } from "./components/ui-dialog.js";
import {
  loadHistory,
  removeDataset,
  recordDataset,
  onHistoryChange,
} from "./datasets-history.js";
import { buildHybridSearchPanel } from "./datasets/hybrid-search-panel.js";

/**
 * Раздел «Датасеты» — простой список созданных датасетов с возможностью
 * посмотреть Q/A в человекочитаемом виде, поискать по тексту, открыть
 * папку или удалить запись из истории.
 *
 * UI намеренно бабушкин: одна колонка карточек, крупный текст, никаких
 * хитрых фильтров. Цель — чтобы библиотекарь зашёл, увидел сегодняшний
 * датасет, открыл его, пролистал примеры и понял качество.
 */

const STATE = {
  /** @type {Array<import("./datasets-history.js").DatasetRecord>} */
  records: [],
  /** @type {string | null} */
  selectedDir: null,
  search: "",
  loading: false,
  /** @type {{file: string, raw: string, parsed: any}[]} */
  preview: [],
  /** @type {string | null} */
  previewFile: null,
  previewQuery: "",
  /** @type {Record<string, unknown> | null} */
  previewMeta: null,
  /** @type {Array<{name: string, sizeBytes: number, lines?: number}>} */
  previewFiles: [],
};

let unsubHistory = null;

/* ────────────────────────────────────────────────────────────────────────── */
/* Helpers                                                                     */
/* ────────────────────────────────────────────────────────────────────────── */

function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0";
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
}

function formatDate(iso) {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function methodLabel(method) {
  return method === "llm-synth"
    ? t("datasets.method.synth")
    : t("datasets.method.template");
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Top bar (search + import)                                                   */
/* ────────────────────────────────────────────────────────────────────────── */

function buildTopBar(root) {
  const search = el("input", {
    class: "ds-list-search",
    type: "search",
    placeholder: t("datasets.search.placeholder"),
    value: STATE.search,
    oninput: (e) => {
      STATE.search = String(/** @type {HTMLInputElement} */ (e.target).value || "");
      renderListBody(root);
    },
  });

  const importBtn = el(
    "button",
    {
      class: "cv-btn",
      type: "button",
      onclick: async () => {
        try {
          const dir = await window.api.datasets.pickFolder();
          if (!dir) return;
          const meta = await window.api.datasets.readMeta(dir);
          if (!meta.ok || !meta.meta) {
            await showAlert(meta.error || t("datasets.import.invalid"));
            return;
          }
          const m = meta.meta;
          recordDataset({
            outputDir: dir,
            collection: String(m.sourceCollection ?? ""),
            format: String(m.format ?? "sharegpt"),
            method: m.method === "llm-synth" ? "llm-synth" : "template",
            model: typeof m.model === "string" ? m.model : undefined,
            concepts: Number(m.concepts ?? 0),
            totalLines: Number(m.totalLines ?? 0),
            trainLines: Number(m.trainLines ?? 0),
            valLines: Number(m.valLines ?? 0),
            durationMs: typeof m.durationMs === "number" ? m.durationMs : undefined,
            createdAt: String(m.generatedAt ?? new Date().toISOString()),
          });
        } catch (e) {
          await showAlert(e instanceof Error ? e.message : String(e));
        }
      },
    },
    t("datasets.import.btn"),
  );

  return el("div", { class: "ds-list-topbar" }, [
    el("div", { class: "ds-list-title" }, [
      el("h1", { class: "ds-list-h" }, t("datasets.title")),
      el("p", { class: "ds-list-sub" }, t("datasets.subtitle")),
    ]),
    el("div", { class: "ds-list-tools" }, [search, importBtn]),
  ]);
}

/* ────────────────────────────────────────────────────────────────────────── */
/* List body                                                                   */
/* ────────────────────────────────────────────────────────────────────────── */

function buildList() {
  return el("div", { class: "ds-list", id: "ds-list" });
}

function renderListBody(root) {
  const list = root.querySelector("#ds-list");
  if (!list) return;
  clear(list);

  const q = STATE.search.trim().toLowerCase();
  const filtered = q
    ? STATE.records.filter((r) => {
        const haystack = [
          r.outputDir,
          r.collection,
          r.format,
          r.method,
          r.model,
          r.label,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return haystack.includes(q);
      })
    : STATE.records;

  if (filtered.length === 0) {
    list.appendChild(
      el("div", { class: "ds-list-empty" }, [
        el("div", { class: "ds-list-empty-icon" }, "∅"),
        el("h3", { class: "ds-list-empty-title" }, t("datasets.empty.title")),
        el("p", { class: "ds-list-empty-hint" }, t("datasets.empty.hint")),
      ]),
    );
    return;
  }

  for (const r of filtered) {
    list.appendChild(buildCard(root, r));
  }
}

function buildCard(root, r) {
  const isSynth = r.method === "llm-synth";
  const summary = t("datasets.card.summary")
    .replace("{train}", String(r.trainLines))
    .replace("{val}", String(r.valLines))
    .replace("{concepts}", String(r.concepts));

  return el("article", { class: "ds-card-item" }, [
    el("div", { class: "ds-card-item-head" }, [
      el(
        "div",
        { class: `ds-card-method ${isSynth ? "ds-card-method-synth" : "ds-card-method-tmpl"}` },
        methodLabel(r.method),
      ),
      el("div", { class: "ds-card-format" }, r.format),
    ]),
    el("h3", { class: "ds-card-item-title" }, r.collection || r.outputDir),
    el("p", { class: "ds-card-item-summary" }, summary),
    el("div", { class: "ds-card-item-meta" }, [
      el("span", {}, formatDate(r.createdAt)),
      isSynth && r.model
        ? el("span", { class: "ds-card-item-model" }, r.model)
        : null,
    ]),
    el("div", { class: "ds-card-item-path" }, r.outputDir),
    el("div", { class: "ds-card-item-actions" }, [
      el(
        "button",
        {
          class: "cv-btn cv-btn-accent",
          type: "button",
          onclick: () => openDataset(root, r.outputDir),
        },
        t("datasets.card.open"),
      ),
      el(
        "button",
        {
          class: "cv-btn",
          type: "button",
          onclick: async () => {
            try {
              await window.api.datasetV2.openFolder(r.outputDir);
            } catch (e) {
              await showAlert(e instanceof Error ? e.message : String(e));
            }
          },
        },
        t("datasets.card.folder"),
      ),
      el(
        "button",
        {
          class: "cv-btn ds-card-item-danger",
          type: "button",
          onclick: async () => {
            const ok = await showConfirm(t("datasets.card.removeConfirm"));
            if (!ok) return;
            removeDataset(r.outputDir);
          },
        },
        t("datasets.card.remove"),
      ),
    ]),
  ]);
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Detail panel (preview)                                                      */
/* ────────────────────────────────────────────────────────────────────────── */

async function openDataset(root, outputDir) {
  STATE.selectedDir = outputDir;
  STATE.loading = true;
  STATE.preview = [];
  STATE.previewFile = null;
  STATE.previewMeta = null;
  STATE.previewFiles = [];
  renderDetail(root);

  try {
    const meta = await window.api.datasets.readMeta(outputDir);
    if (!meta.ok) {
      STATE.loading = false;
      await showAlert(meta.error || t("datasets.detail.metaFailed"));
      STATE.selectedDir = null;
      renderDetail(root);
      return;
    }
    STATE.previewMeta = meta.meta || null;
    STATE.previewFiles = meta.files || [];

    const train = STATE.previewFiles.find((f) => f.name === "train.jsonl");
    if (train) {
      await loadPreviewFile(root, "train.jsonl");
    } else if (STATE.previewFiles[0]) {
      await loadPreviewFile(root, STATE.previewFiles[0].name);
    }
  } finally {
    STATE.loading = false;
    renderDetail(root);
  }
}

async function loadPreviewFile(root, fileName) {
  if (!STATE.selectedDir) return;
  STATE.loading = true;
  STATE.previewFile = fileName;
  renderDetail(root);

  try {
    const sep = STATE.selectedDir.includes("\\") ? "\\" : "/";
    const filePath = `${STATE.selectedDir}${sep}${fileName}`;
    const head = await window.api.datasets.readJsonlHead({ filePath, limit: 50 });
    if (!head.ok || !head.lines) {
      STATE.preview = [];
      await showAlert(head.error || t("datasets.detail.previewFailed"));
      return;
    }
    STATE.preview = head.lines.map((l) => ({
      file: fileName,
      raw: l.raw,
      parsed: l.parsed,
    }));
  } finally {
    STATE.loading = false;
    renderDetail(root);
  }
}

function renderDetail(root) {
  const wrap = root.querySelector("#ds-detail");
  if (!wrap) return;
  clear(wrap);
  if (!STATE.selectedDir) return;

  const closeBtn = el(
    "button",
    {
      class: "ds-detail-close",
      type: "button",
      title: t("datasets.detail.close"),
      onclick: () => {
        STATE.selectedDir = null;
        renderDetail(root);
      },
    },
    "×",
  );

  const header = el("div", { class: "ds-detail-header" }, [
    el("div", { class: "ds-detail-title-row" }, [
      el("h2", { class: "ds-detail-title" }, t("datasets.detail.title")),
      closeBtn,
    ]),
    el("div", { class: "ds-detail-path" }, STATE.selectedDir),
  ]);

  const m = STATE.previewMeta || {};
  const metaTiles = el("div", { class: "ds-detail-meta" }, [
    metaTile(t("datasets.detail.meta.collection"), String(m.sourceCollection ?? "—")),
    metaTile(t("datasets.detail.meta.format"), String(m.format ?? "—")),
    metaTile(
      t("datasets.detail.meta.method"),
      m.method === "llm-synth"
        ? `${t("datasets.method.synth")}${m.model ? " · " + m.model : ""}`
        : t("datasets.method.template"),
    ),
    metaTile(
      t("datasets.detail.meta.lines"),
      `${Number(m.trainLines ?? 0)} / ${Number(m.valLines ?? 0)}`,
    ),
    metaTile(t("datasets.detail.meta.concepts"), String(Number(m.concepts ?? 0))),
    metaTile(t("datasets.detail.meta.created"), formatDate(String(m.generatedAt ?? ""))),
  ]);

  const fileTabs = el(
    "div",
    { class: "ds-detail-tabs" },
    STATE.previewFiles
      .filter((f) => f.name.endsWith(".jsonl"))
      .map((f) =>
        el(
          "button",
          {
            class: `ds-detail-tab${STATE.previewFile === f.name ? " ds-detail-tab-active" : ""}`,
            type: "button",
            onclick: () => loadPreviewFile(root, f.name),
          },
          [
            el("span", { class: "ds-detail-tab-name" }, f.name),
            el("span", { class: "ds-detail-tab-meta" }, `${f.lines ?? "?"} · ${formatSize(f.sizeBytes)}`),
          ],
        ),
      ),
  );

  const search = el("input", {
    class: "ds-detail-search",
    type: "search",
    placeholder: t("datasets.detail.searchPlaceholder"),
    value: STATE.previewQuery,
    oninput: (e) => {
      STATE.previewQuery = String(/** @type {HTMLInputElement} */ (e.target).value || "");
      renderDetail(root);
    },
  });

  const previewBody = el("div", { class: "ds-preview" });
  const q = STATE.previewQuery.trim().toLowerCase();

  if (STATE.loading) {
    previewBody.appendChild(
      el("div", { class: "ds-preview-loading" }, t("datasets.detail.loading")),
    );
  } else if (STATE.preview.length === 0) {
    previewBody.appendChild(
      el("div", { class: "ds-preview-empty" }, t("datasets.detail.noPreview")),
    );
  } else {
    const filtered = q
      ? STATE.preview.filter((line) => line.raw.toLowerCase().includes(q))
      : STATE.preview;

    if (filtered.length === 0) {
      previewBody.appendChild(
        el("div", { class: "ds-preview-empty" }, t("datasets.detail.searchNoMatch")),
      );
    } else {
      filtered.forEach((line, idx) => {
        previewBody.appendChild(buildPreviewItem(idx + 1, line));
      });
    }
  }

  wrap.append(header, metaTiles, fileTabs, search, previewBody);
}

function buildPreviewItem(num, line) {
  const parsed = line.parsed;
  if (!parsed || typeof parsed !== "object") {
    return el("article", { class: "ds-preview-item ds-preview-item-raw" }, [
      el("div", { class: "ds-preview-num" }, `#${num}`),
      el("pre", { class: "ds-preview-raw" }, line.raw.slice(0, 1500)),
    ]);
  }

  /** @type {Array<{role: string, text: string}>} */
  const turns = [];
  if (Array.isArray(parsed.conversations)) {
    for (const c of parsed.conversations) {
      turns.push({
        role: roleLabel(String(c?.from ?? "")),
        text: String(c?.value ?? ""),
      });
    }
  } else if (Array.isArray(parsed.messages)) {
    for (const m of parsed.messages) {
      turns.push({
        role: roleLabel(String(m?.role ?? "")),
        text: String(m?.content ?? ""),
      });
    }
  }

  const meta = parsed.meta && typeof parsed.meta === "object" ? parsed.meta : null;

  return el("article", { class: "ds-preview-item" }, [
    el("div", { class: "ds-preview-item-head" }, [
      el("div", { class: "ds-preview-num" }, `#${num}`),
      meta && meta.domain
        ? el("div", { class: "ds-preview-domain" }, String(meta.domain))
        : null,
      meta && meta.synthesized
        ? el("div", { class: "ds-preview-tag ds-preview-tag-synth" }, t("datasets.method.synth"))
        : null,
    ]),
    ...turns.map((tn) =>
      el("div", { class: `ds-preview-turn ds-preview-role-${roleClass(tn.role)}` }, [
        el("div", { class: "ds-preview-turn-role" }, tn.role),
        el("div", { class: "ds-preview-turn-text" }, tn.text),
      ]),
    ),
  ]);
}

function roleLabel(raw) {
  const r = raw.toLowerCase();
  if (r === "system") return t("datasets.role.system");
  if (r === "human" || r === "user") return t("datasets.role.user");
  if (r === "gpt" || r === "assistant") return t("datasets.role.assistant");
  return raw || "?";
}

function roleClass(label) {
  return label
    .toLowerCase()
    .replace(/[^a-zа-я0-9]+/gi, "-")
    .replace(/^-|-$/g, "")
    || "any";
}

function metaTile(label, value) {
  return el("div", { class: "ds-detail-meta-tile" }, [
    el("div", { class: "ds-detail-meta-label" }, label),
    el("div", { class: "ds-detail-meta-value" }, value),
  ]);
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Mount                                                                       */
/* ────────────────────────────────────────────────────────────────────────── */

export function mountDatasets(root) {
  if (!root) return;
  if (root.dataset.mounted === "1") {
    /* refresh history on revisit */
    STATE.records = loadHistory();
    renderListBody(root);
    return;
  }
  root.dataset.mounted = "1";
  clear(root);

  STATE.records = loadHistory();

  const layout = el("div", { class: "ds-list-page" }, [
    buildTopBar(root),
    el("div", { class: "ds-list-grid" }, [
      buildList(),
      el("div", { class: "ds-detail", id: "ds-detail" }),
    ]),
    /* Hybrid Search Panel — поиск по любой Qdrant-коллекции через
       searchSmart (auto-detect: hybrid если коллекция поддерживает,
       иначе dense+rerank). Доказательство end-to-end. */
    buildHybridSearchPanel(),
  ]);
  root.append(layout);

  renderListBody(root);

  if (unsubHistory) unsubHistory();
  unsubHistory = onHistoryChange((records) => {
    STATE.records = records;
    renderListBody(root);
  });
}
