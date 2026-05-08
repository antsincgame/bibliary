/**
 * Простой model resolver — замена комплексной системы 9 ролей.
 *
 * Контракт: 3 prefs соответствуют 3 задачам:
 *   - `readerModel` — small fast model для evaluation/lang-detection/light tasks
 *   - `extractorModel` — big reasoning model для concept extraction (datasets)
 *   - `visionOcrModel` — optional vision model для OCR scanned books
 *
 * Цель этого модуля:
 *   - Один источник истины: Bibliary спрашивает «какой modelKey для reader?»,
 *     получает строку или null.
 *   - Никакого fallback chain между ролями (раньше: crystallizer → ukrainian
 *     → vision_meta).
 *   - Никакого capability filtering (vision/text). Пользователь сам решает
 *     какую модель куда назначить.
 *   - Никакого автоматического запуска моделей. Если модель в pref не
 *     загружена в LM Studio — возвращаем null, caller сам решает что делать
 *     (либо warning, либо load на лету через model-pool).
 *
 * Этот модуль живёт ПАРАЛЛЕЛЬНО со старым `model-role-resolver.ts` на время
 * refactor. После переключения всех callers старый удаляется.
 */

import { listLoaded as _listLoaded, type LoadedModelInfo } from "../../lmstudio-client.js";
import { getPreferencesStore } from "../preferences/store.js";

/** Три задачи которые делает Bibliary через LLM. */
export type ModelTask = "reader" | "extractor" | "vision-ocr";

export interface ResolvedModel {
  /** Какую модель использовать. */
  modelKey: string;
  /** Откуда взяли: pref (явный выбор пользователя) / fallback (первая загруженная). */
  source: "preference" | "fallback";
}

/* Test injection — для node:test без реального LM Studio. */
interface ResolverDeps {
  listLoaded: () => Promise<LoadedModelInfo[]>;
  getPrefs: () => Promise<Record<string, unknown>>;
}

const defaultDeps: ResolverDeps = {
  listLoaded: _listLoaded,
  getPrefs: async () => getPreferencesStore().getAll(),
};

let deps: ResolverDeps = defaultDeps;

export function _setResolverDepsForTesting(overrides: Partial<ResolverDeps>): void {
  deps = { ...defaultDeps, ...overrides };
}

export function _resetResolverForTesting(): void {
  deps = defaultDeps;
}

/* Маппинг task → preference key. Single source of truth. */
const TASK_TO_PREF_KEY: Record<ModelTask, string> = {
  reader: "readerModel",
  extractor: "extractorModel",
  "vision-ocr": "visionOcrModel",
};

/**
 * Резолвит modelKey для задачи.
 *
 * Логика:
 *   1. Читаем prefs[<task>Model] — если непусто И эта модель загружена в
 *      LM Studio → возвращаем `{modelKey, source: "preference"}`.
 *   2. Если pref пуст ИЛИ модель не загружена → возвращаем первую любую
 *      загруженную модель `{modelKey, source: "fallback"}`. Пользователь
 *      получит работающий результат, но без специализации.
 *   3. Если в LM Studio ничего не загружено → возвращаем `null`. Caller
 *      покажет понятную ошибку («Загрузите модель в LM Studio»).
 *
 * Никаких role/capability filters. Пользователь полностью контролирует
 * назначение модели на задачу через UI.
 */
export async function resolveModel(task: ModelTask): Promise<ResolvedModel | null> {
  const [prefs, loaded] = await Promise.all([deps.getPrefs(), deps.listLoaded()]);

  if (loaded.length === 0) return null;

  const prefKey = TASK_TO_PREF_KEY[task];
  const preferred = String(prefs[prefKey] ?? "").trim();

  if (preferred) {
    /* Pref задан — ищем точное совпадение по modelKey ИЛИ identifier
     * (LM Studio может возвращать identifier как path, modelKey как короткий). */
    const match = loaded.find(
      (m) => m.modelKey === preferred || m.identifier === preferred,
    );
    if (match) {
      return { modelKey: match.modelKey, source: "preference" };
    }
    /* Pref задан но модель не загружена — пишем warning и идём в fallback.
     * Не пытаемся auto-load: это явное решение пользователя загружать
     * модели вручную через Models page. */
    console.warn(
      `[model-resolver] task=${task}: preferred model "${preferred}" not loaded; using fallback`,
    );
  }

  /* Fallback — первая загруженная модель. */
  const fallback = loaded[0]!;
  return { modelKey: fallback.modelKey, source: "fallback" };
}

/* ── Удобные wrapper'ы для каждой задачи ─────────────────────────────── */

export async function getReaderModel(): Promise<ResolvedModel | null> {
  return resolveModel("reader");
}

export async function getExtractorModel(): Promise<ResolvedModel | null> {
  return resolveModel("extractor");
}

export async function getVisionOcrModel(): Promise<ResolvedModel | null> {
  return resolveModel("vision-ocr");
}

/* ── UI metadata для Models page ────────────────────────────────────── */

export interface TaskMeta {
  task: ModelTask;
  prefKey: string;
  /** Человеческое название для UI. */
  label: string;
  /** Подсказка для пользователя — какую модель сюда. */
  hint: string;
}

/**
 * Список всех задач для рендера Models page (3 строки вместо grid 4 ролей).
 * UI читает label/hint через i18n keys (см. renderer/locales/*.js).
 */
export function listAllTasks(): TaskMeta[] {
  return [
    {
      task: "reader",
      prefKey: TASK_TO_PREF_KEY.reader,
      label: "models.task.reader.label",
      hint: "models.task.reader.hint",
    },
    {
      task: "extractor",
      prefKey: TASK_TO_PREF_KEY.extractor,
      label: "models.task.extractor.label",
      hint: "models.task.extractor.hint",
    },
    {
      task: "vision-ocr",
      prefKey: TASK_TO_PREF_KEY["vision-ocr"],
      label: "models.task.visionOcr.label",
      hint: "models.task.visionOcr.hint",
    },
  ];
}
