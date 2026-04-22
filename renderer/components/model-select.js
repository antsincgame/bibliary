// @ts-check
import { el } from "../dom.js";
import { t } from "../i18n.js";

/**
 * @file model-select.js — единый компонент выбора модели LM Studio с persist в preferences.
 *
 * Цель: устранить дубликаты в Crystal/Agent/Chat (4 разные реализации одного селектора).
 *
 * Источник моделей — ВСЕГДА `window.api.lmstudio.listLoaded()` (унифицируем
 * chat, который раньше использовал OpenAI-совместимый `getModels()`).
 *
 * Persistence — `preferences[role + "Model"]` (chatModel/agentModel/extractorModel/judgeModel),
 * добавлены в схему в коммите 51e1c60 (Phase 3 Удар 1).
 *
 * @typedef {"chat"|"agent"|"extractor"|"judge"} ModelRole
 *
 * @typedef {Object} LoadedModel
 * @property {string} modelKey
 * @property {string} [identifier]
 * @property {number} [contextLength]
 * @property {string} [quantization]
 *
 * @typedef {Object} ModelSelectOpts
 * @property {ModelRole} role - prefs key (записывается как role+"Model")
 * @property {string} [label] - подпись над select; если не передано — берётся из i18n по role
 * @property {boolean} [showContext] - добавлять " (contextLength)" к option label
 * @property {string} [selectId] - id для <select> (нужен chat для совместимости с index.html)
 * @property {string} [selectClass] - дополнительный CSS-класс для select
 * @property {string} [wrapClass] - CSS-класс для wrap div (default "model-select-wrap")
 * @property {string} [labelClass] - CSS-класс для label (default "model-select-label")
 * @property {boolean} [bare] - вернуть только select без обёртки (label не создаётся);
 *   полезно для случаев, когда родитель уже имеет свой layout (chat.js header).
 * @property {boolean} [loadOnSelect] - если true, в опции добавляются скачанные но
 *   не загруженные модели (с префиксом ↓), при выборе вызывается lmstudio.load().
 *   Решает кейс "нет загруженных моделей" в чате: пользователь выбирает из ВСЕХ
 *   доступных в LM Studio и Bibliary автоматически загружает выбранную.
 * @property {(modelKey: string) => void} [onChange] - дополнительный callback при изменении
 * @property {(modelKey: string) => void} [onLoaded] - вызывается после успешной загрузки
 *   модели через lmstudio.load (когда loadOnSelect=true и пользователь выбрал downloaded).
 * @property {(error: Error) => void} [onLoadError] - вызывается при ошибке load.
 * @property {string[]} [hints] - подсказки для pickModel-fallback (substring match по modelKey)
 *
 * @typedef {Object} ModelSelectInstance
 * @property {HTMLElement} wrap - обёртка с label + select; в bare-режиме === select
 * @property {HTMLSelectElement} select - сам select (для closures, .value, addEventListener)
 * @property {() => Promise<void>} refresh - перечитать listLoaded + перерисовать options
 * @property {() => string} getValue - текущее выбранное значение
 */

/** Подсказки по умолчанию — порядок предпочтения моделей (substring match). */
export const DEFAULT_MODEL_HINTS = ["qwen3.6", "qwen3-coder", "mistral-small", "qwen3.5", "qwen", "llama"];

/**
 * Выбирает лучшую модель из списка по приоритету подсказок (substring match по modelKey).
 * Если ни одна подсказка не сматчилась — возвращает первую в списке. Пустой список → "".
 *
 * Pure function (нет side effects) — тестируется напрямую без DOM.
 *
 * @param {LoadedModel[]} models
 * @param {string[]} [hints=DEFAULT_MODEL_HINTS]
 * @returns {string}
 */
export function pickBestModel(models, hints = DEFAULT_MODEL_HINTS) {
  if (!Array.isArray(models) || models.length === 0) return "";
  for (const h of hints) {
    const m = models.find((x) => x.modelKey?.toLowerCase().includes(h));
    if (m?.modelKey) return m.modelKey;
  }
  return models[0]?.modelKey ?? "";
}

/**
 * Debounced save в preferences. Один таймер на role — частый input не спамит fs.
 * @type {Map<ModelRole, ReturnType<typeof setTimeout>>}
 */
const _saveTimers = new Map();

/**
 * @param {ModelRole} role
 * @param {string} modelKey
 */
function persistChoice(role, modelKey) {
  const existing = _saveTimers.get(role);
  if (existing) clearTimeout(existing);
  _saveTimers.set(
    role,
    setTimeout(() => {
      _saveTimers.delete(role);
      const prefKey = role + "Model";
      void window.api.preferences
        .set({ [prefKey]: modelKey })
        .catch(() => { /* swallow — UI уже обновился */ });
    }, 300)
  );
}

/**
 * @param {LoadedModel[]} loaded
 * @param {LoadedModel[]} downloaded
 * @param {string} currentValue
 * @param {boolean} showContext
 * @returns {DocumentFragment}
 */
function buildOptions(loaded, downloaded, currentValue, showContext) {
  const frag = document.createDocumentFragment();
  const haveLoaded = Array.isArray(loaded) && loaded.length > 0;
  const haveDownloaded = Array.isArray(downloaded) && downloaded.length > 0;

  if (!haveLoaded && !haveDownloaded) {
    frag.appendChild(el("option", { value: "" }, t("modelSelect.noLoaded")));
    return frag;
  }

  if (haveLoaded) {
    const grp = /** @type {HTMLOptGroupElement} */ (
      el("optgroup", { label: t("modelSelect.group.loaded") })
    );
    for (const m of loaded) {
      const key = String(m.modelKey ?? "");
      const labelText = showContext && m.contextLength
        ? `${key} (${m.contextLength})`
        : key;
      const opt = el("option", { value: key }, labelText);
      if (key === currentValue) /** @type {HTMLOptionElement} */ (opt).selected = true;
      grp.appendChild(opt);
    }
    frag.appendChild(grp);
  }

  if (haveDownloaded) {
    const grp = /** @type {HTMLOptGroupElement} */ (
      el("optgroup", { label: t("modelSelect.group.downloaded") })
    );
    for (const m of downloaded) {
      const key = String(m.modelKey ?? "");
      const opt = el("option", { value: key }, `↓ ${key}`);
      grp.appendChild(opt);
    }
    frag.appendChild(grp);
  }

  return frag;
}

/**
 * Создать селектор модели с автоматическим persist в preferences.
 *
 * Поведение:
 * 1. На монтаж: читает prefs[role+"Model"] + listLoaded; если pref пуст или модель
 *    больше не загружена — fallback к pickBestModel(loaded, hints).
 * 2. На change: пишет в prefs (debounced 300ms) + вызывает onChange callback.
 * 3. Метод refresh() — перечитать listLoaded и перерисовать опции (kept value если
 *    модель ещё доступна).
 *
 * @param {ModelSelectOpts} opts
 * @returns {ModelSelectInstance}
 */
export function buildModelSelect(opts) {
  const role = opts.role;
  const labelText = opts.label ?? t(`modelSelect.label.${role}`);
  const wrapClass = opts.wrapClass ?? "model-select-wrap";
  const labelClass = opts.labelClass ?? "model-select-label";
  const selectClass = opts.selectClass ?? "model-select";
  const showContext = opts.showContext === true;
  const hints = Array.isArray(opts.hints) && opts.hints.length > 0 ? opts.hints : DEFAULT_MODEL_HINTS;

  /** @type {Record<string, string>} */
  const selectAttrs = { class: selectClass };
  if (opts.selectId) selectAttrs.id = opts.selectId;
  const select = /** @type {HTMLSelectElement} */ (el("select", selectAttrs));
  /** В bare-режиме wrap === select; никаких label/div не создаётся. */
  const wrap = opts.bare === true
    ? select
    : el("div", { class: wrapClass }, [el("label", { class: labelClass }, labelText), select]);

  /** @type {LoadedModel[]} */
  let loadedModels = [];
  /** @type {LoadedModel[]} */
  let downloadedOnly = [];
  let currentValue = "";
  let isLoading = false;

  async function loadAndApply() {
    /** @type {{ chatModel?: string, agentModel?: string, extractorModel?: string, judgeModel?: string }} */
    let prefs = {};
    try {
      prefs = /** @type {any} */ (await window.api.preferences.getAll());
    } catch { /* keep prefs empty */ }
    try {
      loadedModels = /** @type {LoadedModel[]} */ (
        await window.api.lmstudio.listLoaded()
      );
    } catch { loadedModels = []; }

    if (opts.loadOnSelect) {
      try {
        const all = /** @type {LoadedModel[]} */ (
          await window.api.lmstudio.listDownloaded()
        );
        const loadedKeys = new Set(loadedModels.map((m) => m.modelKey));
        downloadedOnly = all.filter((m) => m.modelKey && !loadedKeys.has(m.modelKey));
      } catch { downloadedOnly = []; }
    } else {
      downloadedOnly = [];
    }

    const prefValue = String(prefs[role + "Model"] ?? "");
    const stillLoaded = prefValue && loadedModels.some((m) => m.modelKey === prefValue);
    currentValue = stillLoaded ? prefValue : pickBestModel(loadedModels, hints);

    /* Если pickBestModel дал значение и pref был пуст/устарел — сразу запишем,
       чтобы другие экземпляры/экраны видели согласованное состояние. */
    if (currentValue && currentValue !== prefValue) {
      persistChoice(role, currentValue);
    }

    while (select.firstChild) select.removeChild(select.firstChild);
    select.appendChild(buildOptions(loadedModels, downloadedOnly, currentValue, showContext));
    /* В loadOnSelect-режиме НЕ блокируем select даже при пустом loaded —
       пользователь должен иметь возможность выбрать downloaded и автозагрузить. */
    select.disabled = loadedModels.length === 0 && downloadedOnly.length === 0;
  }

  async function handleSelectChange() {
    const value = select.value;
    const isDownloaded = downloadedOnly.some((m) => m.modelKey === value);
    if (isDownloaded && opts.loadOnSelect && !isLoading) {
      isLoading = true;
      const previousLabel = select.options[select.selectedIndex]?.textContent ?? value;
      const loadingOpt = select.options[select.selectedIndex];
      if (loadingOpt) loadingOpt.textContent = `${t("modelSelect.loading")} ${value}`;
      select.disabled = true;
      try {
        await window.api.lmstudio.load(value);
        await loadAndApply();
        if (typeof opts.onLoaded === "function") {
          try { opts.onLoaded(value); } catch { /* user callback */ }
        }
      } catch (err) {
        if (loadingOpt) loadingOpt.textContent = previousLabel;
        select.disabled = false;
        const error = err instanceof Error ? err : new Error(String(err));
        if (typeof opts.onLoadError === "function") {
          try { opts.onLoadError(error); } catch { /* user callback */ }
        }
        return;
      } finally {
        isLoading = false;
      }
    }
    currentValue = select.value;
    persistChoice(role, currentValue);
    if (typeof opts.onChange === "function") {
      try { opts.onChange(currentValue); } catch { /* user callback */ }
    }
  }

  select.addEventListener("change", () => { void handleSelectChange(); });

  /* Стартовая загрузка — асинхронно, не блокируем render. */
  void loadAndApply();

  return {
    wrap,
    select,
    refresh: loadAndApply,
    getValue: () => currentValue,
  };
}
