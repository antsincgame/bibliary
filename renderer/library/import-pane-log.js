// @ts-check
/**
 * Real-time лог-панель Import Pane: скроллируемый список событий с фильтром
 * по уровню, счётчиком ошибок/предупреждений и кнопками Clear/Copy.
 *
 * Извлечено из `import-pane.js` (Phase 3.4 cross-platform roadmap, 2026-04-30).
 * Внутреннее module-state `LOG_RING` + `LOG_PANEL_REF` — singleton на весь
 * renderer-процесс (один лог на всё приложение, переоткрытие вкладки не
 * стирает буфер).
 */

import { el, clear } from "../dom.js";
import { t } from "../i18n.js";
import { showAlert } from "../components/ui-dialog.js";

const LOG_RING_SIZE = 1000;
const LOG_LEVEL_PRIORITY = { debug: 0, info: 1, warn: 2, error: 3 };

/** @type {{level: string, category: string, ts: string, message: string, file?: string, details?: Record<string, unknown>, durationMs?: number, importId?: string}[]} */
const LOG_RING = [];
let LOG_FILTER_LEVEL = "info";
let LOG_PANEL_REF = null;

/**
 * Создаёт DOM-панель лога. Идемпотентно: повторный вызов возвращает
 * существующий singleton (повторный mount не плодит listener'ов).
 *
 * @returns {HTMLElement}
 */
export function buildLogPanel() {
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
         поля details для каждой строки. */
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
    counterErr, counterWarn, counterInfo, counterDup, counterSkip,
    el("span", { class: "lib-import-log-spacer" }),
    filterSelect, clearBtn, copyBtn,
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

/** Подгрузить snapshot лога из main-процесса (включая прошлые сессии). */
export async function hydrateLogSnapshot() {
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
    ondblclick: async (ev) => {
      try {
        await navigator.clipboard.writeText(formatLogLineForCopy(entry));
        const target = /** @type {HTMLElement} */ (ev.currentTarget);
        target.classList.add("lib-import-log-row-copied");
        setTimeout(() => target.classList.remove("lib-import-log-row-copied"), 600);
      } catch {
        await showAlert(t("library.import.log.copyFailed", {
          msg: "clipboard unavailable",
        }));
      }
    },
  }, [headerRow]);

  if (hasDetails && expandToggle) {
    /* Expand-collapse: клик по голове разворачивает блок details. */
    headerRow.addEventListener("click", (ev) => {
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
    if (entry.category === "file.duplicate") dup++;
    if (entry.category === "file.skipped") skip++;
  }
  if (ce) ce.textContent = String(e);
  if (cw) cw.textContent = String(w);
  if (ci) ci.textContent = String(i);
  if (cd) cd.textContent = String(dup);
  if (cs) cs.textContent = String(skip);
}
