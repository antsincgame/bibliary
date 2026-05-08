/**
 * Test-only DI shim для подмены vectordb operations в unit-тестах.
 *
 * Паттерн взят из:
 *   - `electron/lib/library/uniqueness-evaluator.ts:144` (`_setUniquenessDepsForTesting`)
 *   - `electron/lib/llm/model-resolver.ts:50` (`_setResolverDepsForTesting`)
 *
 * Используется в `tests/uniqueness-score-pipeline.test.ts` (Phase 5
 * rewrite) и future migration-тестах, где нужно стаббить query/upsert
 * без подъёма реального LanceDB.
 *
 * **Не применяется** в `tests/vectordb-*.test.ts` — там тесты идут
 * против реального `lancedb.connect()` на mkdtemp-каталог. DI нужен
 * только для тестов BUSINESS-LOGIC слоя выше vectordb.
 */

import type { VectorPoint, VectorNearestNeighbor } from "./points.js";
import type { VectorPage, ScrollVectorsOptions } from "./scroll.js";

export interface VectorDbDeps {
  upsert: (collection: string, points: VectorPoint[]) => Promise<void>;
  queryNearest: (
    collection: string,
    embedding: number[] | Float32Array,
    n: number,
    where?: Record<string, unknown>,
  ) => Promise<VectorNearestNeighbor[]>;
  count: (collection: string) => Promise<number>;
  scroll: (opts: ScrollVectorsOptions) => AsyncGenerator<VectorPage, void, void>;
}

const noop = (): Promise<never> => {
  return Promise.reject(new Error("[vectordb/testing] dep not injected — call _setVectorDbDepsForTesting first"));
};

const defaultDeps: VectorDbDeps = {
  upsert: noop,
  queryNearest: noop,
  count: noop,
  scroll: (async function* () {
    /* yields nothing — caller must inject if generator is used */
  }) as VectorDbDeps["scroll"],
};

let deps: VectorDbDeps = defaultDeps;

/** Установить overrides. Не указанные поля остаются при noop. */
export function _setVectorDbDepsForTesting(overrides: Partial<VectorDbDeps>): void {
  deps = { ...defaultDeps, ...overrides };
}

export function _resetVectorDbDepsForTesting(): void {
  deps = defaultDeps;
}

/** Внутренний accessor — для модулей, которые хотят получать deps через
 * этот shim. Pattern: `if (testDeps.upsert !== defaultDeps.upsert) use it; else fall through to real`. */
export function _getInjectedDeps(): VectorDbDeps {
  return deps;
}
