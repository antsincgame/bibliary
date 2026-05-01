// @ts-check
/**
 * Pipeline Status Widget — индикатор состояния import-pipeline в реальном времени.
 *
 * ПОКАЗЫВАЕТ:
 *   1. Lanes counters (light/medium/heavy) с running + queued — что делает
 *      ImportTaskScheduler прямо сейчас.
 *   2. VRAM Pressure bar — totalLoadedMB / capacityMB от LM Studio watchdog.
 *      Цвет меняется: зелёный <70%, жёлтый 70-85%, красный >85%.
 *
 * АРХИТЕКТУРНЫЙ КОНТРАКТ:
 *   - Read-only: только подписка на IPC events, ничего не вызывает в main.
 *   - Idempotent mount/unmount: можно вызывать повторно безопасно.
 *   - Graceful degradation: если api.resilience недоступен (старая сборка) —
 *     виджет не падает, просто не показывает данные.
 *
 * Интеграция в существующие страницы (models-page / library) — отдельный шаг
 * следующих итераций. Этот файл предоставляет готовый API:
 *   `mountPipelineStatusWidget(rootEl)` → returns `unmount()` callback.
 */

import { el, clear } from "../dom.js";

/**
 * @typedef {Object} LaneCounters
 * @property {number} running
 * @property {number} queued
 */

/**
 * @typedef {Object} SchedulerSnapshot
 * @property {LaneCounters} io
 * @property {LaneCounters} light
 * @property {LaneCounters} medium
 * @property {LaneCounters} heavy
 */

/**
 * @typedef {Object} PressureSnapshot
 * @property {number} totalLoadedMB
 * @property {number} capacityMB
 * @property {number} pressureRatio
 * @property {number} loadedModels
 */

const EMPTY_SNAPSHOT = /** @type {SchedulerSnapshot} */ ({
  io:     { running: 0, queued: 0 },
  light:  { running: 0, queued: 0 },
  medium: { running: 0, queued: 0 },
  heavy:  { running: 0, queued: 0 },
});

/**
 * Смонтировать виджет в указанный DOM-элемент. Возвращает unmount() callback.
 *
 * @param {HTMLElement} rootEl
 * @returns {() => void}
 */
export function mountPipelineStatusWidget(rootEl) {
  if (!rootEl) {
    return () => undefined;
  }

  let currentSnapshot = EMPTY_SNAPSHOT;
  let currentPressure = /** @type {PressureSnapshot | null} */ (null);
  let unsubScheduler = /** @type {(() => void) | null} */ (null);
  let unsubPressure = /** @type {(() => void) | null} */ (null);

  const render = () => {
    clear(rootEl);
    rootEl.appendChild(buildWidgetDom(currentSnapshot, currentPressure));
  };

  /* Initial render — показываем пустое состояние сразу, не ждём первого events. */
  render();

  /* Подписка на scheduler snapshot — graceful если api отсутствует. */
  const api = /** @type {any} */ (typeof window !== "undefined" ? window : {}).api;
  if (api?.resilience?.onSchedulerSnapshot) {
    unsubScheduler = api.resilience.onSchedulerSnapshot(/** @param {SchedulerSnapshot} snapshot */ (snapshot) => {
      currentSnapshot = snapshot;
      render();
    });
  }
  if (api?.resilience?.onLmstudioPressure) {
    unsubPressure = api.resilience.onLmstudioPressure(/** @param {PressureSnapshot} snapshot */ (snapshot) => {
      currentPressure = snapshot;
      render();
    });
  }

  return () => {
    if (unsubScheduler) unsubScheduler();
    if (unsubPressure) unsubPressure();
    unsubScheduler = null;
    unsubPressure = null;
    clear(rootEl);
  };
}

/**
 * @param {SchedulerSnapshot} snap
 * @param {PressureSnapshot | null} pressure
 * @returns {HTMLElement}
 */
function buildWidgetDom(snap, pressure) {
  return el("div", { class: "pipeline-status-widget" }, [
    el("div", { class: "pipeline-status-lanes" }, [
      buildLaneRow("light", snap.light),
      buildLaneRow("medium", snap.medium),
      buildLaneRow("heavy", snap.heavy),
    ]),
    buildPressureRow(pressure),
  ]);
}

/**
 * @param {string} label
 * @param {LaneCounters} counters
 */
function buildLaneRow(label, counters) {
  const isActive = counters.running > 0 || counters.queued > 0;
  return el("div", { class: `pipeline-lane pipeline-lane--${label}${isActive ? " is-active" : ""}` }, [
    el("span", { class: "pipeline-lane__label" }, label),
    el("span", { class: "pipeline-lane__counter" }, [
      el("strong", null, String(counters.running)),
      el("span", { class: "pipeline-lane__sep" }, " / "),
      el("span", null, `${counters.queued} queued`),
    ]),
  ]);
}

/**
 * @param {PressureSnapshot | null} pressure
 */
function buildPressureRow(pressure) {
  if (!pressure || pressure.capacityMB <= 0) {
    return el("div", { class: "pipeline-pressure pipeline-pressure--unknown" }, [
      el("span", { class: "pipeline-pressure__label" }, "VRAM"),
      el("span", { class: "pipeline-pressure__text" }, "—"),
    ]);
  }
  const ratio = Math.max(0, Math.min(1, pressure.pressureRatio));
  const pct = Math.round(ratio * 100);
  /* Цветовая зона: <70% green, 70..85% yellow, >85% red. */
  const zone = pct < 70 ? "ok" : pct < 85 ? "warn" : "crit";
  const usedGB = (pressure.totalLoadedMB / 1024).toFixed(1);
  const capGB = (pressure.capacityMB / 1024).toFixed(1);
  return el("div", { class: `pipeline-pressure pipeline-pressure--${zone}` }, [
    el("span", { class: "pipeline-pressure__label" }, "VRAM"),
    el("div", { class: "pipeline-pressure__bar" }, [
      el("div", { class: "pipeline-pressure__fill", style: `width: ${pct}%` }, ""),
    ]),
    el("span", { class: "pipeline-pressure__text" }, `${usedGB} / ${capGB} GB · ${pct}% · ${pressure.loadedModels} loaded`),
  ]);
}

/* ─── Test helpers (named exports for unit tests) ──────────────────────── */

/** Сборка DOM для конкретного snapshot — без подписки на IPC. Используется в тестах. */
export function _buildWidgetDomForTests(snap, pressure) {
  return buildWidgetDom(snap, pressure);
}

/** Дефолтный пустой snapshot — для тестов. */
export function _getEmptySnapshot() {
  return EMPTY_SNAPSHOT;
}
