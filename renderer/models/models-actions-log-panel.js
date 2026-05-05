// @ts-check
/**
 * Панель «Логи действий с LM Studio» (v1.0.7).
 *
 * Показывает последние записи из `lmstudio-actions.log` — структурного журнала,
 * куда Bibliary пишет КАЖДУЮ операцию с моделями LM Studio (LOAD, UNLOAD,
 * AUTO-LOAD-START/OK/FAIL, RESOLVE-PASSIVE-SKIP, EVALUATOR-DEFER-RESUME, и т.д.).
 *
 * Введена после "autonomous heresy" инцидента, когда v1.0.5 при простом
 * запуске приложения автоматически грузила 2-3 модели в LM Studio без
 * команды пользователя. Теперь любое действие видно и трассируемо.
 *
 * Формат строки: JSON с полями {ts, kind, modelKey?, role?, reason?, ...}.
 * UI рендерит компактный `<pre>` с последними 200 строками + кнопки
 * «Обновить» и «Очистить».
 */

import { el } from "../dom.js";
import { t } from "../i18n.js";

const MAX_LINES = 200;

/**
 * @returns {HTMLDetailsElement}
 */
export function buildActionsLogPanel() {
  const details = /** @type {HTMLDetailsElement} */ (
    el("details", { class: "mp-adv-panel" })
  );

  details.appendChild(
    el("summary", { class: "mp-adv-summary" }, t("models.actionsLog.summary")),
  );

  const pre = /** @type {HTMLPreElement} */ (
    el("pre", {
      class: "mp-actions-log",
      style: "max-height: 320px; overflow: auto; font-size: 11px; line-height: 1.4; padding: 8px; background: rgba(0,0,0,0.25); border: 1px solid rgba(255,255,255,0.08); border-radius: 4px; white-space: pre-wrap; word-break: break-all;",
    }, t("models.card.loading"))
  );

  const refreshBtn = /** @type {HTMLButtonElement} */ (
    el("button", { class: "btn btn-sm btn-ghost", type: "button" }, t("models.actionsLog.refresh"))
  );
  refreshBtn.addEventListener("click", () => void loadAndRender(pre));

  const clearBtn = /** @type {HTMLButtonElement} */ (
    el("button", { class: "btn btn-sm btn-ghost", type: "button" }, t("models.actionsLog.clear"))
  );
  clearBtn.addEventListener("click", async () => {
    if (!window.confirm(t("models.actionsLog.confirmClear"))) return;
    try {
      const api = /** @type {any} */ (window).api;
      await api?.lmstudio?.clearActionsLog?.();
      await loadAndRender(pre);
    } catch (e) {
      pre.textContent = t("models.actionsLog.clearFailed", { msg: e instanceof Error ? e.message : String(e) });
    }
  });

  details.appendChild(
    el("div", { class: "mp-adv-body" }, [
      el("p", { class: "mp-adv-hint" }, t("models.actionsLog.hint")),
      el("div", { class: "mp-actions-log-buttons", style: "display: flex; gap: 8px; margin-bottom: 8px;" }, [
        refreshBtn,
        clearBtn,
      ]),
      pre,
    ]),
  );

  /* Lazy-load: подгружаем содержимое только при первом раскрытии details,
     иначе на каждом mount Models page будет лишний IPC-вызов. */
  details.addEventListener("toggle", () => {
    if (details.open && pre.dataset.loadedOnce !== "1") {
      pre.dataset.loadedOnce = "1";
      void loadAndRender(pre);
    }
  });

  return details;
}

/**
 * Подгрузить текст лога и форматирование.
 *
 * @param {HTMLPreElement} pre
 */
async function loadAndRender(pre) {
  pre.textContent = t("models.card.loading");
  try {
    const api = /** @type {any} */ (window).api;
    const raw = await api?.lmstudio?.getActionsLog?.(MAX_LINES);
    if (!raw || typeof raw !== "string" || raw.length === 0) {
      pre.textContent = t("models.actionsLog.empty");
      return;
    }
    /* Преобразуем JSONL в человекочитаемый формат:
       2026-05-05T22:30:01.234Z  LOAD  qwen3.5  evaluator  reason="user-import"
       Это легче читать чем raw JSON. Если parse упадёт — fallback на raw. */
    const lines = raw.split("\n").filter((l) => l.length > 0);
    const formatted = lines.map(formatLine).join("\n");
    pre.textContent = formatted;
    /* Прокрутить в конец — пользователь хочет видеть свежие события первыми. */
    pre.scrollTop = pre.scrollHeight;
  } catch (e) {
    pre.textContent = t("models.actionsLog.loadFailed", { msg: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * @param {string} line
 * @returns {string}
 */
function formatLine(line) {
  try {
    const ev = JSON.parse(line);
    const parts = [
      ev.ts ?? "",
      String(ev.kind ?? "").padEnd(22),
      ev.modelKey ? `model=${ev.modelKey}` : "",
      ev.role ? `role=${ev.role}` : "",
      typeof ev.durationMs === "number" ? `${ev.durationMs}ms` : "",
      ev.reason ? `reason="${ev.reason}"` : "",
      ev.errorMsg ? `error="${ev.errorMsg}"` : "",
    ].filter(Boolean);
    return parts.join("  ");
  } catch {
    return line;
  }
}
