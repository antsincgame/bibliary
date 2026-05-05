/**
 * Discipline registry — единая точка получения активного списка дисциплин
 * Олимпиады (статические + пользовательские).
 *
 * Создан 2026-05-05 (Iter 14.3, custom Olympics editor).
 *
 * Зачем отдельный файл:
 *   - `disciplines.ts` остаётся sync-конст (легко testable, не нужен IO).
 *   - `olympics.ts` теперь дёргает `getActiveDisciplines()` async — она сама
 *     подтягивает кастомные из preferences и компилит их через
 *     `compileCustomDiscipline`.
 *   - Тесты могут подменить `_setRegistryDepsForTests` и вернуть фиксированный
 *     набор без чтения preferences.
 */

import type { Discipline } from "./disciplines.js";
import { OLYMPICS_DISCIPLINES } from "./disciplines.js";
import { CustomDisciplineSchema, compileCustomDiscipline, type CustomDiscipline } from "./custom-disciplines.js";
import { loadDisciplineImageDataUrlSync } from "./discipline-images.js";
import { getPreferencesStore } from "../../preferences/store.js";

interface RegistryDeps {
  readCustom: () => Promise<CustomDiscipline[]>;
  loadImage: (imageRef: string) => string | null;
}

async function defaultReadCustom(): Promise<CustomDiscipline[]> {
  try {
    const prefs = await getPreferencesStore().getAll();
    const raw = prefs.customOlympicsDisciplines as unknown[];
    if (!Array.isArray(raw)) return [];
    /* Парсим через полную схему с refine — чтобы отбросить вмерший
       (vision без imageRef, текст с imageRef) контент тихо. */
    const parsed: CustomDiscipline[] = [];
    for (const item of raw) {
      const r = CustomDisciplineSchema.safeParse(item);
      if (r.success) parsed.push(r.data);
      else console.warn(`[disciplines-registry] skipping invalid custom discipline: ${r.error.message}`);
    }
    return parsed;
  } catch (e) {
    console.warn(`[disciplines-registry] failed to read prefs.customOlympicsDisciplines: ${e instanceof Error ? e.message : e}`);
    return [];
  }
}

const defaultDeps: RegistryDeps = {
  readCustom: defaultReadCustom,
  loadImage: loadDisciplineImageDataUrlSync,
};

let deps: RegistryDeps = defaultDeps;

/**
 * Возвращает полный список активных дисциплин: статические из `disciplines.ts`
 * + пользовательские из preferences (скомпилированные через
 * `compileCustomDiscipline`).
 *
 * Кастомные с тем же id, что и статические, ИГНОРИРУЮТСЯ — статика выигрывает,
 * чтобы пользователь случайно не сломал stress-tested defaults.
 */
export async function getActiveDisciplines(): Promise<Discipline[]> {
  const staticIds = new Set(OLYMPICS_DISCIPLINES.map((d) => d.id));
  const customs = await deps.readCustom();
  const compiled: Discipline[] = [];
  for (const c of customs) {
    if (staticIds.has(c.id)) {
      console.warn(`[disciplines-registry] custom discipline "${c.id}" shadows static one — keeping static, skipping custom`);
      continue;
    }
    try {
      compiled.push(compileCustomDiscipline(c, deps.loadImage));
    } catch (e) {
      console.warn(`[disciplines-registry] failed to compile custom discipline "${c.id}": ${e instanceof Error ? e.message : e}`);
    }
  }
  return [...OLYMPICS_DISCIPLINES, ...compiled];
}

/** TEST-ONLY: подменить deps на стабы (in-memory custom + no-op image loader). */
export function _setRegistryDepsForTests(overrides: Partial<RegistryDeps>): void {
  deps = { ...defaultDeps, ...overrides };
}

/** TEST-ONLY: восстановить дефолтные deps. */
export function _resetRegistryDeps(): void {
  deps = defaultDeps;
}
