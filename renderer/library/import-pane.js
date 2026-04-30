// @ts-check
/**
 * Import pane: folder/file import with live progress and evaluator panel.
 */
import { el, clear } from "../dom.js";
import { t } from "../i18n.js";
import { IMPORT_STATE } from "./state.js";
import { buildEvaluatorPanel, refreshEvaluatorState } from "./evaluator.js";
import { refreshCollectionViews } from "./collection-views.js";
import { showLibraryToast } from "./toast.js";
import { showAlert } from "../components/ui-dialog.js";

const LOG_RING_SIZE = 1000;
const LOG_LEVEL_PRIORITY = { debug: 0, info: 1, warn: 2, error: 3 };

/** @type {{level: string, category: string, ts: string, message: string, file?: string, details?: Record<string, unknown>, durationMs?: number, importId?: string}[]} */
const LOG_RING = [];
let LOG_FILTER_LEVEL = "info";
let LOG_PANEL_REF = null;

/**
 * @param {object} deps
 * @param {(root: HTMLElement) => Promise<void>} deps.renderCatalog
 * @param {(bookId: string) => Promise<void> | void} [deps.focusCatalogBook]
 * @returns {HTMLElement}
 */
export function buildImportPane(deps) {
  const archiveCb = /** @type {HTMLInputElement} */ (el("input", {
    type: "checkbox",
    class: "lib-import-cb",
    checked: IMPORT_STATE.scanArchives ? "checked" : undefined,
  }));
  archiveCb.addEventListener("change", () => { IMPORT_STATE.scanArchives = archiveCb.checked; });
  const recursiveCb = /** @type {HTMLInputElement} */ (el("input", {
    type: "checkbox",
    class: "lib-import-cb",
    checked: IMPORT_STATE.recursive ? "checked" : undefined,
  }));
  recursiveCb.addEventListener("change", () => { IMPORT_STATE.recursive = recursiveCb.checked; });

  const pickFolderBtn = el("button", {
    type: "button",
    class: "lib-btn lib-btn-primary lib-import-pick-folder",
    onclick: () => importFromFolder(deps),
  }, t("library.import.btn.pickFolder"));

  const pickFilesBtn = el("button", {
    type: "button",
    class: "lib-btn lib-import-pick-files",
    onclick: () => importFromFiles(deps),
  }, t("library.import.btn.pickFiles"));

  const bundleBtn = el("button", {
    type: "button",
    class: "lib-btn lib-import-pick-bundle",
    title: t("library.import.btn.bundleHint"),
    onclick: () => importFolderAsBundle(deps),
  }, t("library.import.btn.bundle"));

  const pauseBtn = el("button", {
    type: "button",
    class: "lib-btn lib-import-pause",
    style: "display:none",
    onclick: async () => {
      const isPaused = pauseBtn.dataset.paused === "1";
      try {
        if (isPaused) {
          await window.api.library.evaluatorResume();
          pauseBtn.dataset.paused = "0";
          pauseBtn.textContent = t("library.import.btn.pause");
        } else {
          await window.api.library.evaluatorPause();
          pauseBtn.dataset.paused = "1";
          pauseBtn.textContent = t("library.import.btn.resume");
        }
      } catch (_e) { console.warn("[import] pause/resume failed:", _e); }
    },
  }, t("library.import.btn.pause"));

  const cancelBtn = el("button", {
    type: "button",
    class: "lib-btn lib-import-cancel",
    style: "display:none",
    onclick: async () => {
      if (IMPORT_STATE.importId) {
        try { await window.api.library.cancelImport(IMPORT_STATE.importId); }
        catch (_e) {
          console.warn("[import] cancelImport failed:", _e);
          showLibraryToast({ kind: "error", message: t("library.import.cancelFailed") });
        }
      }
    },
  }, t("library.import.btn.cancel"));

  const opts = el("div", { class: "lib-import-opts" }, [
    el("label", { class: "lib-import-opt", title: t("library.import.opt.tooltip.scanArchives") }, [
      archiveCb, t("library.import.opt.scanArchives"),
    ]),
    el("label", { class: "lib-import-opt" }, [
      recursiveCb, t("library.import.opt.recursive"),
    ]),
  ]);

  const dropzone = el("div", {
    class: "lib-import-dropzone",
    role: "button",
    tabindex: "0",
    "aria-label": t("library.import.dropzone.title"),
    onclick: () => importFromFiles(deps),
    onkeydown: (ev) => {
      if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); importFromFiles(deps); }
    },
  }, [
    el("div", { class: "lib-import-dropzone-icon", "aria-hidden": "true" }, "+"),
    el("div", { class: "lib-import-dropzone-title" }, t("library.import.dropzone.title")),
    el("div", { class: "lib-import-dropzone-hint" }, t("library.import.dropzone.hint")),
  ]);
  installImportDropHandlers(dropzone, deps);

  const status = el("div", { class: "lib-import-status", "aria-live": "polite" }, "");
  const logPanel = buildLogPanel();

  const evaluatorPanel = buildEvaluatorPanel();

  const scanBtn = el("button", {
    type: "button",
    class: "lib-btn lib-import-scan-folder",
    onclick: () => scanFolderForDuplicates(status, scanReportContainer),
  }, t("library.import.btn.scanFolder"));

  const scanReportContainer = el("div", { class: "lib-scan-report" });

  const body = el("div", { class: "lib-import-body" }, [
    dropzone,
    el("div", { class: "lib-import-actions" }, [pickFolderBtn, pickFilesBtn, bundleBtn, scanBtn, pauseBtn, cancelBtn]),
    opts,
    status,
    logPanel,
    scanReportContainer,
    evaluatorPanel,
  ]);

  return el("div", { class: "lib-pane lib-pane-import" }, [body]);
}

/** @param {HTMLElement} root */
export function renderImport(root) {
  void refreshEvaluatorState(root);
  /* При открытии вкладки тянем snapshot лога — даже если импорт не идёт сейчас,
     юзер увидит, что было в прошлой сессии (включая краш-причины). */
  void hydrateLogSnapshot();
}

/**
 * Real-time лог-панель: скроллируемый список событий с фильтром по уровню,
 * счётчиком ошибок/предупреждений и кнопками Clear/Copy.
 * Подписывается на `onImportLog` единожды (модульный flag), чтобы повторный
 * рендер не плодил listener'ов.
 *
 * @returns {HTMLElement}
 */
function buildLogPanel() {
  if (LOG_PANEL_REF) return LOG_PANEL_REF;

  const counterErr = el("span", { class: "lib-import-log-counter lib-import-log-counter-err", title: t("library.import.log.counter.errors") }, "0");
  const counterWarn = el("span", { class: "lib-import-log-counter lib-import-log-counter-warn", title: t("library.import.log.counter.warnings") }, "0");
  const counterInfo = el("span", { class: "lib-import-log-counter lib-import-log-counter-info", title: t("library.import.log.counter.info") }, "0");
  const counterDup = el("span", { class: "lib-import-log-counter lib-import-log-counter-dup", title: t("library.import.log.counter.duplicates") }, "0");
  const counterSkip = el("span", { class: "lib-import-log-counter lib-import-log-counter-skip", title: t("library.import.log.counter.skipped") }, "0");

  const filterSelect = /** @type {HTMLSelectElement} */ (el("select", {
    class: "lib-import-log-filter",
    title: t("library.import.log.filterTooltip"),
  }, [
    el("option", { value: "debug" }, t("library.import.log.filter.debug")),
    el("option", { value: "info", selected: "selected" }, t("library.import.log.filter.info")),
    el("option", { value: "warn" }, t("library.import.log.filter.warn")),
    el("option", { value: "error" }, t("library.import.log.filter.error")),
  ]));
  filterSelect.addEventListener("change", () => {
    LOG_FILTER_LEVEL = filterSelect.value;
    rerenderLogList();
  });

  const clearBtn = el("button", {
    type: "button",
    class: "lib-btn lib-btn-ghost lib-import-log-btn",
    onclick: () => {
      LOG_RING.length = 0;
      rerenderLogList();
      updateCounters();
    },
  }, t("library.import.log.clear") || "Clear");

  const copyBtn = el("button", {
    type: "button",
    class: "lib-btn lib-btn-ghost lib-import-log-btn",
    title: t("library.import.log.copyTooltip"),
    onclick: async () => {
      /* Copy ровно то, что видит пользователь (после фильтра по уровню) +
         поля details для каждой строки. Раньше Copy сбрасывал весь буфер
         включая скрытые debug-записи — пользователь получал не то, что на
         экране. */
      const visible = LOG_RING.filter(entryPassesFilter);
      const text = visible.map((e) => formatLogLineForCopy(e)).join("\n");
      try {
        await navigator.clipboard.writeText(text);
      } catch (err) {
        await showAlert(t("library.import.log.copyFailed", {
          msg: err instanceof Error ? err.message : String(err),
        }));
      }
    },
  }, t("library.import.log.copy"));

  const header = el("div", { class: "lib-import-log-header" }, [
    el("span", { class: "lib-import-log-title" }, t("library.import.log.title")),
    counterErr,
    counterWarn,
    counterInfo,
    counterDup,
    counterSkip,
    el("span", { class: "lib-import-log-spacer" }),
    filterSelect,
    clearBtn,
    copyBtn,
  ]);

  const list = el("div", { class: "lib-import-log-list", "aria-live": "polite" });

  const panel = el("div", { class: "lib-import-log-panel" }, [header, list]);

  LOG_PANEL_REF = panel;
  /** @type {any} */ (panel)._counterErr = counterErr;
  /** @type {any} */ (panel)._counterWarn = counterWarn;
  /** @type {any} */ (panel)._counterInfo = counterInfo;
  /** @type {any} */ (panel)._counterDup = counterDup;
  /** @type {any} */ (panel)._counterSkip = counterSkip;
  /** @type {any} */ (panel)._list = list;

  if (typeof window.api?.library?.onImportLog === "function") {
    window.api.library.onImportLog((entry) => pushLogEntry(entry));
  }

  return panel;
}

async function hydrateLogSnapshot() {
  if (typeof window.api?.library?.importLogSnapshot !== "function") return;
  try {
    const snap = await window.api.library.importLogSnapshot();
    if (Array.isArray(snap) && snap.length > 0) {
      LOG_RING.length = 0;
      for (const e of snap) LOG_RING.push(e);
      rerenderLogList();
      updateCounters();
    }
  } catch (_e) { /* tolerate: snapshot is best-effort */ }
}

/** @param {{level: string, category: string, ts: string, message: string, file?: string, details?: any}} entry */
function pushLogEntry(entry) {
  LOG_RING.push(entry);
  if (LOG_RING.length > LOG_RING_SIZE) LOG_RING.shift();
  updateCounters();
  if (entryPassesFilter(entry)) appendLogRow(entry);
}

/**
 * Запись в панель лога Import без main-process IPC (dataset-v2 extraction и т.п.).
 * @param {{level: string, category: string, ts?: string, message: string, file?: string, details?: any}} entry
 */
export function pushImportPaneLog(entry) {
  pushLogEntry({
    level: entry.level,
    category: entry.category,
    ts: entry.ts ?? new Date().toISOString(),
    message: entry.message,
    file: entry.file,
    details: entry.details,
  });
}

/** @param {{level: string}} entry */
function entryPassesFilter(entry) {
  const want = LOG_LEVEL_PRIORITY[/** @type {keyof typeof LOG_LEVEL_PRIORITY} */ (LOG_FILTER_LEVEL)] ?? 1;
  const have = LOG_LEVEL_PRIORITY[/** @type {keyof typeof LOG_LEVEL_PRIORITY} */ (entry.level)] ?? 1;
  return have >= want;
}

function rerenderLogList() {
  if (!LOG_PANEL_REF) return;
  const list = /** @type {HTMLElement} */ (/** @type {any} */ (LOG_PANEL_REF)._list);
  if (!list) return;
  clear(list);
  for (const entry of LOG_RING) {
    if (entryPassesFilter(entry)) appendLogRow(entry);
  }
}

/** @param {{level: string, category: string, ts: string, message: string, file?: string, details?: any, durationMs?: number, importId?: string}} entry */
function appendLogRow(entry) {
  if (!LOG_PANEL_REF) return;
  const list = /** @type {HTMLElement} */ (/** @type {any} */ (LOG_PANEL_REF)._list);
  if (!list) return;

  const time = entry.ts.slice(11, 19); /* HH:MM:SS из ISO-8601 */
  const fileLabel = entry.file ? trimFile(entry.file) : "";
  const hasDetails = hasMeaningfulDetails(entry);

  const expandToggle = hasDetails
    ? el("span", {
      class: "lib-import-log-expand",
      title: t("library.import.log.expand"),
      "aria-label": t("library.import.log.expand"),
    }, "▸")
    : null;

  const headerRow = el("div", { class: "lib-import-log-row-head" }, [
    expandToggle,
    el("span", { class: "lib-import-log-time" }, time),
    el("span", { class: "lib-import-log-cat" }, entry.category),
    el("span", { class: "lib-import-log-msg", title: entry.message }, entry.message),
    typeof entry.durationMs === "number"
      ? el("span", { class: "lib-import-log-duration", title: `${entry.durationMs} ms` }, formatDuration(entry.durationMs))
      : null,
    fileLabel ? el("span", { class: "lib-import-log-file", title: entry.file }, fileLabel) : null,
  ].filter(Boolean));

  const row = el("div", {
    class: `lib-import-log-row lib-import-log-${entry.level}${hasDetails ? " lib-import-log-row-expandable" : ""}`,
    /* Двойной клик копирует одну строку — без контекстного меню для скорости. */
    ondblclick: async () => {
      try { await navigator.clipboard.writeText(formatLogLineForCopy(entry)); } catch { /* swallow */ }
    },
  }, [headerRow]);

  if (hasDetails && expandToggle) {
    /* Expand-collapse: клик по голове разворачивает блок details. JSON.stringify
       с indent=2 — компактно для warnings array и читаемо для structured payload. */
    headerRow.addEventListener("click", (ev) => {
      /* Игнорируем клик по самой иконке файла (для UX hover'а), но кликом
         в любую другую часть headerRow тоглим. */
      if ((ev.target instanceof HTMLElement) && ev.target.classList.contains("lib-import-log-file")) return;
      const expanded = row.classList.toggle("lib-import-log-expanded");
      expandToggle.textContent = expanded ? "▾" : "▸";
      const existing = row.querySelector(".lib-import-log-details");
      if (expanded && !existing) {
        const block = el("pre", { class: "lib-import-log-details" }, formatDetailsForDisplay(entry));
        row.appendChild(block);
      } else if (!expanded && existing) {
        existing.remove();
      }
    });
  }

  list.appendChild(row);
  /* Авто-скролл вниз только если пользователь не отскроллился вверх */
  const distanceFromBottom = list.scrollHeight - list.scrollTop - list.clientHeight;
  if (distanceFromBottom < 40) list.scrollTop = list.scrollHeight;
}

/**
 * Содержит ли запись details, которые стоит показать пользователю?
 * Пустой `{}`, `{ progress: '5/42' }` (только счётчик) — не считаем.
 * @param {{details?: any, durationMs?: number}} entry
 */
function hasMeaningfulDetails(entry) {
  if (typeof entry.durationMs === "number" && entry.durationMs > 0) return true;
  const d = entry.details;
  if (!d || typeof d !== "object") return false;
  const keys = Object.keys(d);
  if (keys.length === 0) return false;
  /* progress — это технический счётчик ("5/42"), не интересен в развёрнутом виде. */
  if (keys.length === 1 && keys[0] === "progress") return false;
  return true;
}

/**
 * Преобразует details в читаемый блок для expand. warnings — построчно
 * вверху (это самое важное), остальные поля — JSON в конце.
 * @param {{details?: any, durationMs?: number, importId?: string, file?: string}} entry
 */
function formatDetailsForDisplay(entry) {
  const lines = [];
  const d = entry.details ?? {};
  if (Array.isArray(d.warnings) && d.warnings.length > 0) {
    lines.push(t("library.import.log.detailsWarnings"));
    for (const w of d.warnings) lines.push(`  • ${w}`);
  }
  if (typeof d.errorMessage === "string" && d.errorMessage) {
    lines.push(`${t("library.import.log.detailsError")}: ${d.errorMessage}`);
  }
  if (typeof d.duplicateReason === "string") {
    lines.push(`${t("library.import.log.detailsDuplicateReason")}: ${d.duplicateReason}`);
  }
  if (typeof entry.durationMs === "number" && entry.durationMs > 0) {
    lines.push(`${t("library.import.log.detailsDuration")}: ${entry.durationMs} ms`);
  }
  if (entry.file) lines.push(`${t("library.import.log.detailsFile")}: ${entry.file}`);
  if (entry.importId) lines.push(`${t("library.import.log.detailsImportId")}: ${entry.importId}`);
  /* Остаток payload без уже выведенных полей и системного "progress". */
  const skip = new Set(["warnings", "errorMessage", "duplicateReason", "progress"]);
  const rest = Object.fromEntries(Object.entries(d).filter(([k]) => !skip.has(k)));
  if (Object.keys(rest).length > 0) {
    lines.push("");
    lines.push(JSON.stringify(rest, null, 2));
  }
  return lines.join("\n");
}

/**
 * Форматирует одну запись для буфера обмена. Многострочный формат с details
 * — иначе вставка в issue-tracker теряет половину контекста.
 * @param {{level: string, category: string, ts: string, message: string, file?: string, details?: any, durationMs?: number, importId?: string}} entry
 */
function formatLogLineForCopy(entry) {
  const head = `[${entry.ts}] [${entry.level.toUpperCase()}] [${entry.category}] ${entry.message}`;
  const parts = [head];
  if (entry.file) parts.push(`  file: ${entry.file}`);
  if (typeof entry.durationMs === "number") parts.push(`  durationMs: ${entry.durationMs}`);
  if (entry.importId) parts.push(`  importId: ${entry.importId}`);
  if (entry.details && typeof entry.details === "object") {
    const d = entry.details;
    if (Array.isArray(d.warnings) && d.warnings.length > 0) {
      parts.push("  warnings:");
      for (const w of d.warnings) parts.push(`    - ${w}`);
    }
    if (typeof d.errorMessage === "string" && d.errorMessage) {
      parts.push(`  errorMessage: ${d.errorMessage}`);
    }
  }
  return parts.join("\n");
}

/** @param {number} ms */
function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60_000)}m`;
}

/** @param {string} p */
function trimFile(p) {
  const idx = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  return idx >= 0 ? p.slice(idx + 1) : p;
}

function updateCounters() {
  if (!LOG_PANEL_REF) return;
  const ce = /** @type {HTMLElement} */ (/** @type {any} */ (LOG_PANEL_REF)._counterErr);
  const cw = /** @type {HTMLElement} */ (/** @type {any} */ (LOG_PANEL_REF)._counterWarn);
  const ci = /** @type {HTMLElement} */ (/** @type {any} */ (LOG_PANEL_REF)._counterInfo);
  const cd = /** @type {HTMLElement} */ (/** @type {any} */ (LOG_PANEL_REF)._counterDup);
  const cs = /** @type {HTMLElement} */ (/** @type {any} */ (LOG_PANEL_REF)._counterSkip);
  let e = 0; let w = 0; let i = 0; let dup = 0; let skip = 0;
  for (const entry of LOG_RING) {
    if (entry.level === "error") e++;
    else if (entry.level === "warn") w++;
    else if (entry.level === "info") i++;
    /* Категории-добавки: дубли и пропуски часто важнее общего "info", их
       полезно видеть отдельно при разборе большого импорта. */
    if (entry.category === "file.duplicate") dup++;
    if (entry.category === "file.skipped") skip++;
  }
  if (ce) ce.textContent = String(e);
  if (cw) cw.textContent = String(w);
  if (ci) ci.textContent = String(i);
  if (cd) cd.textContent = String(dup);
  if (cs) cs.textContent = String(skip);
}

/** @param {object} deps */
async function importFromFolder(deps) {
  if (IMPORT_STATE.busy) return;
  /** @type {string|null} */
  let folderPath = null;
  try { folderPath = await window.api.library.pickFolder(); } catch (_e) {
    console.warn("[import] pickFolder failed:", _e);
    showLibraryToast({ kind: "error", message: t("library.import.pickFolderFailed") });
    folderPath = null;
  }
  if (!folderPath) return;
  await runImport(async () =>
    window.api.library.importFolder({
      folder: folderPath,
      scanArchives: IMPORT_STATE.scanArchives,
      maxDepth: IMPORT_STATE.recursive ? 16 : 0,
    }),
    deps,
  );
}

/**
 * Импорт ВСЕЙ папки как «комплекта»: книга + иллюстрации + код + сайты.
 * Использует scanner:start-folder-bundle (LLM описывает sidecars, всё
 * сшивается в один Markdown и грузится одним документом).
 *
 * @param {object} _deps
 */
async function importFolderAsBundle(_deps) {
  if (IMPORT_STATE.busy) return;
  if (!window.api?.scanner?.startFolderBundle) {
    showLibraryToast({ kind: "error", message: t("library.bundle.unavailable") });
    return;
  }
  let folderPath = null;
  try { folderPath = await window.api.library.pickFolder(); } catch (_e) {
    console.warn("[import] bundle pickFolder failed:", _e);
    showLibraryToast({ kind: "error", message: t("library.import.pickFolderFailed") });
    return;
  }
  if (!folderPath) return;

  const collection = window.prompt(t("library.bundle.collectionPrompt"), "default");
  if (!collection) return;

  const status = document.querySelector(".lib-import-status");
  const setStatus = (text) => { if (status) status.textContent = text; };

  let unsub = null;
  try {
    setStatus(t("library.bundle.starting"));
    if (typeof window.api.scanner.onBundleProgress === "function") {
      unsub = window.api.scanner.onBundleProgress((p) => {
        if (!p || typeof p !== "object") return;
        const phase = String(p.phase || "");
        if (phase === "discover") setStatus(t("library.bundle.phase.discover"));
        else if (phase === "describe") {
          if (p.event && p.event.type === "describe.file.done") {
            setStatus(t("library.bundle.phase.describing", { file: String(p.event.absPath || "").split(/[\\/]/).pop() }));
          } else if (typeof p.sidecarsTotal === "number") {
            setStatus(t("library.bundle.phase.describeStart", { total: p.sidecarsTotal }));
          }
        }
        else if (phase === "parse-book") setStatus(t("library.bundle.phase.parseBook", { file: String(p.file || "") }));
        else if (phase === "ingest") setStatus(t("library.bundle.phase.ingest"));
      });
    }
    const r = await window.api.scanner.startFolderBundle({ folderPath, collection });
    const stats = r?.bundleStats;
    setStatus(t("library.bundle.done", {
      sidecars: stats?.sidecars ?? 0,
      described: stats?.described ?? 0,
      warnings: stats?.warnings?.length ?? 0,
    }));
    showLibraryToast({ kind: "success", message: t("library.bundle.successToast") });
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    setStatus(t("library.bundle.failed", { reason }));
    showLibraryToast({ kind: "error", message: t("library.bundle.failed", { reason }) });
  } finally {
    if (typeof unsub === "function") unsub();
  }
}

/** @param {object} deps */
async function importFromFiles(deps) {
  if (IMPORT_STATE.busy) return;
  /** @type {string[]} */
  let paths = [];
  try {
    const r = /** @type {any} */ (await window.api.library.pickFiles());
    paths = Array.isArray(r) ? r : (r?.paths ?? []);
  } catch (_e) {
    console.warn("[import] pickFiles failed:", _e);
    showLibraryToast({ kind: "error", message: t("library.import.pickFilesFailed") });
    paths = [];
  }
  if (paths.length === 0) return;
  await runImport(async () =>
    window.api.library.importFiles({
      paths,
      scanArchives: IMPORT_STATE.scanArchives,
    }),
    deps,
  );
}

/**
 * @param {() => Promise<any>} invoke
 * @param {object} deps
 */
async function runImport(invoke, deps) {
  const root = document.getElementById("library-root");
  if (!root) return;
  const status = root.querySelector(".lib-import-status");
  const cancelBtn = /** @type {HTMLElement|null} */ (root.querySelector(".lib-import-cancel"));
  const pauseBtn = /** @type {HTMLElement|null} */ (root.querySelector(".lib-import-pause"));
  IMPORT_STATE.busy = true;
  if (cancelBtn) cancelBtn.style.display = "";
  if (pauseBtn) { pauseBtn.style.display = ""; pauseBtn.dataset.paused = "0"; pauseBtn.textContent = t("library.import.btn.pause"); }
  if (status) status.textContent = t("library.import.progress.starting");
  let unsubscribeProgress = null;
  try {
    if (typeof window.api?.library?.onImportProgress === "function") {
      unsubscribeProgress = window.api.library.onImportProgress((evt) => {
        if (!status) return;
        if (evt?.importId && !IMPORT_STATE.importId) {
          IMPORT_STATE.importId = evt.importId;
        }
        const discovered = Number(evt?.discovered ?? 0);
        const processed = Number(evt?.processed ?? 0);
        if (evt?.phase === "file-start") {
          const file = String(evt?.currentFile || "").split(/[\\/]/).pop() || t("library.import.progress.unknownFile");
          status.textContent = t("library.import.progress.processing", {
            file,
            done: String(processed),
            total: String(Math.max(discovered, processed)),
          });
        } else if (evt?.phase === "processed") {
          status.textContent = t("library.import.progress.copying", {
            done: String(processed),
            total: String(Math.max(discovered, processed)),
          });
          if (evt?.outcome === "duplicate" && evt?.existingBookId) {
            const msgKey = evt?.duplicateReason === "duplicate_older_revision"
              ? "library.import.toast.duplicateOlder"
              : "library.import.toast.duplicateSha";
            showLibraryToast({
              kind: "info",
              message: t(msgKey, {
                title: evt.existingBookTitle || evt.existingBookId,
              }),
              actionLabel: t("library.import.toast.openCatalog"),
              onAction: () => deps.focusCatalogBook?.(evt.existingBookId),
              dedupeKey: `${evt.duplicateReason || "duplicate"}:${evt.existingBookId}`,
            });
          }
        } else {
          status.textContent = t("library.import.progress.scanning", {
            found: String(discovered),
          });
        }
      });
    }
    const res = await invoke();
    IMPORT_STATE.importId = res.importId || null;
    if (status) status.textContent = t("library.import.progress.done", {
      added: String(res.added ?? 0),
      skipped: String((res.skipped ?? 0) + (res.duplicate ?? 0) + (res.failed ?? 0)),
    });
    void deps.renderCatalog(root);
    refreshCollectionViews();
  } catch (e) {
    if (status) status.textContent = t("library.import.progress.failed", {
      error: e instanceof Error ? e.message : String(e),
    });
  } finally {
    if (typeof unsubscribeProgress === "function") {
      try { unsubscribeProgress(); } catch (_e) { /* tolerate: listener cleanup */ }
    }
    IMPORT_STATE.busy = false;
    IMPORT_STATE.importId = null;
    if (cancelBtn) cancelBtn.style.display = "none";
    if (pauseBtn) { pauseBtn.style.display = "none"; pauseBtn.dataset.paused = "0"; }
    try { await window.api.library.evaluatorResume(); } catch (_e) { /* resume on cleanup is best-effort */ }
  }
}

/**
 * @param {HTMLElement} dropzone
 * @param {object} deps
 */
function installImportDropHandlers(dropzone, deps) {
  const stop = (/** @type {DragEvent} */ ev) => {
    ev.preventDefault();
    ev.stopPropagation();
  };

  for (const evName of ["dragenter", "dragover"]) {
    dropzone.addEventListener(evName, (ev) => {
      stop(/** @type {DragEvent} */ (ev));
      dropzone.classList.add("lib-import-dropzone-active");
    });
  }
  for (const evName of ["dragleave", "drop"]) {
    dropzone.addEventListener(evName, (ev) => {
      stop(/** @type {DragEvent} */ (ev));
      dropzone.classList.remove("lib-import-dropzone-active");
    });
  }

  dropzone.addEventListener("drop", async (ev) => {
    const entries = collectDroppedEntries(/** @type {DragEvent} */ (ev));
    if (entries.length === 0) return;
    await runImport(() => importDroppedEntries(entries), deps);
  });
}

/**
 * @param {DragEvent} ev
 * @returns {{path: string; isDirectory: boolean}[]}
 */
function collectDroppedEntries(ev) {
  /** @type {{path: string; isDirectory: boolean}[]} */
  const entries = [];
  const seen = new Set();
  const items = ev.dataTransfer?.items;
  if (items && items.length > 0) {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const file = item.getAsFile?.();
      const filePath = file?.path;
      if (!filePath || seen.has(filePath)) continue;
      const entry = item.webkitGetAsEntry?.();
      entries.push({ path: filePath, isDirectory: entry?.isDirectory === true });
      seen.add(filePath);
    }
  }
  const files = ev.dataTransfer?.files;
  if (files) {
    for (let i = 0; i < files.length; i++) {
      const filePath = files[i].path;
      if (!filePath || seen.has(filePath)) continue;
      entries.push({ path: filePath, isDirectory: false });
      seen.add(filePath);
    }
  }
  return entries;
}

/** @param {{path: string; isDirectory: boolean}[]} entries */
async function importDroppedEntries(entries) {
  const files = entries.filter((e) => !e.isDirectory).map((e) => e.path);
  const dirs = entries.filter((e) => e.isDirectory).map((e) => e.path);
  const total = { importId: null, added: 0, skipped: 0, duplicate: 0, failed: 0 };
  const merge = (/** @type {any} */ res) => {
    if (!res) return;
    total.importId = res.importId || total.importId;
    total.added += Number(res.added ?? 0);
    total.skipped += Number(res.skipped ?? 0);
    total.duplicate += Number(res.duplicate ?? 0);
    total.failed += Number(res.failed ?? 0);
  };

  if (files.length > 0) {
    merge(await window.api.library.importFiles({
      paths: files,
      scanArchives: IMPORT_STATE.scanArchives,
    }));
  }
  for (const folder of dirs) {
    merge(await window.api.library.importFolder({
      folder,
      scanArchives: IMPORT_STATE.scanArchives,
      maxDepth: IMPORT_STATE.recursive ? 16 : 0,
    }));
  }
  return total;
}

/**
 * @param {HTMLElement} statusEl
 * @param {HTMLElement} reportContainer
 */
async function scanFolderForDuplicates(statusEl, reportContainer) {
  if (IMPORT_STATE.busy) return;

  /** @type {string|null} */
  let folderPath = null;
  try {
    folderPath = await window.api.library.pickFolder();
  } catch (_e) {
    console.warn("[scan] pickFolder failed:", _e);
    showLibraryToast({ kind: "error", message: t("library.import.pickFolderFailed") });
  }
  if (!folderPath) return;

  IMPORT_STATE.busy = true;
  statusEl.textContent = t("library.import.scan.starting");
  reportContainer.innerHTML = "";

  let scanId = "";
  /** @type {(() => void)|null} */
  let unsubProgress = null;
  /** @type {(() => void)|null} */
  let unsubReport = null;

  const cleanup = () => {
    if (typeof unsubProgress === "function") { try { unsubProgress(); } catch (_e) { /* */ } }
    if (typeof unsubReport === "function") { try { unsubReport(); } catch (_e) { /* */ } }
    unsubProgress = null;
    unsubReport = null;
    IMPORT_STATE.busy = false;
  };

  unsubProgress = window.api.library.onScanProgress((evt) => {
    if (scanId && evt.scanId !== scanId) return;
    if (evt.phase === "walking") {
      statusEl.textContent = t("library.import.scan.walking", {
        n: String(evt.bookFilesFound),
      });
    } else if (evt.phase === "metadata") {
      statusEl.textContent = t("library.import.scan.metadata", {
        done: String(evt.scannedFiles),
        total: String(evt.totalFiles),
      });
    } else if (evt.phase === "dedup") {
      statusEl.textContent = t("library.import.scan.dedup");
    }
  });

  unsubReport = window.api.library.onScanReport((payload) => {
    if (scanId && payload.scanId !== scanId) return;
    if (payload.error) {
      statusEl.textContent = t("library.import.scan.failed", { msg: payload.error });
    } else {
      statusEl.textContent = "";
      renderScanReport(/** @type {any} */ (payload.report), reportContainer);
    }
    cleanup();
  });

  try {
    const res = await window.api.library.scanFolder(folderPath);
    scanId = res.scanId;
  } catch (e) {
    statusEl.textContent = t("library.import.scan.error", {
      msg: e instanceof Error ? e.message : String(e),
    });
    cleanup();
  }
}

/**
 * @param {any} report
 * @param {HTMLElement} container
 */
function renderScanReport(report, container) {
  container.innerHTML = "";
  if (!report) return;

  const summary = el("div", { class: "lib-scan-summary" }, [
    el("div", { class: "lib-scan-stat" }, t("library.import.scan.report.books", { n: String(report.bookFiles) })),
    el("div", { class: "lib-scan-stat" }, t("library.import.scan.report.exact", { n: String(report.exactDuplicates) })),
    el("div", { class: "lib-scan-stat" }, t("library.import.scan.report.format", { n: String(report.formatDuplicates) })),
    el("div", { class: "lib-scan-stat" }, t("library.import.scan.report.fuzzy", { n: String(report.fuzzyMatches?.length ?? 0) })),
    el("div", { class: "lib-scan-stat lib-scan-stat-highlight" }, t("library.import.scan.report.unique", { n: String(report.uniqueBooks) })),
  ]);
  container.appendChild(summary);

  if (report.editionGroups && report.editionGroups.length > 0) {
    const edTitle = el("div", { class: "lib-scan-section-title" },
      t("library.import.scan.report.editions", { n: String(report.editionGroups.length) }));
    container.appendChild(edTitle);

    for (const group of report.editionGroups.slice(0, 100)) {
      const groupEl = el("details", { class: "lib-scan-group" }, [
        el("summary", {}, `${group.title} — ${group.author} (${group.editions.length} versions)`),
        ...group.editions.map((ed) => {
          const isRec = ed.path === group.recommended;
          return el("div", {
            class: isRec ? "lib-scan-edition lib-scan-recommended" : "lib-scan-edition",
          }, `${isRec ? "★ " : ""}${ed.format.toUpperCase()} ${ed.year ?? ""} — ${(ed.sizeBytes / 1024 / 1024).toFixed(1)} MB`);
        }),
      ]);
      container.appendChild(groupEl);
    }
  }

  if (report.fuzzyMatches && report.fuzzyMatches.length > 0) {
    const fzTitle = el("div", { class: "lib-scan-section-title" },
      t("library.import.scan.report.fuzzyTitle", { n: String(report.fuzzyMatches.length) }));
    container.appendChild(fzTitle);

    for (const pair of report.fuzzyMatches.slice(0, 50)) {
      const pairEl = el("div", { class: "lib-scan-fuzzy-pair" }, [
        el("div", { class: "lib-scan-fuzzy-conf" }, `${Math.round(pair.confidence * 100)}%`),
        el("div", {}, `A: ${pair.bookA.title} — ${pair.bookA.author}`),
        el("div", {}, `B: ${pair.bookB.title} — ${pair.bookB.author}`),
      ]);
      container.appendChild(pairEl);
    }
  }
}
