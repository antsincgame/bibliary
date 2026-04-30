// @ts-check
/**
 * Карточка Олимпиады: kнопки run/cancel/cache/profiles, лог-панель, advanced
 * настройки, обработчик прогресса IPC, авто-применение рекомендаций.
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
import { ALL_ROLES } from "./models-page-olympics-labels.js";
import { renderOlympicsReport } from "./models-page-olympics-report.js";
import { refresh } from "./models-hardware-status.js";

/**
 * Простой helper: создать чекбокс, привязанный к pref-ключу. Загружает текущее
 * значение из preferences, при изменении сохраняет обратно.
 *
 * @param {string} prefKey
 * @param {string=} domId
 */
function bindPrefCheckbox(prefKey, domId) {
  const cb = el("input", domId ? { id: domId, type: "checkbox" } : { type: "checkbox" });
  if (window.api?.preferences?.getAll) {
    void window.api.preferences.getAll().then((prefs) => {
      cb.checked = prefs?.[prefKey] === true;
    }).catch(() => { /* ignore */ });
  }
  cb.addEventListener("change", () => {
    if (window.api?.preferences?.set) {
      void window.api.preferences.set({ [prefKey]: cb.checked });
    }
  });
  return cb;
}

/**
 * Карточка Олимпиады. Главный экран — простой и понятный («для бабушек»):
 *   — большая кнопка «Запустить Олимпиаду»
 *   — после прогона: медальный зачёт + рекомендации (роли применяются автоматически)
 *   — все сложные опции спрятаны в `<details>` Advanced.
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
          if (logEl) logEl.style.display = ctx.olympicsDebugVisible ? "" : "none";
          if (toggleBtn) toggleBtn.textContent = ctx.olympicsDebugVisible ? "🔽 Скрыть протокол" : "📜 Протокол игр";
        },
      }, "📜 Протокол игр"),
    ]),

    /* Лог-панель: скрыта по умолчанию, появляется в процессе турнира. */
    el("div", { id: "mp-olympics-log", class: "mp-olympics-log", style: "display:none" }, ""),

    /* Зона результатов (медальный зачёт + рекомендации). */
    el("div", { id: "mp-olympics-results", class: "mp-olympics-results" }, ""),

    /* ── Advanced: всё, что нужно редко. Свёрнуто по умолчанию. ── */
    buildOlympicsAdvanced(),
  ]);
}

function buildOlympicsAdvanced() {
  return el("details", { class: "mp-olympics-advanced" }, [
    el("summary", { class: "mp-olympics-advanced-summary" }, t("models.olympics.advanced")),
    el("p", { class: "mp-olympics-advanced-hint" }, t("models.olympics.advanced.hint")),

    /* — Авто-применение: оптимум (по умолчанию) или чемпион — */
    el("label", { class: "mp-olympics-option" }, [
      bindPrefCheckbox("olympicsUseChampion", "mp-olympics-use-champion"),
      el("span", {}, t("models.olympics.advanced.use_champion")),
      el("span", { class: "mp-olympics-option-hint" }, t("models.olympics.advanced.use_champion_hint")),
    ]),

    /* — Фильтр класса + testAll — */
    el("label", { class: "mp-olympics-option" }, [
      bindPrefCheckbox("olympicsTestAll", "mp-olympics-testall"),
      el("span", {}, t("models.olympics.option.test_all")),
      el("span", { class: "mp-olympics-option-hint" }, t("models.olympics.option.test_all_hint")),
    ]),
    el("label", { class: "mp-olympics-option" }, [
      el("span", {}, t("models.olympics.option.weight_classes")),
      (() => {
        const sel = el("select", { id: "mp-olympics-classes", class: "mp-olympics-select" }, [
          el("option", { value: "s,m" }, "S+M (1–12B) — стандарт"),
          el("option", { value: "s" }, "Только S (1–5B) — слабое железо"),
          el("option", { value: "m,l" }, "M+L (5–30B) — сильное железо"),
          el("option", { value: "s,m,l" }, "S+M+L — широкий охват"),
        ]);
        sel.value = "s,m";
        if (window.api?.preferences?.getAll) {
          void window.api.preferences.getAll().then((prefs) => {
            const saved = typeof prefs?.olympicsWeightClasses === "string" ? prefs.olympicsWeightClasses : "s,m";
            if (saved && sel.querySelector(`option[value="${saved}"]`)) sel.value = saved;
          }).catch(() => { /* ignore */ });
        }
        sel.addEventListener("change", () => {
          if (window.api?.preferences?.set) {
            void window.api.preferences.set({ olympicsWeightClasses: sel.value });
          }
        });
        return sel;
      })(),
    ]),

    /* — Экспертные тумблеры — */
    el("label", { class: "mp-olympics-option" }, [
      bindPrefCheckbox("olympicsRoleLoadConfigEnabled", "mp-olympics-role-tuning"),
      el("span", {}, t("models.olympics.option.role_tuning")),
      el("span", { class: "mp-olympics-option-hint" }, t("models.olympics.option.role_tuning_hint")),
    ]),
    el("label", { class: "mp-olympics-option" }, [
      bindPrefCheckbox("olympicsUseLmsSDK", "mp-olympics-use-sdk"),
      el("span", {}, t("models.olympics.option.use_sdk")),
      el("span", { class: "mp-olympics-option-hint" }, t("models.olympics.option.use_sdk_hint")),
    ]),

    /* — Какие роли тестировать — */
    el("div", { class: "mp-olympics-roles" }, [
      el("span", { class: "mp-olympics-roles-label" }, t("models.olympics.advanced.roles_label")),
      el("p", { class: "mp-olympics-roles-hint" }, t("models.olympics.advanced.roles_hint")),
      el("div", { class: "mp-olympics-roles-grid" },
        ALL_ROLES.map((r) =>
          el("label", { class: "mp-olympics-role-check" }, [
            el("input", { type: "checkbox", "data-role": r.role, checked: true }),
            el("span", {}, r.label),
          ])
        ),
      ),
    ]),

    /* — Профиль: экспорт / импорт — */
    el("div", { class: "mp-olympics-profile-row" }, [
      el("button", {
        class: "btn btn-ghost btn-sm",
        type: "button",
        title: t("models.olympics.advanced.export_hint"),
        onclick: () => void exportProfileViaDialog(),
      }, t("models.olympics.advanced.export")),
      el("button", {
        class: "btn btn-ghost btn-sm",
        type: "button",
        title: t("models.olympics.advanced.import_hint"),
        onclick: () => void importProfileViaDialog(),
      }, t("models.olympics.advanced.import")),
      el("button", {
        class: "btn btn-ghost btn-xs",
        type: "button",
        title: "Скачать профиль как JSON-файл (без диалога)",
        onclick: () => void downloadProfileAsBlob(),
      }, "↓ JSON"),
    ]),
    el("p", { class: "mp-olympics-advanced-hint" }, t("models.olympics.advanced.export_hint")),
  ]);
}

/* ─── Profile export / import ──────────────────────────────────────── */

async function exportProfileViaDialog() {
  if (!window.api?.preferences?.exportProfile) {
    showToast(t("models.olympics.advanced.export_unavailable"), "error");
    return;
  }
  try {
    const res = await window.api.preferences.exportProfile();
    if (!res?.path) return;
    showToast(t("models.olympics.advanced.export_done", { path: res.path }), "success");
  } catch (e) {
    showToast(errMsg(e), "error");
  }
}

async function importProfileViaDialog() {
  if (!window.api?.preferences?.importProfile) {
    showToast(t("models.olympics.advanced.import_unavailable"), "error");
    return;
  }
  try {
    const res = await window.api.preferences.importProfile();
    if (!res?.path) return;
    showToast(t("models.olympics.advanced.import_done", { keys: String(res.appliedKeys.length) }), "success");
    await refresh();
  } catch (e) {
    showToast(errMsg(e), "error");
  }
}

async function downloadProfileAsBlob() {
  if (!window.api?.preferences?.getProfile) return;
  try {
    const file = await window.api.preferences.getProfile();
    const blob = new Blob([JSON.stringify(file, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
    a.href = url;
    a.download = `bibliary-profile-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (e) {
    showToast(errMsg(e), "error");
  }
}

/* ─── Лог + UI помощники ───────────────────────────────────────────── */

function appendOlympicsLog(logEl, text, level = "info") {
  if (!logEl) return;
  logEl.style.display = "";
  ctx.olympicsDebugVisible = true;
  const toggleBtn = ctx.pageRoot?.querySelector("#mp-olympics-debug-toggle");
  if (toggleBtn) toggleBtn.textContent = "🔽 Скрыть протокол";
  const entry = el("div", { class: `mp-olympics-log-entry mp-olympics-log-${level}` }, text);
  logEl.appendChild(entry);
  logEl.scrollTop = logEl.scrollHeight;
}

function resetOlympicsUI() {
  const logEl = ctx.pageRoot?.querySelector("#mp-olympics-log");
  const resultsEl = ctx.pageRoot?.querySelector("#mp-olympics-results");
  if (logEl) { clear(logEl); logEl.style.display = "none"; }
  if (resultsEl) clear(resultsEl);
  ctx.olympicsDebugVisible = false;
  const toggleBtn = ctx.pageRoot?.querySelector("#mp-olympics-debug-toggle");
  if (toggleBtn) toggleBtn.textContent = "📜 Протокол игр";
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
        appendOlympicsLog(logEl, `⚡ На арену выходят ${n} участников. Впереди ${d} испытаний. Да начнутся Игры!`, "mid");
      } else if (e.type === "olympics.vram_guard") {
        const gb = Number(e.estimatedGB ?? 0).toFixed(1);
        appendOlympicsLog(logEl, `⚠ Служитель арены: памяти немного (${gb} ГБ), проверяем участников по одному.`, "mid");
      } else if (e.type === "olympics.model.loading") {
        appendOlympicsLog(logEl, `🏃 Участник «${e.model}» выходит на дорожку...`, "info");
      } else if (e.type === "olympics.model.loaded") {
        const dur = ((e.loadTimeMs ?? 0) / 1000).toFixed(1);
        appendOlympicsLog(logEl, `  ✅ «${e.model}» занял место на арене (вышел за ${dur}с)`, "mid");
      } else if (e.type === "olympics.model.unloaded") {
        appendOlympicsLog(logEl, `  🚪 «${e.model}» уходит с арены. Благодарим за участие!`, "info");
      } else if (e.type === "olympics.model.load_failed") {
        const reason = String(e.reason ?? "").slice(0, 80);
        appendOlympicsLog(logEl, `  ❌ «${e.model}» не вышел на арену — ${reason}`, "bad");
      } else if (e.type === "olympics.discipline.start") {
        appendOlympicsLog(logEl, `🏛 Испытание «${e.discipline}» — участники встают на старт!`, "mid");
      } else if (e.type === "olympics.model.done") {
        const score = Math.round((e.score ?? 0) * 100);
        const dur = ((e.durationMs ?? 0) / 1000).toFixed(1);
        const ok = e.ok !== false;
        const errorHint = e.error ? ` (${e.error.slice(0, 60)})` : "";
        let icon, msg, level;
        if (score >= 70) {
          icon = "🥇"; msg = "блестящий результат"; level = "good";
        } else if (score >= 40) {
          icon = "🏅"; msg = "держится достойно"; level = "mid";
        } else {
          icon = "😓"; msg = "не его сегодня день"; level = "bad";
        }
        appendOlympicsLog(logEl, `  ${icon} «${e.model}» — ${msg}! ${score}/100  (${dur}с)${errorHint}`, ok ? level : "bad");
      } else if (e.type === "olympics.discipline.done") {
        if (e.champion) {
          appendOlympicsLog(logEl, `  🌿 Лавровый венок: «${e.champion}» — победитель этого испытания!`, "good");
        } else {
          appendOlympicsLog(logEl, `  😞 В этом испытании достойного победителя не нашлось.`, "bad");
        }
      }
    });
  }

  const testAllEl = ctx.pageRoot?.querySelector("#mp-olympics-testall");
  const classesEl = ctx.pageRoot?.querySelector("#mp-olympics-classes");
  const testAll = testAllEl?.checked === true;
  const wcStr = classesEl?.value ?? "s,m";
  const weightClasses = wcStr.split(",").map((s) => s.trim()).filter(Boolean);
  const roleChecks = ctx.pageRoot?.querySelectorAll(".mp-olympics-role-check input[data-role]") ?? [];
  const roles = [];
  for (const cb of roleChecks) {
    if (cb.checked) roles.push(cb.getAttribute("data-role"));
  }
  if (roles.length === 0) {
    const msg = "Выбери хотя бы одну роль для Олимпиады";
    appendOlympicsLog(logEl, `✗ ${msg}`, "bad");
    showToast(msg, "error");
    ctx.olympicsBusy = false;
    setOlympicsButtons(false);
    if (typeof unsub === "function") unsub();
    return;
  }

  try {
    const report = await window.api.arena.runOlympics({ testAll, weightClasses, roles });
    appendOlympicsLog(logEl, t("models.olympics.done", { ms: ((report.totalDurationMs ?? 0) / 1000).toFixed(1) }), "good");
    renderOlympicsReport(report);
    showToast(t("models.olympics.success"), "success");
    /* ── Авто-применение ролей. По умолчанию применяется «оптимум»; в Advanced
     *    можно включить olympicsUseChampion — тогда применится «чемпион». */
    await autoApplyOlympicsRecommendations(report);
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

/**
 * Авто-применение рекомендаций после успешного прогона Олимпиады.
 *
 * @param {{ recommendations?: Record<string, string>; recommendationsByScore?: Record<string, string> }} report
 */
async function autoApplyOlympicsRecommendations(report) {
  if (!window.api?.arena?.applyOlympicsRecommendations) return;

  let useChampion = false;
  if (window.api?.preferences?.getAll) {
    try {
      const prefs = await window.api.preferences.getAll();
      useChampion = prefs?.olympicsUseChampion === true;
    } catch { /* ignore — fallback to optimum */ }
  }

  const target = useChampion
    ? (report.recommendationsByScore ?? {})
    : (report.recommendations ?? {});
  const keys = Object.keys(target);
  if (keys.length === 0) return;

  /* applyRecommendations показывает свой собственный toast — а тут хочется
     показать badge "🏆"/"⭐" + count. Поэтому inline IPC-call. */
  try {
    await window.api.arena.applyOlympicsRecommendations({ recommendations: target });
    showToast(
      `${useChampion ? "🏆" : "⭐"} ${t("models.olympics.distribute_done")} (${keys.length})`,
      "success",
    );
    void refresh();
  } catch (e) {
    console.warn("[models] auto-apply failed:", e);
  }
}
