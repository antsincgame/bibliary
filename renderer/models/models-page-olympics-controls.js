// @ts-check
/**
 * Карточка Олимпиады — простой одно-кнопочный UI:
 * «Запустить» → медальный зачёт + рекомендации → авто-применение.
 *
 * Извлечено из `models-page.js` (Phase 2.4 cross-platform roadmap, 2026-04-30).
 */

import { el, clear } from "../dom.js";
import { t } from "../i18n.js";
import {
  ctx,
  errMsg,
  showToast,
} from "./models-page-internals.js";
import { renderOlympicsReport } from "./models-page-olympics-report.js";
import { refresh } from "./models-hardware-status.js";

export function buildOlympicsCard() {
  return el("section", { class: "mp-card mp-card-compact mp-olympics-card" }, [
    el("h2", { class: "mp-card-title" }, t("models.olympics.title")),
    el("p", { class: "mp-card-sub" }, t("models.olympics.sub")),

    /* ── Главная зона: только большие кнопки. Никаких чекбоксов. ── */
    el("div", { class: "mp-olympics-actions" }, [
      el("button", {
        id: "mp-olympics-run",
        class: "btn btn-primary btn-lg",
        type: "button",
        onclick: () => void runOlympicsAndShow(),
      }, t("models.olympics.run")),
      el("button", {
        id: "mp-olympics-cancel",
        class: "btn btn-ghost",
        type: "button",
        style: "display:none",
        onclick: () => void cancelOlympics(),
      }, t("models.olympics.cancel")),
      el("button", {
        class: "btn btn-ghost btn-xs",
        type: "button",
        onclick: async () => {
          if (window.api?.arena?.clearOlympicsCache) {
            await window.api.arena.clearOlympicsCache();
          }
          resetOlympicsUI();
          showToast(t("models.olympics.cache_cleared"), "success");
        },
      }, t("models.olympics.log.clear_cache_btn")),
      el("button", {
        id: "mp-olympics-debug-toggle",
        class: "btn btn-ghost btn-xs",
        type: "button",
        onclick: () => {
          ctx.olympicsDebugVisible = !ctx.olympicsDebugVisible;
          const logEl = ctx.pageRoot?.querySelector("#mp-olympics-log");
          const toggleBtn = ctx.pageRoot?.querySelector("#mp-olympics-debug-toggle");
          if (logEl) {
            logEl.style.display = ctx.olympicsDebugVisible ? "" : "none";
            if (logEl instanceof HTMLDetailsElement) logEl.open = ctx.olympicsDebugVisible;
          }
          if (toggleBtn) toggleBtn.textContent = ctx.olympicsDebugVisible
            ? t("models.olympics.log.toggle_hide")
            : t("models.olympics.log.header");
        },
      }, t("models.olympics.log.header")),
    ]),

    /* Лог-панель: collapsible <details>, расширяющийся вниз по мере турнира.
     * Per-event записи — тоже <details>, можно раскрыть для технических деталей
     * (tokens, ttft, sample, ctx). UI ориентирован на технарей. */
    (() => {
      const log = el("details", {
        id: "mp-olympics-log",
        class: "mp-olympics-log",
        style: "display:none",
      });
      log.appendChild(el("summary", { class: "mp-olympics-log-summary" }, [
        el("span", { class: "mp-olympics-log-summary-label" }, t("models.olympics.log.header")),
        el("span", { class: "mp-olympics-log-counter" }, t("models.olympics.log.events.zero")),
      ]));
      log.appendChild(el("div", { class: "mp-olympics-log-body" }, ""));
      return log;
    })(),

    /* Зона результатов (медальный зачёт + рекомендации). */
    el("div", { id: "mp-olympics-results", class: "mp-olympics-results" }, ""),
  ]);
}

/* ─── Лог + UI помощники ───────────────────────────────────────────────
 *
 * Архитектура «технарского» лога:
 *   <details id="mp-olympics-log" open>
 *     <summary>📜 Протокол игр  · N событий</summary>
 *     <div class="mp-olympics-log-body">
 *       <div class="mp-olympics-log-entry log-good">⚡ ...</div>     ← простая строка
 *       <details class="mp-olympics-log-entry log-mid">              ← раскрываемое
 *         <summary>🏛 ИСПЫТАНИЕ "crystallizer-rover" / role=...</summary>
 *         <div class="mp-olympics-log-entry-body">
 *           <p>whyImportant: ...</p>
 *           <pre>{"maxTokens":384,"thinkingFriendly":true}</pre>
 *         </div>
 *       </details>
 *     </div>
 *   </details>
 *
 * Поведение: collapsible, auto-expand при первом событии, scroll-to-bottom.
 */

function getLogBody(logEl) {
  return logEl?.querySelector(".mp-olympics-log-body") ?? null;
}

function bumpLogCounter(logEl) {
  const counter = logEl?.querySelector(".mp-olympics-log-counter");
  if (!counter) return;
  const n = (parseInt(counter.dataset.n || "0", 10) || 0) + 1;
  counter.dataset.n = String(n);
  counter.textContent = eventCountStr(n);
}

function ensureLogVisible(logEl) {
  if (!logEl) return;
  logEl.style.display = "";
  ctx.olympicsDebugVisible = true;
  if (logEl instanceof HTMLDetailsElement) logEl.open = true;
  const toggleBtn = ctx.pageRoot?.querySelector("#mp-olympics-debug-toggle");
  if (toggleBtn) toggleBtn.textContent = t("models.olympics.log.toggle_hide");
}

/** Простое событие — одна строка. */
function appendOlympicsLog(logEl, text, level = "info") {
  if (!logEl) return;
  ensureLogVisible(logEl);
  const body = getLogBody(logEl);
  if (!body) return;
  const entry = el("div", { class: `mp-olympics-log-entry mp-olympics-log-${level}` }, text);
  body.appendChild(entry);
  bumpLogCounter(logEl);
  body.scrollTop = body.scrollHeight;
}

/** Раскрываемое событие: summary + детали (произвольный HTML body). */
function appendOlympicsLogDetail(logEl, summaryText, detailsBody, level = "info") {
  if (!logEl) return;
  ensureLogVisible(logEl);
  const body = getLogBody(logEl);
  if (!body) return;
  const det = el("details", { class: `mp-olympics-log-entry mp-olympics-log-detail mp-olympics-log-${level}` }, [
    el("summary", { class: "mp-olympics-log-detail-summary" }, summaryText),
    el("div", { class: "mp-olympics-log-detail-body" }, detailsBody),
  ]);
  body.appendChild(det);
  bumpLogCounter(logEl);
  body.scrollTop = body.scrollHeight;
}

function resetOlympicsUI() {
  const logEl = ctx.pageRoot?.querySelector("#mp-olympics-log");
  const resultsEl = ctx.pageRoot?.querySelector("#mp-olympics-results");
  if (logEl) {
    const body = getLogBody(logEl);
    if (body) clear(body);
    const counter = logEl.querySelector(".mp-olympics-log-counter");
    if (counter) {
      counter.textContent = t("models.olympics.log.events.zero");
      counter.dataset.n = "0";
    }
    logEl.style.display = "none";
    if (logEl instanceof HTMLDetailsElement) logEl.open = false;
  }
  if (resultsEl) clear(resultsEl);
  ctx.olympicsDebugVisible = false;
  const toggleBtn = ctx.pageRoot?.querySelector("#mp-olympics-debug-toggle");
  if (toggleBtn) toggleBtn.textContent = t("models.olympics.log.header");
}

/** Pretty-print любого объекта/значения для technical log. */
function fmtCtx(obj) {
  if (obj === null || obj === undefined) return "";
  if (typeof obj === "string") return obj;
  try { return JSON.stringify(obj, null, 2); } catch { return String(obj); }
}

/** Возвращает человеко-читаемое имя дисциплины или исходный ID как запасной вариант. */
function discName(id) {
  const key = `models.olympics.disc.${id}`;
  const val = t(key);
  return val === key ? id : val;
}

/** Возвращает человеко-читаемое имя роли для протокола. */
function logRoleName(role) {
  const key = `models.olympics.role.${role}`;
  const val = t(key);
  return val === key ? role : val;
}

/** Строка числа событий с правильным склонением (ru/en). */
function eventCountStr(n) {
  if (n === 0) return t("models.olympics.log.events.zero");
  if (n === 1) return t("models.olympics.log.events.one");
  if (n < 5)  return t("models.olympics.log.events.few", { n: String(n) });
  return t("models.olympics.log.events.many", { n: String(n) });
}

function setOlympicsButtons(running) {
  const runBtn = ctx.pageRoot?.querySelector("#mp-olympics-run");
  const cancelBtn = ctx.pageRoot?.querySelector("#mp-olympics-cancel");
  if (runBtn) runBtn.disabled = running;
  if (cancelBtn) cancelBtn.style.display = running ? "" : "none";
}

/* ─── Run/cancel ───────────────────────────────────────────────────── */

async function runOlympicsAndShow() {
  if (ctx.olympicsBusy) return;
  if (!window.api?.arena?.runOlympics) {
    showToast(t("models.olympics.unavailable"), "error");
    return;
  }
  ctx.olympicsBusy = true;
  setOlympicsButtons(true);
  resetOlympicsUI();
  const logEl = ctx.pageRoot?.querySelector("#mp-olympics-log");
  const resultsEl = ctx.pageRoot?.querySelector("#mp-olympics-results");
  appendOlympicsLog(logEl, t("models.olympics.starting"));

  let unsub = null;
  if (typeof window.api.arena.onOlympicsProgress === "function") {
    unsub = window.api.arena.onOlympicsProgress((ev) => {
      if (!ev || typeof ev !== "object") return;
      const e = ev;

      if (e.type === "olympics.start") {
        const n = e.models?.length ?? 0;
        const d = e.disciplines?.length ?? 0;
        appendOlympicsLogDetail(
          logEl,
          t("models.olympics.log.startup", { n: String(n), d: String(d) }),
          el("div", {}, [
            el("div", {}, t("models.olympics.log.startup.participants", { n: String(n) }) + " " + (e.models ?? []).slice(0, 8).join(", ") + ((e.models ?? []).length > 8 ? "…" : "")),
            el("div", {}, t("models.olympics.log.startup.disciplines", { d: String(d) }) + " " + (e.disciplines ?? []).slice(0, 12).map(discName).join(", ") + ((e.disciplines ?? []).length > 12 ? "…" : "")),
          ]),
          "mid",
        );

      } else if (e.type === "olympics.vram_guard") {
        const gb = Number(e.estimatedGB ?? 0).toFixed(1);
        const limit = Number(e.limitGB ?? 0).toFixed(1);
        appendOlympicsLog(
          logEl,
          t("models.olympics.log.vram_guard", { action: String(e.action ?? "?"), gb, limit }),
          "mid",
        );

      } else if (e.type === "olympics.model.loading") {
        appendOlympicsLog(logEl, t("models.olympics.log.loading", { model: e.model }), "info");

      } else if (e.type === "olympics.model.loaded") {
        const dur = ((e.loadTimeMs ?? 0) / 1000).toFixed(2);
        appendOlympicsLog(logEl, t("models.olympics.log.loaded", { model: e.model, dur }), "mid");

      } else if (e.type === "olympics.model.unloaded") {
        appendOlympicsLog(logEl, t("models.olympics.log.unloaded", { model: e.model }), "info");

      } else if (e.type === "olympics.model.load_failed") {
        const reason = String(e.reason ?? "").slice(0, 200);
        appendOlympicsLogDetail(
          logEl,
          t("models.olympics.log.load_failed", { model: e.model, reason: reason.slice(0, 60) }),
          el("pre", { class: "mp-olympics-log-pre" }, reason),
          "bad",
        );

      } else if (e.type === "olympics.discipline.start") {
        let suffix = "";
        if (e.role) suffix += t("models.olympics.log.role_suffix", { role: logRoleName(e.role) });
        if (e.thinkingFriendly) suffix += t("models.olympics.log.thinking_suffix");
        if (e.maxTokens) suffix += t("models.olympics.log.tokens_suffix", { tokens: String(e.maxTokens) });
        const summary = t("models.olympics.log.discipline_start", { discipline: discName(e.discipline ?? ""), suffix });
        if (e.whyImportant) {
          appendOlympicsLogDetail(
            logEl,
            summary,
            el("div", {}, [
              el("div", { class: "mp-olympics-log-meta" }, t("models.olympics.log.why_important")),
              el("div", { class: "mp-olympics-log-prose" }, e.whyImportant),
            ]),
            "mid",
          );
        } else {
          appendOlympicsLog(logEl, summary, "mid");
        }

      } else if (e.type === "olympics.model.done") {
        const score = Math.round((e.score ?? 0) * 100);
        const dur = ((e.durationMs ?? 0) / 1000).toFixed(2);
        const ok = e.ok !== false;
        const tier = score >= 70 ? "🥇" : score >= 40 ? "🥈" : "🥉";
        const level = score >= 70 ? "good" : score >= 40 ? "mid" : "bad";
        const tokFields = [];
        if (typeof e.tokens === "number" && e.tokens > 0)             tokFields.push(t("models.olympics.log.tok_total", { n: String(e.tokens) }));
        if (typeof e.promptTokens === "number")                       tokFields.push(t("models.olympics.log.tok_prompt", { n: String(e.promptTokens) }));
        if (typeof e.completionTokens === "number")                   tokFields.push(t("models.olympics.log.tok_answer", { n: String(e.completionTokens) }));
        const tps = (typeof e.completionTokens === "number" && e.durationMs > 0)
          ? (e.completionTokens / (e.durationMs / 1000)).toFixed(1)
          : null;
        if (tps) tokFields.push(t("models.olympics.log.tok_speed", { n: tps }));
        const tokStr = tokFields.length ? ` · ${tokFields.join(" ")}` : "";
        const sumLine = t("models.olympics.log.match_line", {
          medal: tier,
          discipline: discName(e.discipline ?? ""),
          model: e.model ?? "",
          score: String(score),
          dur,
          tokens: tokStr,
        });

        const bodyChildren = [];
        if (e.role) bodyChildren.push(el("div", { class: "mp-olympics-log-meta" }, t("models.olympics.log.role_label", { role: logRoleName(e.role) })));
        if (e.error) bodyChildren.push(el("div", { class: "mp-olympics-log-meta mp-olympics-log-error" }, t("models.olympics.log.error_label", { error: e.error })));
        if (e.sample) {
          bodyChildren.push(el("div", { class: "mp-olympics-log-meta" }, t("models.olympics.log.sample_label")));
          bodyChildren.push(el("pre", { class: "mp-olympics-log-pre" }, e.sample));
        }
        if (bodyChildren.length > 0) {
          appendOlympicsLogDetail(logEl, sumLine, el("div", {}, bodyChildren), ok ? level : "bad");
        } else {
          appendOlympicsLog(logEl, sumLine, ok ? level : "bad");
        }

      } else if (e.type === "olympics.discipline.done") {
        if (e.champion) {
          appendOlympicsLog(logEl, t("models.olympics.log.discipline_won", { discipline: discName(e.discipline ?? ""), champion: e.champion }), "good");
        } else {
          appendOlympicsLog(logEl, t("models.olympics.log.discipline_no_winner", { discipline: discName(e.discipline ?? "") }), "bad");
        }

      } else if (e.type === "olympics.log") {
        /* Технический лог из main-process makeLogger.
         * Уровни info/warn/error/debug → визуальные классы. */
        const lvlMap = { error: "bad", warn: "mid", debug: "info", info: "info" };
        const cssLevel = lvlMap[e.level] || "info";
        const ctxStr = e.ctx && Object.keys(e.ctx).length ? fmtCtx(e.ctx) : "";
        const summary = `[${String(e.level).toUpperCase()}] ${e.message}`;
        if (ctxStr) {
          appendOlympicsLogDetail(
            logEl,
            summary,
            el("pre", { class: "mp-olympics-log-pre mp-olympics-log-ctx" }, ctxStr),
            cssLevel,
          );
        } else {
          appendOlympicsLog(logEl, summary, cssLevel);
        }

      } else if (e.type === "olympics.done") {
        const dur = ((e.durationMs ?? 0) / 1000).toFixed(1);
        appendOlympicsLog(logEl, t("models.olympics.log.done", { dur }), "good");
      }
    });
  }

  try {
    const report = await window.api.arena.runOlympics({ testAll: true });
    appendOlympicsLog(logEl, t("models.olympics.done", { ms: ((report.totalDurationMs ?? 0) / 1000).toFixed(1) }), "good");
    renderOlympicsReport(report);
    showToast(t("models.olympics.success"), "success");
    /* Авто-применение: используем оптимум (лучший баланс качество/скорость). */
    const recs = report.recommendations ?? {};
    if (Object.keys(recs).length > 0 && window.api?.arena?.applyOlympicsRecommendations) {
      try {
        await window.api.arena.applyOlympicsRecommendations({ recommendations: recs });
        showToast(`⭐ ${t("models.olympics.distribute_done")} (${Object.keys(recs).length})`, "success");
        void refresh();
      } catch (applyErr) {
        console.warn("[models] auto-apply failed:", applyErr);
      }
    }
  } catch (e) {
    const msg = errMsg(e);
    const isAbort = msg.includes("aborted") || msg.includes("abort") || msg.includes("cancel");
    if (isAbort) {
      resetOlympicsUI();
    } else {
      appendOlympicsLog(logEl, `✗ ${msg}`, "bad");
      showToast(t("models.olympics.failed", { reason: msg }), "error");
      if (resultsEl) resultsEl.appendChild(el("div", { class: "mp-error" }, msg));
    }
  } finally {
    ctx.olympicsBusy = false;
    setOlympicsButtons(false);
    if (typeof unsub === "function") unsub();
  }
}

async function cancelOlympics() {
  if (!ctx.olympicsBusy) return;
  if (!window.api?.arena?.cancelOlympics) return;
  try {
    await window.api.arena.cancelOlympics();
    showToast(t("models.olympics.cancelled"), "success");
  } catch (e) {
    showToast(errMsg(e), "error");
  }
}
