// @ts-check
/**
 * Pipeline Status Widget — индикатор состояния import-pipeline в реальном времени.
 *
 * ПОКАЗЫВАЕТ:
 *   1. Lanes counters (light/medium/heavy) с running + queued — что делает
 *      ImportTaskScheduler прямо сейчас.
 *   2. VRAM Pressure bar — totalLoadedMB / capacityMB от LM Studio watchdog.
 *      Цвет меняется: зелёный <70%, жёлтый 70-85%, красный >85%.
 *   3. Иt 8В MAIN.4: Loaded Models — таблица «роль → модель → busy/idle/VRAM/weight»
 *      из ModelPool snapshot. Показывает ЧТО конкретно держит pipeline в VRAM,
 *      а не только агрегированные lane counters.
 *
 * АРХИТЕКТУРНЫЙ КОНТРАКТ:
 *   - Read-only: только подписка на IPC events, ничего не вызывает в main.
 *   - Idempotent mount/unmount: можно вызывать повторно безопасно.
 *   - Graceful degradation: если api.resilience недоступен (старая сборка) —
 *     виджет не падает, просто не показывает данные.
 *
 * ИНТЕГРАЦИЯ (текущее состояние):
 *   Виджет монтируется в Models page через `models-hardware-status.js:buildHwStrip()`
 *   и сохраняется как `pipelineWidgetUnmount` для idempotent re-render. Page
 *   lifecycle освобождает через `unmountHwStrip()`. API остаётся public —
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
 * @property {LaneCounters} light
 * @property {LaneCounters} medium
 * @property {LaneCounters} heavy
 *
 * Иt 8В.MAIN.1.5: io lane удалена из scheduler — была мёртвая (нет
 * production caller'ов). Если вернётся — добавить обратно `io: LaneCounters`
 * и buildLaneRow в DOM.
 */

/**
 * @typedef {Object} PressureSnapshot
 * @property {number} totalLoadedMB
 * @property {number} capacityMB
 * @property {number} pressureRatio
 * @property {number} loadedModels
 */

/**
 * @typedef {Object} ModelEntry
 * @property {string} modelKey
 * @property {string} [role]
 * @property {"light" | "medium" | "heavy"} weight
 * @property {number} refCount
 * @property {number} vramMB
 * @property {"pool" | "external"} source
 */

/**
 * @typedef {Object} ModelPoolSnapshot
 * @property {number} capacityMB
 * @property {number} totalLoadedMB
 * @property {number} loadedCount
 * @property {ReadonlyArray<ModelEntry>} models
 */

const EMPTY_SNAPSHOT = /** @type {SchedulerSnapshot} */ ({
  light:  { running: 0, queued: 0 },
  medium: { running: 0, queued: 0 },
  heavy:  { running: 0, queued: 0 },
});

const EMPTY_MODEL_POOL_SNAPSHOT = /** @type {ModelPoolSnapshot} */ ({
  capacityMB: 0,
  totalLoadedMB: 0,
  loadedCount: 0,
  models: [],
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
  let currentModelPool = EMPTY_MODEL_POOL_SNAPSHOT;
  let unsubScheduler = /** @type {(() => void) | null} */ (null);
  let unsubPressure = /** @type {(() => void) | null} */ (null);
  let unsubModelPool = /** @type {(() => void) | null} */ (null);

  const render = () => {
    clear(rootEl);
    rootEl.appendChild(buildWidgetDom(currentSnapshot, currentPressure, currentModelPool));
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
  if (api?.resilience?.onModelPoolSnapshot) {
    unsubModelPool = api.resilience.onModelPoolSnapshot(/** @param {ModelPoolSnapshot} snapshot */ (snapshot) => {
      currentModelPool = snapshot;
      render();
    });
  }

  return () => {
    if (unsubScheduler) unsubScheduler();
    if (unsubPressure) unsubPressure();
    if (unsubModelPool) unsubModelPool();
    unsubScheduler = null;
    unsubPressure = null;
    unsubModelPool = null;
    clear(rootEl);
  };
}

/**
 * @param {SchedulerSnapshot} snap
 * @param {PressureSnapshot | null} pressure
 * @param {ModelPoolSnapshot} modelPool
 * @returns {HTMLElement}
 */
function buildWidgetDom(snap, pressure, modelPool) {
  return el("div", { class: "pipeline-status-widget" }, [
    el("div", { class: "pipeline-status-lanes" }, [
      buildLaneRow("light", snap.light),
      buildLaneRow("medium", snap.medium),
      buildLaneRow("heavy", snap.heavy),
    ]),
    buildPressureRow(pressure),
    buildModelPoolSection(modelPool),
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

/**
 * Иt 8В MAIN.4: «Loaded models» — таблица «роль → модель → busy/idle/VRAM/weight».
 * Если пул пуст — показываем placeholder. Сортировка: busy (refCount>0) сверху,
 * затем по weight (heavy → medium → light), затем по lastUsed implicitly через
 * порядок stats.models (сохранён как Map insertion order).
 *
 * @param {ModelPoolSnapshot} pool
 */
function buildModelPoolSection(pool) {
  if (!pool || pool.loadedCount === 0) {
    return el("div", { class: "pipeline-models pipeline-models--empty" }, [
      el("span", { class: "pipeline-models__title" }, "Loaded models"),
      el("span", { class: "pipeline-models__placeholder" }, "no models in VRAM"),
    ]);
  }

  /* Сортировка: busy первыми, затем по приоритету eviction (heavy первым). */
  const weightRank = { heavy: 0, medium: 1, light: 2 };
  const sorted = [...pool.models].sort((a, b) => {
    const busyDiff = (b.refCount > 0 ? 1 : 0) - (a.refCount > 0 ? 1 : 0);
    if (busyDiff !== 0) return busyDiff;
    return (weightRank[a.weight] ?? 9) - (weightRank[b.weight] ?? 9);
  });

  return el("div", { class: "pipeline-models" }, [
    el("div", { class: "pipeline-models__header" }, [
      el("span", { class: "pipeline-models__title" }, "Loaded models"),
      el("span", { class: "pipeline-models__count" },
        `${pool.loadedCount} loaded · ${(pool.totalLoadedMB / 1024).toFixed(1)} GB`),
    ]),
    el("div", { class: "pipeline-models__list" },
      sorted.map(buildModelRow)),
  ]);
}

/**
 * @param {ModelEntry} entry
 */
function buildModelRow(entry) {
  const isBusy = entry.refCount > 0;
  const stateLabel = isBusy ? `busy×${entry.refCount}` : "idle";
  const sourceLabel = entry.source === "external" ? " · external" : "";
  return el("div", {
    class: `pipeline-model pipeline-model--${entry.weight}${isBusy ? " is-busy" : " is-idle"}`,
  }, [
    el("span", { class: "pipeline-model__role" }, entry.role ?? "—"),
    el("span", { class: "pipeline-model__key" }, entry.modelKey),
    el("span", { class: `pipeline-model__weight pipeline-model__weight--${entry.weight}` }, entry.weight),
    el("span", { class: "pipeline-model__vram" }, `${(entry.vramMB / 1024).toFixed(1)} GB`),
    el("span", { class: `pipeline-model__state pipeline-model__state--${isBusy ? "busy" : "idle"}` },
      `${stateLabel}${sourceLabel}`),
  ]);
}

/* ─── Test helpers (named exports for unit tests) ──────────────────────── */

/** Сборка DOM для конкретного snapshot — без подписки на IPC. Используется в тестах. */
export function _buildWidgetDomForTests(snap, pressure, modelPool) {
  return buildWidgetDom(snap, pressure, modelPool ?? EMPTY_MODEL_POOL_SNAPSHOT);
}

/** Дефолтный пустой snapshot — для тестов. */
export function _getEmptySnapshot() {
  return EMPTY_SNAPSHOT;
}

/** Дефолтный пустой model-pool snapshot — для тестов. */
export function _getEmptyModelPoolSnapshot() {
  return EMPTY_MODEL_POOL_SNAPSHOT;
}
