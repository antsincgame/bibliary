/**
 * Module-level lifecycle для in-process LanceDB connection.
 *
 * Заменяет `electron/lib/chroma/auto-spawn.ts` + `http-client.ts` целиком:
 *   - нет HTTP, нет child-process, нет heartbeat polling
 *   - один `lancedb.connect()` на main-process — всё остальное через него
 *
 * Контракт:
 *   - `initVectorDb({dataDir})` зовётся ровно один раз в `main.ts` после
 *     `process.env.BIBLIARY_DATA_DIR = dataDir` и до `registerAllIpcHandlers`.
 *   - `getDb()` любой потребитель вызывает каждый раз когда нужно — никаких
 *     module-level закэшированных Tables (открытие table — копеечное).
 *   - `closeDb()` зовётся в `teardownSubsystems` при shutdown — fire-and-forget.
 *
 * Test injection: `setDataDirForTesting(tmpDir)` подменяет dataDir без
 * затрагивания process.env. Используется во всех `tests/vectordb-*.test.ts`
 * чтобы каждый тест работал в собственной mkdtemp-директории.
 */

import * as path from "path";
import * as lancedb from "@lancedb/lancedb";

/** Каноническое имя поддиректории под LanceDB-данные внутри `dataDir`. */
const LANCEDB_SUBDIR = "lancedb";

interface VectorDbState {
  /** Где physically живёт LanceDB-store (`dataDir/lancedb/`). */
  dataPath: string;
  /** Открытое connection — переиспользуем между вызовами. */
  connection: lancedb.Connection;
}

let state: VectorDbState | null = null;

/** Только для тестов: жёстко задать base-dir, минуя env. */
let testDataDirOverride: string | null = null;

export function setDataDirForTesting(dir: string | null): void {
  testDataDirOverride = dir;
  /* Reset connection чтобы следующий getDb() пересоздал его в новой директории. */
  state = null;
}

function resolveDataDir(): string {
  if (testDataDirOverride) return testDataDirOverride;
  const env = process.env.BIBLIARY_DATA_DIR;
  if (!env || env.length === 0) {
    throw new Error(
      "[vectordb] BIBLIARY_DATA_DIR not set; call initVectorDb({dataDir}) first OR setDataDirForTesting(...) in tests",
    );
  }
  return env;
}

/**
 * Открыть connection к LanceDB-store. Идемпотентно: повторные вызовы
 * с тем же dataDir переиспользуют existing connection. Если dataDir
 * сменился (тест с новым tmpdir) — закрываем старый и открываем новый.
 */
export async function initVectorDb(opts?: { dataDir?: string }): Promise<lancedb.Connection> {
  const requestedDir = opts?.dataDir ?? resolveDataDir();
  const dataPath = path.join(requestedDir, LANCEDB_SUBDIR);

  if (state && state.dataPath === dataPath) return state.connection;

  /* Сменился dataDir — close, open new. */
  if (state) {
    await closeDb();
  }

  /* lancedb.connect создаёт каталог под uri если его нет — fs.mkdir не нужен. */
  const connection = await lancedb.connect(dataPath);
  state = { dataPath, connection };
  return connection;
}

/**
 * Получить активное connection. Throws если init ещё не сделан — это
 * программная ошибка caller'а (модуль не должен лениво коннектиться при
 * первом vectorUpsert: connection нужно открывать строго в boot-фазе под
 * единый proper-lockfile).
 */
export async function getDb(): Promise<lancedb.Connection> {
  if (state) return state.connection;
  /* Lazy-init только в test-context (когда задан override). В production
   * caller обязан вызвать initVectorDb явно. */
  if (testDataDirOverride) return initVectorDb();
  throw new Error("[vectordb] getDb() called before initVectorDb({dataDir})");
}

/** Path до LanceDB-каталога (для верификационных тестов / migration disk-checks). */
export function getDataPath(): string {
  if (!state) throw new Error("[vectordb] getDataPath() called before init");
  return state.dataPath;
}

/**
 * Закрыть connection. LanceDB Node SDK не имеет explicit `close()` —
 * connection держит open file handles, которые освободит GC. Мы зануляем
 * state-ссылку чтобы getDb()/initVectorDb() видели свежий старт.
 *
 * Best-effort: никогда не throw'ает.
 */
export async function closeDb(): Promise<void> {
  state = null;
}
