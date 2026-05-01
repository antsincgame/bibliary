// @ts-check
/**
 * Карточка Олимпиады — главный экран («для бабушек»):
 *   — большая кнопка «Запустить Олимпиаду»
 *   — после прогона: медальный зачёт + рекомендации (роли применяются автоматически)
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

/**
 * Карточка Олимпиады. Главный экран — простой и понятный:
 *   — большая кнопка «Запустить Олимпиаду»
 *   — после прогона: медальный зачёт + рекомендации (роли применяются автоматически)
 *   — Олимпиада всегда запускает с полным охватом (testAll + все роли).
 */
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
      }, "🗑 Очистить кэш"),
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
          if (toggleBtn) toggleBtn.textContent = ctx.olympicsDebugVisible ? "🔽 Скрыть протокол" : "📜 Протокол игр";
        },
      }, "📜 Протокол игр"),
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
        el("span", { class: "mp-olympics-log-summary-label" }, "📜 Протокол игр"),
        el("span", { class: "mp-olympics-log-counter" }, "0 событий"),
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
  counter.textContent = `${n} ${n === 1 ? "событие" : (n < 5 ? "события" : "событий")}`;
}

function ensureLogVisible(logEl) {
  if (!logEl) return;
  logEl.style.display = "";
  ctx.olympicsDebugVisible = true;
  if (logEl instanceof HTMLDetailsElement) logEl.open = true;
  const toggleBtn = ctx.pageRoot?.querySelector("#mp-olympics-debug-toggle");
  if (toggleBtn) toggleBtn.textContent = "🔽 Скрыть протокол";
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
      counter.textContent = "0 событий";
      counter.dataset.n = "0";
    }
    logEl.style.display = "none";
    if (logEl instanceof HTMLDetailsElement) logEl.open = false;
  }
  if (resultsEl) clear(resultsEl);
  ctx.olympicsDebugVisible = false;
  const toggleBtn = ctx.pageRoot?.querySelector("#mp-olympics-debug-toggle");
  if (toggleBtn) toggleBtn.textContent = "📜 Протокол игр";
}

/** Pretty-print любого объекта/значения для technical log. */
function fmtCtx(obj) {
  if (obj === null || obj === undefined) return "";
  if (typeof obj === "string") return obj;
  try { return JSON.stringify(obj, null, 2); } catch { return String(obj); }
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
          `⚡ STARTUP — ${n} models × ${d} disciplines`,
          el("div", {}, [
            el("div", {}, `participants (${n}): ${(e.models ?? []).slice(0, 8).join(", ")}${(e.models ?? []).length > 8 ? "…" : ""}`),
            el("div", {}, `disciplines (${d}): ${(e.disciplines ?? []).slice(0, 12).join(", ")}${(e.disciplines ?? []).length > 12 ? "…" : ""}`),
          ]),
          "mid",
        );

      } else if (e.type === "olympics.vram_guard") {
        const gb = Number(e.estimatedGB ?? 0).toFixed(1);
        const limit = Number(e.limitGB ?? 0).toFixed(1);
        appendOlympicsLog(
          logEl,
          `⚠ VRAM guard: action=${e.action ?? "unknown"} estimated=${gb}GB limit=${limit}GB`,
          "mid",
        );

      } else if (e.type === "olympics.model.loading") {
        appendOlympicsLog(logEl, `🔄 LOAD ${e.model}…`, "info");

      } else if (e.type === "olympics.model.loaded") {
        const dur = ((e.loadTimeMs ?? 0) / 1000).toFixed(2);
        appendOlympicsLog(logEl, `  ✅ ready: ${e.model} (load=${dur}s)`, "mid");

      } else if (e.type === "olympics.model.unloaded") {
        appendOlympicsLog(logEl, `  ⏏ unloaded: ${e.model}`, "info");

      } else if (e.type === "olympics.model.load_failed") {
        const reason = String(e.reason ?? "").slice(0, 200);
        appendOlympicsLogDetail(
          logEl,
          `  ❌ load_failed: ${e.model} — ${reason.slice(0, 60)}`,
          el("pre", { class: "mp-olympics-log-pre" }, reason),
          "bad",
        );

      } else if (e.type === "olympics.discipline.start") {
        const role = e.role ? ` · role=${e.role}` : "";
        const tf = e.thinkingFriendly ? " · 🧠 thinking-friendly" : "";
        const mt = e.maxTokens ? ` · max_tokens=${e.maxTokens}` : "";
        const summary = `🏛 DISCIPLINE.START "${e.discipline}"${role}${tf}${mt}`;
        if (e.whyImportant) {
          appendOlympicsLogDetail(
            logEl,
            summary,
            el("div", {}, [
              el("div", { class: "mp-olympics-log-meta" }, "WHY IMPORTANT:"),
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
        if (typeof e.tokens === "number" && e.tokens > 0)             tokFields.push(`tot=${e.tokens}`);
        if (typeof e.promptTokens === "number")                       tokFields.push(`prompt=${e.promptTokens}`);
        if (typeof e.completionTokens === "number")                   tokFields.push(`comp=${e.completionTokens}`);
        const tps = (typeof e.completionTokens === "number" && e.durationMs > 0)
          ? (e.completionTokens / (e.durationMs / 1000)).toFixed(1)
          : null;
        if (tps) tokFields.push(`${tps}tok/s`);
        const tokStr = tokFields.length ? ` · ${tokFields.join(" ")}` : "";
        const sumLine = `  ${tier} MATCH "${e.discipline}" → ${e.model}: score=${score}/100 (${dur}s)${tokStr}`;

        const bodyChildren = [];
        if (e.role) bodyChildren.push(el("div", { class: "mp-olympics-log-meta" }, `role: ${e.role}`));
        if (e.error) bodyChildren.push(el("div", { class: "mp-olympics-log-meta mp-olympics-log-error" }, `error: ${e.error}`));
        if (e.sample) {
          bodyChildren.push(el("div", { class: "mp-olympics-log-meta" }, "sample (first 240 chars):"));
          bodyChildren.push(el("pre", { class: "mp-olympics-log-pre" }, e.sample));
        }
        if (bodyChildren.length > 0) {
          appendOlympicsLogDetail(logEl, sumLine, el("div", {}, bodyChildren), ok ? level : "bad");
        } else {
          appendOlympicsLog(logEl, sumLine, ok ? level : "bad");
        }

      } else if (e.type === "olympics.discipline.done") {
        if (e.champion) {
          appendOlympicsLog(logEl, `  🏆 DISCIPLINE.DONE "${e.discipline}" → champion=${e.champion}`, "good");
        } else {
          appendOlympicsLog(logEl, `  ⊘ DISCIPLINE.DONE "${e.discipline}" → no qualified winner`, "bad");
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
        appendOlympicsLog(logEl, `🏁 OLYMPICS.DONE — total ${dur}s`, "good");
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
