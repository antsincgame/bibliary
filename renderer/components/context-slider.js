// @ts-check
import { el, clear } from "../dom.js";
import { t } from "../i18n.js";

/**
 * Универсальный context-slider для Memory Forge (Phase 3.0).
 *
 * Один и тот же компонент работает в трёх режимах:
 *   - "full"     — Models route, полный UI с VRAM-bar и suggestions
 *   - "compact"  — Chat top-bar, только slider + текущее значение
 *   - "embedded" — Forge wizard Step 3, без apply (значения идут в config-generator)
 *
 * @param {object} opts
 * @param {string} opts.modelKey
 * @param {{ vramGB?: number; modelWeightsGB?: number }} [opts.hardware]
 *   vramGB — общий VRAM, modelWeightsGB — что уже занято весами модели.
 *   availableForKVGb = vramGB - modelWeightsGB - 1.5 (overhead).
 * @param {(targetTokens: number, kvDtype: string) => void} [opts.onChange]
 * @param {(targetTokens: number, kvDtype: string) => Promise<void>} [opts.onApply]
 * @param {() => Promise<void>} [opts.onRevert]
 * @param {"full"|"compact"|"embedded"} [opts.mode]
 * @param {number} [opts.initialTokens]
 * @returns {HTMLElement}
 */
export function buildContextSlider(opts) {
  const mode = opts.mode || "full";
  const root = el("div", { class: `context-slider context-slider-${mode}` });

  /** @type {{ targetTokens: number; kvDtype: "fp16"|"q8_0"|"q4_0"; rec: any; arch: any; suggestions: any[]; hasActivePatch: boolean; hasBackup: boolean | null }} */
  const STATE = {
    targetTokens: opts.initialTokens || 32768,
    kvDtype: "fp16",
    rec: null,
    arch: null,
    suggestions: [],
    hasActivePatch: false,
    /** Tri-state: null while initial probe in flight, then boolean. */
    hasBackup: null,
  };

  // ── Скелет ───────────────────────────────────────────────────────────────
  const header = el("div", { class: "ctx-header" }, [
    el("span", { class: "ctx-eyebrow" }, t("ctx.eyebrow")),
    el("span", { class: "ctx-title" }, t("ctx.title")),
  ]);

  const presetsRow = el("div", { class: "ctx-presets", role: "tablist", "aria-label": t("ctx.presets.aria") });
  const sliderInput = /** @type {HTMLInputElement} */ (
    el("input", {
      type: "range",
      class: "ctx-range",
      min: "0",
      max: String(PRESETS.length - 1),
      step: "1",
      value: "0",
      "aria-label": t("ctx.range.aria"),
    })
  );
  const sliderLabel = el("div", { class: "ctx-current", "aria-live": "polite" });
  const vramBar = el("div", { class: "ctx-vram", "aria-hidden": "true" }, [
    el("div", { class: "ctx-vram-fill" }),
    el("div", { class: "ctx-vram-label" }, ""),
  ]);
  const suggestionsBox = el("div", { class: "ctx-suggestions" });
  const detailsBlock = el("details", { class: "ctx-details" }, [
    el("summary", {}, t("ctx.details.summary")),
    el("div", { class: "ctx-details-body" }, ""),
  ]);
  const actionsBar = el("div", { class: "ctx-actions" });

  root.appendChild(header);
  root.appendChild(presetsRow);
  root.appendChild(sliderInput);
  root.appendChild(sliderLabel);
  if (mode !== "compact") root.appendChild(vramBar);
  if (mode !== "compact") root.appendChild(suggestionsBox);
  if (mode !== "compact") root.appendChild(detailsBlock);
  if (mode === "full") root.appendChild(actionsBar);

  // ── Presets ──────────────────────────────────────────────────────────────
  PRESETS.forEach((preset, idx) => {
    const btn = el(
      "button",
      {
        type: "button",
        class: "ctx-preset",
        role: "tab",
        "data-preset": preset.id,
        "data-idx": String(idx),
        "aria-selected": "false",
        title: t(`ctx.preset.${preset.id}.tooltip`),
      },
      [
        el("span", { class: "ctx-preset-icon", "aria-hidden": "true" }, preset.icon),
        el("span", { class: "ctx-preset-label" }, t(`ctx.preset.${preset.id}.label`)),
        el("span", { class: "ctx-preset-meta" }, t(`ctx.preset.${preset.id}.meta`)),
      ]
    );
    btn.addEventListener("click", () => {
      STATE.targetTokens = preset.tokens;
      sliderInput.value = String(idx);
      refresh();
    });
    presetsRow.appendChild(btn);
  });

  sliderInput.addEventListener("input", () => {
    const idx = Number(sliderInput.value);
    const preset = PRESETS[Math.max(0, Math.min(idx, PRESETS.length - 1))];
    if (preset) {
      STATE.targetTokens = preset.tokens;
      refresh();
    }
  });

  // ── Загрузка начального состояния ────────────────────────────────────────
  void initialize();

  async function initialize() {
    try {
      const cur = await window.api.yarn.readCurrent(opts.modelKey).catch(() => null);
      if (cur && typeof cur.factor === "number" && typeof cur.original_max_position_embeddings === "number") {
        STATE.targetTokens = Math.round(cur.factor * cur.original_max_position_embeddings);
        STATE.hasActivePatch = true;
      } else {
        STATE.hasActivePatch = false;
      }
      const idx = nearestPresetIdx(STATE.targetTokens);
      sliderInput.value = String(idx);
    } catch {
      STATE.hasActivePatch = false;
    }
    await refreshBackupBadge();
    await refresh();
  }

  async function refresh() {
    const availableForKVGb = computeAvailableKv(opts.hardware);
    /** @type {any} */
    const result = await window.api.yarn
      .recommend(opts.modelKey, STATE.targetTokens, availableForKVGb)
      .catch(() => null);
    if (!result) {
      sliderLabel.textContent = t("ctx.error.recommend");
      return;
    }
    STATE.arch = result.arch;
    STATE.rec = result.recommendation;
    STATE.suggestions = result.suggestions || [];

    // Авто-выбор kvDtype если ещё не вмешивался пользователь и FP16 не лезет
    if (availableForKVGb != null) {
      if (result.recommendation.kvVariants.fp16.gb > availableForKVGb) {
        if (result.recommendation.kvVariants.q8_0.gb <= availableForKVGb) STATE.kvDtype = "q8_0";
        else STATE.kvDtype = "q4_0";
      }
    }

    renderCurrentLabel();
    renderVram(availableForKVGb);
    renderSuggestions();
    renderDetails();
    renderActions();

    if (typeof opts.onChange === "function") {
      opts.onChange(STATE.targetTokens, STATE.kvDtype);
    }

    // Подсветка пресета
    const activeIdx = nearestPresetIdx(STATE.targetTokens);
    presetsRow.querySelectorAll(".ctx-preset").forEach((node, i) => {
      const isActive = i === activeIdx;
      node.classList.toggle("ctx-preset-active", isActive);
      node.setAttribute("aria-selected", isActive ? "true" : "false");
    });
  }

  function renderCurrentLabel() {
    const preset = PRESETS[nearestPresetIdx(STATE.targetTokens)];
    const tokensStr = formatTokens(STATE.targetTokens);
    const pages = preset ? preset.approxPages : Math.round(STATE.targetTokens / 525);
    sliderLabel.textContent = t("ctx.current.you_here", { tokens: tokensStr, pages });
  }

  function renderVram(availableForKVGb) {
    if (mode === "compact") return;
    const fill = vramBar.querySelector(".ctx-vram-fill");
    const label = vramBar.querySelector(".ctx-vram-label");
    if (!fill || !label) return;

    const kv = STATE.rec?.kvVariants?.[STATE.kvDtype];
    if (!kv) {
      label.textContent = t("ctx.vram.unknown");
      /** @type {HTMLElement} */ (fill).style.width = "0%";
      return;
    }

    if (availableForKVGb == null) {
      label.textContent = t("ctx.vram.kv_only", { gb: kv.gb });
      /** @type {HTMLElement} */ (fill).style.width = "50%";
      vramBar.classList.remove("ctx-vram-warn", "ctx-vram-danger");
      return;
    }

    const total = (opts.hardware?.vramGB ?? 0);
    const weights = (opts.hardware?.modelWeightsGB ?? 0);
    const used = weights + kv.gb + 1.5; // +overhead
    const pct = total > 0 ? Math.min(100, Math.max(0, (used / total) * 100)) : 50;
    /** @type {HTMLElement} */ (fill).style.width = `${pct}%`;

    const fits = used <= total;
    vramBar.classList.toggle("ctx-vram-warn", !fits);
    vramBar.classList.toggle("ctx-vram-danger", used > total * 1.1);

    label.textContent = fits
      ? t("ctx.vram.fits", { used: round1(used), total: round1(total) })
      : t("ctx.vram.no_fit", { used: round1(used), total: round1(total) });
  }

  function renderSuggestions() {
    if (mode === "compact") return;
    clear(suggestionsBox);
    for (const s of STATE.suggestions) {
      const card = el("div", { class: `ctx-sug ctx-sug-${s.severity}` }, [
        el("div", { class: "ctx-sug-icon", "aria-hidden": "true" }, suggestionIcon(s.severity)),
        el("div", { class: "ctx-sug-body" }, t(`ctx.sug.${s.id}`, s.params || {})),
        s.action ? buildSuggestionAction(s) : null,
      ].filter(Boolean));
      suggestionsBox.appendChild(card);
    }
  }

  function buildSuggestionAction(s) {
    const labelKey = `ctx.sug.action.${s.action.kind}`;
    const btn = el(
      "button",
      { class: "btn btn-ghost ctx-sug-action", type: "button" },
      t(labelKey)
    );
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        if (s.action.kind === "set-kv-dtype") {
          STATE.kvDtype = s.action.dtype;
        } else if (s.action.kind === "disable-yarn") {
          // Двигаем slider на native
          const native = STATE.arch?.nativeTokens ?? STATE.targetTokens;
          STATE.targetTokens = native;
          sliderInput.value = String(nearestPresetIdx(native));
        } else if (s.action.kind === "lower-target") {
          STATE.targetTokens = s.action.suggestedTokens;
          sliderInput.value = String(nearestPresetIdx(s.action.suggestedTokens));
        }
        await refresh();
      } finally {
        btn.disabled = false;
      }
    });
    return btn;
  }

  function renderDetails() {
    if (mode === "compact") return;
    const body = detailsBlock.querySelector(".ctx-details-body");
    if (!body) return;
    const arch = STATE.arch;
    const rec = STATE.rec;
    if (!arch || !rec) {
      body.textContent = "";
      return;
    }
    body.textContent = "";
    const grid = el("div", { class: "ctx-detail-grid" });
    appendDetail(grid, "ctx.details.model", arch.displayName);
    appendDetail(grid, "ctx.details.native", `${formatTokens(arch.nativeTokens)} (${arch.nativeTokens.toLocaleString()})`);
    appendDetail(grid, "ctx.details.yarn_max", formatTokens(arch.yarnMaxTokens));
    appendDetail(
      grid,
      "ctx.details.factor",
      rec.ropeScaling ? `×${rec.ropeScaling.factor}` : t("ctx.details.factor_none")
    );
    appendDetail(grid, "ctx.details.kv_fp16", `${rec.kvVariants.fp16.gb} GB`);
    appendDetail(grid, "ctx.details.kv_q8", `${rec.kvVariants.q8_0.gb} GB`);
    appendDetail(grid, "ctx.details.kv_q4", `${rec.kvVariants.q4_0.gb} GB`);
    appendDetail(grid, "ctx.details.architecture", `L=${arch.nLayers} · KV-heads=${arch.nKvHeads} · head_dim=${arch.headDim}`);
    body.appendChild(grid);

    if (rec.ropeScaling) {
      const json = JSON.stringify({ rope_scaling: rec.ropeScaling }, null, 2);
      body.appendChild(
        el("pre", { class: "ctx-rope-json" }, json)
      );
    }
  }

  /**
   * Render Apply / Revert buttons + a backup-availability badge.
   *
   * The backup badge is queried from the main process via
   * `yarn.hasBackup(modelKey)`. If `true`, the user is shown that
   * Revert is non-destructive (we have the original config to restore).
   * If `false`, Revert button is hidden (we cannot guarantee a clean
   * rollback).
   */
  function renderActions() {
    if (mode !== "full") return;
    clear(actionsBar);

    const applyBtn = el(
      "button",
      {
        class: "btn btn-gold",
        type: "button",
        disabled: opts.onApply ? null : "true",
      },
      t(STATE.rec?.yarnRequired ? "ctx.actions.apply" : "ctx.actions.apply_none")
    );
    applyBtn.addEventListener("click", async () => {
      if (!opts.onApply) return;
      applyBtn.disabled = true;
      try {
        await opts.onApply(STATE.targetTokens, STATE.kvDtype);
        STATE.hasActivePatch = STATE.rec?.yarnRequired;
        await refreshBackupBadge();
        renderActions();
      } finally {
        applyBtn.disabled = false;
      }
    });
    actionsBar.appendChild(applyBtn);

    if (STATE.hasActivePatch) {
      actionsBar.appendChild(buildBackupBadge());
      if (opts.onRevert && STATE.hasBackup) {
        const revertBtn = el(
          "button",
          { class: "btn btn-ghost", type: "button" },
          t("ctx.actions.revert")
        );
        revertBtn.addEventListener("click", async () => {
          revertBtn.disabled = true;
          try {
            await opts.onRevert();
            STATE.hasActivePatch = false;
            await refreshBackupBadge();
            renderActions();
          } finally {
            revertBtn.disabled = false;
          }
        });
        actionsBar.appendChild(revertBtn);
      }
    }
  }

  function buildBackupBadge() {
    const ok = STATE.hasBackup === true;
    const checking = STATE.hasBackup === null;
    const cls = checking
      ? "ctx-backup-badge ctx-backup-checking"
      : ok
        ? "ctx-backup-badge ctx-backup-ok"
        : "ctx-backup-badge ctx-backup-missing";
    const labelKey = checking
      ? "ctx.backup.checking"
      : ok
        ? "ctx.backup.available"
        : "ctx.backup.missing";
    const tooltipKey = checking
      ? "ctx.backup.checking.tooltip"
      : ok
        ? "ctx.backup.available.tooltip"
        : "ctx.backup.missing.tooltip";
    return el("span", { class: cls, title: t(tooltipKey) }, t(labelKey));
  }

  async function refreshBackupBadge() {
    if (!opts.modelKey) {
      STATE.hasBackup = false;
      return;
    }
    try {
      STATE.hasBackup = Boolean(await window.api.yarn.hasBackup(opts.modelKey));
    } catch {
      STATE.hasBackup = false;
    }
  }

  // Публичный API для embedded-режима
  Object.assign(root, {
    /** @returns {{ targetTokens: number; kvDtype: string }} */
    getValue: () => ({ targetTokens: STATE.targetTokens, kvDtype: STATE.kvDtype }),
    refresh,
  });

  return root;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const PRESETS = [
  { id: "chat",     icon: "💬", tokens: 8_192,     approxPages: 16 },
  { id: "document", icon: "📄", tokens: 32_768,    approxPages: 60 },
  { id: "book",     icon: "📖", tokens: 131_072,   approxPages: 250 },
  { id: "codex",    icon: "📚", tokens: 262_144,   approxPages: 500 },
  { id: "library",  icon: "🏛", tokens: 1_048_576, approxPages: 2000 },
];

function nearestPresetIdx(target) {
  let idx = 0;
  let bestDelta = Infinity;
  for (let i = 0; i < PRESETS.length; i++) {
    const delta = Math.abs(PRESETS[i].tokens - target);
    if (delta < bestDelta) {
      bestDelta = delta;
      idx = i;
    }
  }
  return idx;
}

function formatTokens(n) {
  if (n >= 1_000_000) return `${Math.round((n / 1_000_000) * 10) / 10}M`;
  if (n >= 1_000) return `${Math.round(n / 1024)}K`;
  return String(n);
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function suggestionIcon(severity) {
  switch (severity) {
    case "good": return "✓";
    case "warn": return "⚠";
    case "tip":  return "💡";
    default:     return "ℹ";
  }
}

function appendDetail(parent, labelKey, value) {
  parent.appendChild(el("div", { class: "ctx-detail-label" }, t(labelKey)));
  parent.appendChild(el("div", { class: "ctx-detail-value" }, value));
}

function computeAvailableKv(hw) {
  if (!hw || typeof hw.vramGB !== "number") return null;
  const weights = typeof hw.modelWeightsGB === "number" ? hw.modelWeightsGB : 0;
  const overhead = 1.5;
  return Math.max(0, hw.vramGB - weights - overhead);
}
