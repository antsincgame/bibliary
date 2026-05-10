/**
 * electron/lib/smoke-harness-gate.ts
 *
 * Security gate for BIBLIARY_SMOKE_UI_HARNESS env variable.
 *
 * Контекст: preload использует env BIBLIARY_SMOKE_UI_HARNESS=1, чтобы
 * подменить ВСЕ library IPC методы фейковыми ответами для smoke-теста UI.
 * Это полезно для CI smoke (тесты UI без реального LM Studio / cache.db),
 * но КАТАСТРОФИЧНО опасно если активируется в packaged build:
 *
 *   - Реальный пользователь, у которого по какой-то причине env пробросилась
 *     (вирус, внешний скрипт, копипаста config.json), увидит fake-данные:
 *     ☑ книги «Cybernetic Predictive Devices», «Marketing Fog» — никак не
 *       соответствующие реальной библиотеке;
 *     ☑ deleteBook silently «удаляет» из fake state, но реальная книга
 *       нетронута;
 *     ☑ burnAll возвращает success, не трогая ни library/, ни vectordb;
 *     ☑ catalog показывает «Книги нет», пользователь думает что данные
 *       пропали, удаляет library/ руками — реальная катастрофа.
 *
 * Этот модуль вызывается из main.ts ДО создания BrowserWindow. Когда
 * `app.isPackaged === true`, env стирается, и preload видит пустую
 * переменную → smokeLibrary === null → все IPC идут реальные.
 *
 * Контракт: вызывать ровно один раз, в самом начале main процесса,
 * до любого `new BrowserWindow(...)` (preload наследует env от main).
 */

export interface SmokeHarnessGateDeps {
  isPackaged: boolean;
  /** Mutable env reference. В тестах подменяется на mock объект. */
  env: NodeJS.ProcessEnv;
  /** Logger sink для тестов. */
  log?: (msg: string) => void;
}

export interface SmokeHarnessGateResult {
  /** true если харнес был стёрт. */
  blocked: boolean;
  /** Причина решения для логов и тестов. */
  reason: "packaged-blocked" | "dev-allowed" | "not-set";
}

/**
 * Проверяет env и stripped'ит `BIBLIARY_SMOKE_UI_HARNESS` если приложение
 * packaged. Возвращает структурный результат для тестируемости.
 *
 * Безопасность: stripping выполняется через `delete env.KEY`, а не через
 * `env.KEY = ""` — это защищает от downstream-кода, который может проверить
 * `if (env.KEY !== undefined)`.
 *
 * @example
 *   import { app } from "electron";
 *   const r = applySmokeHarnessGate({ isPackaged: app.isPackaged, env: process.env });
 *   if (r.blocked) console.error("[security]", r.reason);
 */
export function applySmokeHarnessGate(deps: SmokeHarnessGateDeps): SmokeHarnessGateResult {
  const harnessValue = deps.env.BIBLIARY_SMOKE_UI_HARNESS;
  if (harnessValue !== "1") {
    return { blocked: false, reason: "not-set" };
  }
  if (!deps.isPackaged) {
    if (deps.log) deps.log("[smoke-harness-gate] dev mode — BIBLIARY_SMOKE_UI_HARNESS=1 allowed");
    return { blocked: false, reason: "dev-allowed" };
  }
  /* Packaged + harness=1 — security violation. Стираем БЕЗ исключений
     (бросать throw из main module = краш приложения у пользователя). */
  delete deps.env.BIBLIARY_SMOKE_UI_HARNESS;
  if (deps.log) {
    deps.log(
      "[smoke-harness-gate] SECURITY: BIBLIARY_SMOKE_UI_HARNESS=1 blocked in packaged build " +
      "(would have replaced library IPC with fake data — possible env injection or misconfig).",
    );
  }
  return { blocked: true, reason: "packaged-blocked" };
}
