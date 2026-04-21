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
 * @property {(modelKey: string) => void} [onChange] - дополнительный callback при изменении
 * @property {string[]} [hints] - подсказки для pickModel-fallback (substring match по modelKey)
 *
 * @typedef {Object} ModelSelectInstance
 * @property {HTMLElement} wrap - готовая обёртка с label + select для append'а
 * @property {HTMLSelectElement} select - сам select (для closures, .value, addEventListener)
 * @property {() => Promise<void>} refresh - перечитать listLoaded + перерисовать options
 * @property {() => string} getValue - текущее выбранное значение
 */

/** Подписки для синхронизации между несколькими экземплярами на одной странице. */
const _instances = new Set();

/** Подсказки по умолчанию — порядок предпочтения моделей (substring match). */
const DEFAULT_HINTS = ["qwen3.6", "qwen3-coder", "mistral-small", "qwen3.5", "qwen", "llama"];

/**
 * @param {LoadedModel[]} models
 * @param {string[]} hints
 * @returns {string}
 */
function pickBestModel(models, hints) {
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
 * @param {LoadedModel[]} models
 * @param {string} currentValue
 * @param {boolean} showContext
 * @returns {DocumentFragment}
 */
function buildOptions(models, currentValue, showContext) {
  const frag = document.createDocumentFragment();
  if (!Array.isArray(models) || models.length === 0) {
    frag.appendChild(
      el("option", { value: "" }, t("modelSelect.noLoaded"))
    );
    return frag;
  }
  for (const m of models) {
    const key = String(m.modelKey ?? "");
    const labelText = showContext && m.contextLength
      ? `${key} (${m.contextLength})`
      : key;
    const opt = el("option", { value: key }, labelText);
    if (key === currentValue) /** @type {HTMLOptionElement} */ (opt).selected = true;
    frag.appendChild(opt);
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
  const hints = Array.isArray(opts.hints) && opts.hints.length > 0 ? opts.hints : DEFAULT_HINTS;

  const labelEl = el("label", { class: labelClass }, labelText);
  /** @type {Record<string, string>} */
  const selectAttrs = { class: selectClass };
  if (opts.selectId) selectAttrs.id = opts.selectId;
  const select = /** @type {HTMLSelectElement} */ (el("select", selectAttrs));
  const wrap = el("div", { class: wrapClass }, [labelEl, select]);

  /** @type {LoadedModel[]} */
  let models = [];
  let currentValue = "";

  async function loadAndApply() {
    /** @type {{ chatModel?: string, agentModel?: string, extractorModel?: string, judgeModel?: string }} */
    let prefs = {};
    try {
      prefs = /** @type {any} */ (await window.api.preferences.getAll());
    } catch { /* keep prefs empty */ }
    try {
      models = /** @type {LoadedModel[]} */ (
        await window.api.lmstudio.listLoaded()
      );
    } catch { models = []; }

    const prefValue = String(prefs[role + "Model"] ?? "");
    const stillLoaded = prefValue && models.some((m) => m.modelKey === prefValue);
    currentValue = stillLoaded ? prefValue : pickBestModel(models, hints);

    /* Если pickBestModel дал значение и pref был пуст/устарел — сразу запишем,
       чтобы другие экземпляры/экраны видели согласованное состояние. */
    if (currentValue && currentValue !== prefValue) {
      persistChoice(role, currentValue);
    }

    while (select.firstChild) select.removeChild(select.firstChild);
    select.appendChild(buildOptions(models, currentValue, showContext));
    select.disabled = models.length === 0;
  }

  select.addEventListener("change", () => {
    currentValue = select.value;
    persistChoice(role, currentValue);
    if (typeof opts.onChange === "function") {
      try { opts.onChange(currentValue); } catch { /* пользователь сам отвечает за свой callback */ }
    }
  });

  /* Стартовая загрузка — асинхронно, не блокируем render. */
  void loadAndApply();

  const instance = {
    wrap,
    select,
    refresh: loadAndApply,
    getValue: () => currentValue,
  };
  _instances.add(instance);
  return instance;
}

/**
 * Перечитать listLoaded во ВСЕХ активных экземплярах. Полезно при глобальной
 * операции "обновить список" — например при mount нового экрана или после load/unload.
 * @returns {Promise<void>}
 */
export async function refreshAllModelSelects() {
  const all = Array.from(_instances);
  await Promise.all(all.map((inst) => inst.refresh().catch(() => undefined)));
}
