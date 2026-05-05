/**
 * Discipline registry — единая точка получения активного списка дисциплин Олимпиады.
 *
 * История:
 *   - 2026-05-05 (Iter 14.3): создан вместе с custom-disciplines feature
 *     для объединения статических + пользовательских дисциплин.
 *   - 2026-05-06 (v1.0.11, /imperor /mahakala): custom-disciplines feature
 *     удалена целиком. Registry упрощён до возврата только статических
 *     `OLYMPICS_DISCIPLINES`. Файл оставлен (не удалён), потому что:
 *       1. `olympics.ts` импортирует `getActiveDisciplines()` — ломать API
 *          ради удаления одного файла — больше работы чем оставить.
 *       2. Ленивый sync-провайдер был бы deg`радацией testability —
 *          тесты в `tests/olympics-discipline-images.test.ts` мокают
 *          этот модуль через `_setRegistryDepsForTests()`. Хотим оставить
 *          опцию для будущих расширений (например, multi-source disciplines).
 */

import type { Discipline } from "./disciplines.js";
import { OLYMPICS_DISCIPLINES } from "./disciplines.js";

interface RegistryDeps {
  /** v1.0.11: пустая cтаб для backward-compat с тестами. Всегда возвращает []. */
  readCustom: () => Promise<Discipline[]>;
}

const defaultDeps: RegistryDeps = {
  readCustom: async () => [],
};

let deps: RegistryDeps = defaultDeps;

/**
 * Возвращает полный список активных дисциплин Олимпиады.
 *
 * v1.0.11: только статические дисциплины из `disciplines.ts`. Раньше сюда
 * примешивались пользовательские из `prefs.customOlympicsDisciplines` —
 * feature удалена целиком, потому что не давала улучшения калибровки
 * сверх curated stress-tested defaults.
 */
export async function getActiveDisciplines(): Promise<Discipline[]> {
  const customs = await deps.readCustom();
  /* v1.0.11: customs всегда [] в production. Цикл оставлен ради
     поддержки тестов которые могут переопределить deps через
     _setRegistryDepsForTests. */
  return [...OLYMPICS_DISCIPLINES, ...customs];
}

/** TEST-ONLY: подменить deps на стабы (in-memory custom). */
export function _setRegistryDepsForTests(overrides: Partial<RegistryDeps>): void {
  deps = { ...defaultDeps, ...overrides };
}

/** TEST-ONLY: восстановить дефолтные deps. */
export function _resetRegistryDeps(): void {
  deps = defaultDeps;
}
