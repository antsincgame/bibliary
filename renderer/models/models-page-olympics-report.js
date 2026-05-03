// @ts-check
/**
 * Рендер отчёта Олимпиады: warnings, медальный зачёт, дисциплины (табы по
 * ролям), карточки рекомендаций.
 *
 * Извлечено из `models-page.js` (Phase 2.4 cross-platform roadmap, 2026-04-30).
 */

import { el, clear } from "../dom.js";
import { t } from "../i18n.js";
import { ctx } from "./models-page-internals.js";
import {
  disciplineHuman,
  roleHuman,
  roleIcon,
  aggregateRoleTitle,
  aggregateApplyHint,
} from "./models-page-olympics-labels.js";

export function renderOlympicsReport(report) {
  const root = ctx.pageRoot?.querySelector("#mp-olympics-results");
  if (!root) return;
  clear(root);

  /* ── Warnings (мало моделей / рекомендации по загрузке) ── */
  const warnings = report.warnings ?? [];
  const availCount = report.availableModelCount ?? 0;
  const usedCount  = (report.models ?? []).length;

  if (warnings.length > 0) {
    const warnMsgs = warnings.map((w) => {
      if (w === "few_models_1") return t("models.olympics.warning.only1", { count: usedCount, avail: availCount });
      if (w === "few_models_2") return t("models.olympics.warning.only2", { count: usedCount, avail: availCount });
      if (w === "few_models_3") return t("models.olympics.warning.only3", { count: usedCount, avail: availCount });
      if (w === "recommend_download") return t("models.olympics.warning.recommend_download");
      if (w.startsWith("all_failed:")) return t("models.olympics.warning.all_failed", { discipline: w.slice(11) });
      if (w.startsWith("role_no_winner:")) return `Роль «${w.slice(15)}» — нет уверенного победителя.`;
      return w;
    });
    const warnBox = el("div", { class: "mp-olympics-warning" }, [
      el("div", { class: "mp-olympics-warning-title" }, "⚠ " + t("models.olympics.warning.title")),
      ...warnMsgs.map((m) => el("div", { class: "mp-olympics-warning-msg" }, m)),
      (availCount < 4 || usedCount < 3)
        ? el("div", { class: "mp-olympics-warning-hint" }, [
            el("span", {}, t("models.olympics.warning.download_hint")),
            el("a", {
              href: "https://lmstudio.ai/models",
              target: "_blank",
              class: "mp-link",
            }, "lmstudio.ai/models"),
            el("span", {}, t("models.olympics.warning.download_hint2")),
          ])
        : null,
    ].filter(Boolean));
    root.appendChild(warnBox);
  }

  /* Iter 14.2 (2026-05-04): «Медальный зачёт» удалён по запросу — он не давал
     полезной информации для конечного пользователя (золото/серебро/бронза
     суммировались по дисциплинам, что путало с per-role чемпионами). Вместо
     него — фокус на per-role champion'ах (рекомендации по ролям ниже) и
     развёрнутых результатах по дисциплинам.

     `capBadges` (👁/🧠/🔧/params) и `btScores` теперь нужны для карточек
     ролей (ниже в renderRoleTab) — поэтому продолжаем читать их из report. */
  const caps = report.modelCapabilities ?? {};
  const btScores = report.btScores ?? {};

  function capBadges(modelKey) {
    const c = caps[modelKey];
    if (!c) return "";
    const badges = [];
    if (c.vision) badges.push("👁");
    if (c.reasoning) badges.push("🧠");
    if (c.toolUse) badges.push("🔧");
    if (c.paramsString) badges.push(c.paramsString);
    return badges.length > 0 ? ` [${badges.join(" ")}]` : "";
  }

  /* ── Результаты по дисциплинам ── */
  const allDisciplines = report.disciplines ?? [];
  const byRole = new Map();
  for (const d of allDisciplines) {
    if (!byRole.has(d.role)) byRole.set(d.role, []);
    byRole.get(d.role).push(d);
  }

  const disciplinesRoot = el("details", { class: "mp-olympics-disciplines" });
  disciplinesRoot.appendChild(
    el("summary", { class: "mp-olympics-disciplines-summary" }, [
      el("span", {}, t("models.olympics.disciplines")),
      el("span", { class: "mp-olympics-disciplines-count" }, ` (${allDisciplines.length} испытаний)`),
    ]),
  );

  const inner = el("div", { class: "mp-olympics-disciplines-inner" });
  const tabsBar = el("div", { class: "mp-olympics-tabs", role: "tablist" });
  const panels = el("div", { class: "mp-olympics-tabs-panels" });
  const roleKeys = [...byRole.keys()];

  function renderDiscipline(d) {
    const sorted = [...(d.perModel ?? [])].sort((a, b) => {
      if (Math.abs(a.score - b.score) > 0.005) return b.score - a.score;
      return a.durationMs - b.durationMs;
    });
    const podium = ["🥇", "🥈", "🥉"];
    const human = disciplineHuman(d.discipline);
    const top = sorted[0];
    const topScore = top ? Math.round(top.score * 100) : 0;
    const summaryStat = top
      ? ` — лучший: ${topScore}/100 (${top.model})`
      : ` — нет результатов`;

    const summaryChildren = [
      el("span", { class: "mp-olympics-discipline-tab-short" }, human.short),
      el("span", { class: "mp-olympics-discipline-tab-long" }, ` · ${human.long}`),
      el("span", { class: "mp-olympics-discipline-tab-stat" }, summaryStat),
    ];
    if (d.thinkingFriendly) {
      summaryChildren.push(el(
        "span",
        {
          class: "mp-olympics-thinking-badge",
          title: "Дисциплина оптимизирована для thinking-моделей: efficiency не штрафует за время reasoning-блока",
        },
        " 🧠 thinking-friendly",
      ));
    }

    const det = el("details", { class: "mp-olympics-discipline" }, [
      el("summary", { class: "mp-olympics-discipline-summary" }, summaryChildren),
      el("div", { class: "mp-olympics-discipline-meta" }, [
        el("span", { class: "mp-olympics-discipline-id" }, `id: ${d.discipline}`),
        d.description ? el("span", { class: "mp-olympics-discipline-desc" }, ` · ${d.description}`) : null,
      ].filter(Boolean)),
      ...sorted.map((p, i) => {
        const score = Math.round(p.score * 100);
        const level = score >= 70 ? "good" : score >= 40 ? "mid" : "bad";
        const errHint = p.error ? ` ✗ ${p.error.slice(0, 50)}` : "";
        const effHint = p.efficiency > 0 ? ` · eff ${p.efficiency.toFixed(1)}` : "";
        const sampleEl = (p.sample && score >= 30)
          ? el("div", { class: "mp-olympics-discipline-sample" }, `"${p.sample.slice(0, 120)}…"`)
          : null;
        return el("div", { class: `mp-olympics-discipline-row mp-olympics-row-${level}` }, [
          el("span", {}, `${podium[i] ?? "  "} ${p.model} — ${score}/100  (${(p.durationMs / 1000).toFixed(1)}s)${effHint}${errHint}`),
          sampleEl,
        ].filter(Boolean));
      }),
    ]);
    return det;
  }

  const tabButtons = [];
  const tabPanels = [];

  function setActiveTab(idx) {
    for (let i = 0; i < tabButtons.length; i++) {
      tabButtons[i].classList.toggle("active", i === idx);
      tabButtons[i].setAttribute("aria-selected", i === idx ? "true" : "false");
      tabPanels[i].style.display = i === idx ? "" : "none";
    }
  }

  roleKeys.forEach((role, idx) => {
    const ds = byRole.get(role);
    const human = roleHuman(role);
    const btn = el("button", {
      class: "mp-olympics-tab",
      type: "button",
      role: "tab",
      title: human.subtitle,
    }, [
      el("span", { class: "mp-olympics-tab-icon" }, human.icon),
      el("span", { class: "mp-olympics-tab-title" }, ` ${human.title}`),
      el("span", { class: "mp-olympics-tab-count" }, ` (${ds.length})`),
    ]);
    btn.addEventListener("click", () => setActiveTab(idx));
    tabsBar.appendChild(btn);
    tabButtons.push(btn);

    const panel = el("div", {
      class: "mp-olympics-tab-panel",
      role: "tabpanel",
    }, [
      el("div", { class: "mp-olympics-tab-panel-subtitle" }, human.subtitle),
      ...ds.map(renderDiscipline),
    ]);
    panels.appendChild(panel);
    tabPanels.push(panel);
  });

  inner.appendChild(tabsBar);
  inner.appendChild(panels);
  disciplinesRoot.appendChild(inner);
  if (tabButtons.length > 0) setActiveTab(0);
  root.appendChild(disciplinesRoot);

  /* ── Рекомендации (по ролям) ── */
  const recs = report.recommendations ?? {};
  const aggregates = report.roleAggregates ?? [];
  const recsKeys = Object.keys(recs);

  if (recsKeys.length === 0) {
    root.appendChild(el("div", { class: "mp-olympics-no-recs" }, t("models.olympics.no_recommendations")));
    return;
  }

  /* Iter 14.2 (2026-05-04): кнопка «Распределить роли» удалена.
     Распределение чемпионов теперь происходит АВТОМАТИЧЕСКИ сразу по
     окончании прогона — пользователь не должен дополнительно нажимать
     кнопку, чтобы понять «применилось ли». В заголовке оставляем подсказку
     о том что роли уже назначены, и список карточек с per-role чемпионами. */
  const recsHeader = el("div", { class: "mp-olympics-recs-header" }, [
    el("h3", {}, t("models.olympics.recommendations")),
    el("p", { class: "mp-card-sub" }, t("models.olympics.distribute_after_run")),
  ]);
  root.appendChild(recsHeader);

  /* ── EcoTune auto-tune suggestions ── */
  const tuneSuggestions = Array.isArray(report.autoTuneSuggestions) ? report.autoTuneSuggestions : [];

  if (tuneSuggestions.length > 0) {
    const tuneBox = el("details", { class: "mp-olympics-lightning-stats", open: "open" }, [
      el("summary", { class: "mp-olympics-lightning-summary" },
        `🔧 EcoTune auto-tune`),
      el("div", { class: "mp-olympics-lightning-section" }, [
        el("p", { class: "mp-card-sub" },
          "Детерминированный анализ результатов: для каждой роли — оптимальные temperature / max_tokens / top_p. " +
          "Применить можно вручную в Settings → Models → Inference (или будущий «Apply Tune»). " +
          "Источник: EcoTune EMNLP 2025."),
      ]),
    ]);
    const grid = el("div", { class: "mp-olympics-tune-grid" });
    grid.appendChild(el("div", { class: "mp-olympics-tune-header" }, [
      el("span", {}, "Роль"),
      el("span", {}, "temp"),
      el("span", {}, "max_tok"),
      el("span", {}, "top_p"),
      el("span", {}, "conf"),
      el("span", {}, "обоснование"),
    ]));
    for (const s of tuneSuggestions) {
      const confLevel = s.confidence === "high" ? "good" : s.confidence === "medium" ? "mid" : "bad";
      const confLabel = s.confidence === "high" ? "✓ high" : s.confidence === "medium" ? "~ med" : "? low";
      grid.appendChild(el("div", { class: `mp-olympics-tune-row mp-olympics-tune-conf-${confLevel}` }, [
        el("span", { class: "mp-olympics-tune-role", title: `→ ${s.prefKey}` }, s.role),
        el("span", { class: "mp-olympics-tune-num" }, String(s.suggestedTemperature)),
        el("span", { class: "mp-olympics-tune-num" }, String(s.suggestedMaxTokens)),
        el("span", { class: "mp-olympics-tune-num" }, String(s.suggestedTopP)),
        el("span", { class: `mp-olympics-tune-conf` }, confLabel),
        el("span", { class: "mp-olympics-tune-rationale" }, s.rationale),
      ]));
    }
    tuneBox.appendChild(grid);
    root.appendChild(tuneBox);
  }

  /* Иt 8Д.2: vision composite badge — на vision-карточках показываем
     что фактически применённый visionModelKey пришёл из объединённой
     агрегации трёх vision-ролей, а не per-role optimum (см. 8Д.1 fix). */
  const visionInfo = report.visionAggregateInfo;
  const VISION_ROLE_NAMES = new Set(["vision_meta", "vision_ocr", "vision_illustration"]);

  /* ── Горизонтальные вкладки по ролям ── */
  let activeRoleTab = aggregates.length > 0 ? aggregates[0].role : null;

  const rolesTabBar = el("div", { class: "mp-olympics-role-tabs" });
  const rolesPanel  = el("div", { class: "mp-olympics-role-panel" });
  root.appendChild(rolesTabBar);
  root.appendChild(rolesPanel);

  function renderRoleTab(agg) {
    const top = (agg.perModel ?? []).slice(0, 3);
    const optimumStats = agg.optimum ? agg.perModel.find((p) => p.model === agg.optimum) : null;
    const championStats = agg.champion ? agg.perModel.find((p) => p.model === agg.champion) : null;
    const roleH = roleHuman(agg.role);
    const isVisionRole = VISION_ROLE_NAMES.has(agg.role);

    const card = el("div", { class: "mp-olympics-role-card" }, [
      el("div", { class: "mp-olympics-role-header" }, [
        el("span", { class: "mp-olympics-role-icon" }, roleH.icon || roleIcon(agg.prefKey)),
        el("span", { class: "mp-olympics-role-name" }, aggregateRoleTitle(agg.role)),
        el("span", { class: "mp-olympics-role-disciplines" },
          `${(agg.disciplines ?? []).length} ${t("models.olympics.role.tests")}`),
      ]),
      el("div", { class: "mp-olympics-role-subhint" }, [
        el("span", { class: "mp-olympics-role-subhint-pref" }, aggregateApplyHint(agg.prefKey)),
        roleH.subtitle ? el("span", { class: "mp-olympics-role-subhint-sub" }, ` · ${roleH.subtitle}`) : null,
      ].filter(Boolean)),

      /* Иt 8Д.2: composite badge только на vision-карточках. */
      (isVisionRole && visionInfo)
        ? el("div", { class: "mp-olympics-vision-composite" }, [
            el("span", { class: "mp-olympics-vision-composite-icon" }, "🔗"),
            el("span", { class: "mp-olympics-vision-composite-text" },
              t("models.olympics.vision_composite", {
                modelKey: visionInfo.modelKey,
                reason: visionInfo.reason,
              })),
          ])
        : null,

      el("div", { class: "mp-olympics-role-top" },
        top.map((p, i) => {
          const podium = ["🥇", "🥈", "🥉"][i] ?? "  ";
          const score = Math.round(p.avgScore * 100);
          const minScore = Math.round(p.minScore * 100);
          const isChamp = p.model === agg.champion;
          const isOpt = p.model === agg.optimum;
          const tags = [];
          if (isChamp) tags.push(el("span", { class: "mp-olympics-tag mp-olympics-tag-champion" }, "ЧЕМПИОН"));
          if (isOpt) tags.push(el("span", { class: "mp-olympics-tag mp-olympics-tag-optimum" }, "ОПТИМУМ"));
          const capStr = capBadges(p.model);
          const btScore = btScores[p.model];
          const btStr = typeof btScore === "number" ? ` BT:${Math.round(btScore * 100)}` : "";
          const level = score >= 70 ? "good" : score >= 40 ? "mid" : "bad";
          return el("div", { class: `mp-olympics-role-row mp-olympics-row-${level}` }, [
            el("span", { class: "mp-olympics-role-rank" }, podium),
            el("span", { class: "mp-olympics-role-model" }, p.model + capStr),
            el("span", { class: "mp-olympics-role-stats" },
              `${score}/100 (min ${minScore}) · ${(p.avgDurationMs / 1000).toFixed(1)}s${btStr}`),
            ...tags,
          ]);
        })
      ),

      (agg.optimumReason || agg.championReason)
        ? el("div", { class: "mp-olympics-role-why" }, [
            optimumStats && agg.optimumReason
              ? el("div", { class: "mp-olympics-why-row" }, [
                  el("span", { class: "mp-olympics-why-label" }, "⭐ Оптимум:"),
                  el("span", { class: "mp-olympics-why-text" }, agg.optimumReason),
                ])
              : null,
            championStats && agg.championReason && agg.champion !== agg.optimum
              ? el("div", { class: "mp-olympics-why-row" }, [
                  el("span", { class: "mp-olympics-why-label" }, "🏆 Чемпион:"),
                  el("span", { class: "mp-olympics-why-text" }, agg.championReason),
                ])
              : null,
            agg.champion === agg.optimum && agg.optimumReason
              ? el("div", { class: "mp-olympics-why-hint" }, "Чемпион = Оптимум — лучшая по качеству И по скорости.")
              : null,
          ].filter(Boolean))
        : el("div", { class: "mp-olympics-role-no-winner" },
            "Нет уверенного победителя — все модели не справились с этой ролью."),
    ]);
    return card;
  }

  function activateRoleTab(role) {
    activeRoleTab = role;
    /* Update tab styles */
    rolesTabBar.querySelectorAll(".mp-olympics-role-tab").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.role === role);
    });
    /* Render panel */
    clear(rolesPanel);
    const agg = aggregates.find((a) => a.role === role);
    if (agg) rolesPanel.appendChild(renderRoleTab(agg));
  }

  for (const agg of aggregates) {
    const roleH = roleHuman(agg.role);
    const hasWinner = !!(agg.champion || agg.optimum);
    const tab = el("button", {
      class: `mp-olympics-role-tab ${agg.role === activeRoleTab ? "active" : ""}`,
      type: "button",
      "data-role": agg.role,
    }, [
      el("span", { class: "mp-olympics-role-tab-icon" }, roleH.icon || roleIcon(agg.prefKey)),
      el("span", { class: "mp-olympics-role-tab-name" }, aggregateRoleTitle(agg.role)),
      hasWinner
        ? el("span", { class: "mp-olympics-role-tab-badge" }, "✓")
        : null,
    ].filter(Boolean));
    tab.addEventListener("click", () => activateRoleTab(agg.role));
    rolesTabBar.appendChild(tab);
  }

  if (activeRoleTab) activateRoleTab(activeRoleTab);
}
