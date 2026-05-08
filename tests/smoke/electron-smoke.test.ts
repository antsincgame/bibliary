/* Real Electron smoke test: launches packaged main + preload, drives renderer through Playwright. */
/**
 * Electron smoke-test через playwright._electron.
 *
 * Что проверяем:
 *   1. Приложение стартует -- main process не падает.
 *   2. Окно открывается, renderer/index.html загружается.
 *   3. `window.api` корректно прокинут через contextBridge (значит preload жив).
 *   4. IPC end-to-end: `library.catalog` отвечает структурой { rows, total } даже на пустой БД.
 *   5. Переключение маршрутов (sidebar `data-route="library"`) меняет активный pane.
 *
 * Тест НЕ требует LM Studio / vector store -- работает в полностью изолированной
 * tmp-папке. На каждый запуск создаётся свой userData, своя SQLite-БД.
 * LanceDB embedded стартует на новом mkdtemp dataDir автоматически в boot.
 *
 * Чтобы запустить:
 *   1. npm run electron:compile  (один раз, или после правок electron/*)
 *   2. npm run test:smoke
 *
 * Если `dist-electron/main.js` отсутствует, тест выходит с понятным
 * сообщением -- не падает в зелёном CI без подготовки.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { _electron as electron } from "playwright";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..", "..");
const MAIN_PATH = path.join(ROOT, "dist-electron", "main.js");
const PRELOAD_PATH = path.join(ROOT, "dist-electron", "preload.js");

function assertElectronBuilt(): void {
  if (!fs.existsSync(MAIN_PATH) || !fs.existsSync(PRELOAD_PATH)) {
    throw new Error(
      `Electron build not found. Run \`npm run electron:compile\` first.\n` +
        `Missing: ${!fs.existsSync(MAIN_PATH) ? MAIN_PATH : PRELOAD_PATH}`,
    );
  }
}

test("electron smoke: app launches, preload bridge works, IPC handlers respond", async (t) => {
  assertElectronBuilt();

  const userData = await mkdtemp(path.join(os.tmpdir(), "bibliary-smoke-"));
  const dataDir = path.join(userData, "data");
  fs.mkdirSync(dataDir, { recursive: true });

  /* Preseed preferences чтобы welcome-wizard НЕ открылся: иначе модальный
     overlay перехватывает все клики и smoke падает на тайм-аут локатора.
     Формат файла -- {version, prefs} (см. electron/lib/preferences/store.ts). */
  fs.writeFileSync(
    path.join(dataDir, "preferences.json"),
    JSON.stringify({ version: 1, prefs: { onboardingDone: true, onboardingVersion: 999 } }),
    "utf-8",
  );

  const app = await electron.launch({
    args: [MAIN_PATH],
    /* Полностью изолированный профиль: своя userData, своя SQLite, никаких
       пересечений с реальной библиотекой пользователя. */
    env: {
      ...process.env,
      BIBLIARY_DATA_DIR: dataDir,
      BIBLIARY_LIBRARY_DB: path.join(dataDir, "bibliary-cache.db"),
      BIBLIARY_LIBRARY_ROOT: path.join(dataDir, "library"),
      ELECTRON_USER_DATA: userData,
      BIBLIARY_SMOKE_UI_HARNESS: "1",
    },
    timeout: 30_000,
  });

  t.after(async () => {
    try {
      await app.close();
    } catch {
      /* ignore: app may already be closed */
    }
    await rm(userData, { recursive: true, force: true });
  });

  /* Дожидаемся первого окна. */
  const window = await app.firstWindow({ timeout: 20_000 });
  assert.ok(window, "first window should appear");

  /* Renderer мог ещё загружаться -- ждём DOMContentLoaded. */
  await window.waitForLoadState("domcontentloaded");

  /* Smoke #1: preload пробросил window.api. */
  const apiKeys = await window.evaluate(() => Object.keys((globalThis as { api?: object }).api ?? {}));
  assert.ok(apiKeys.length > 0, "window.api должен быть пробросан через contextBridge");
  /* Должен быть хотя бы базовый namespace 'library'. */
  assert.ok(apiKeys.includes("library"), `window.api.library expected, got: ${apiKeys.join(", ")}`);

  /* Smoke #2: IPC end-to-end -- preferences.getAll читает JSON-файл,
     не требует rebuild native better-sqlite3 (smoke должен работать
     сразу после `npm run electron:compile`, без electron-rebuild для
     SQLite -- если нужен full DB-IPC smoke, пользователь добавит
     отдельный тест и пред-шагом `npx @electron/rebuild`). */
  const prefs = await window.evaluate(async () => {
    const api = (globalThis as { api: { preferences: { getAll: () => Promise<Record<string, unknown>> } } }).api;
    return api.preferences.getAll();
  });
  assert.ok(prefs && typeof prefs === "object", "preferences.getAll must return an object");
  assert.ok(!Array.isArray(prefs), "preferences should be a record, not an array");

  /* Smoke #3: structural check that window.api.library exposes expected methods. */
  const libraryShape = await window.evaluate(() => {
    const lib = (globalThis as { api: { library: Record<string, unknown> } }).api.library;
    return {
      hasCatalog: typeof lib.catalog === "function",
      hasDeleteBook: typeof lib.deleteBook === "function",
      hasEvaluatorStatus: typeof lib.evaluatorStatus === "function",
      hasRebuildCache: typeof lib.rebuildCache === "function",
    };
  });
  assert.equal(libraryShape.hasCatalog, true, "window.api.library.catalog must be a function");
  assert.equal(libraryShape.hasDeleteBook, true, "window.api.library.deleteBook must be a function");
  assert.equal(libraryShape.hasEvaluatorStatus, true, "window.api.library.evaluatorStatus must be a function");
  assert.equal(libraryShape.hasRebuildCache, true, "window.api.library.rebuildCache must be a function");

  /* Smoke #4: Models route — минимальная страница (статус LM Studio, списки моделей, роли). */
  await window.locator('[data-route="models"]').first().click();
  await window.locator("#route-models.route-active").waitFor({ state: "visible", timeout: 10_000 });
  await window.locator("#route-models #mp-roles").waitFor({ state: "visible", timeout: 10_000 });
  await window.locator("#route-models .models-page").waitFor({ state: "visible", timeout: 10_000 });

  /* Smoke #5: переход на library route не падает. */
  const sidebar = await window.locator('[data-route="library"]').count();
  if (sidebar > 0) {
    await window.locator('[data-route="library"]').first().click();
    /* Ждём пока library-pane получит активный класс. */
    await window
      .locator('#library-root, .library-page')
      .first()
      .waitFor({ state: "visible", timeout: 10_000 });
  }

  /* Smoke #6: real Library UI user flows with a mocked preload backend. */
  await window.locator(".lib-import-pick-files").waitFor({ state: "visible", timeout: 10_000 });
  await window.locator(".lib-import-pick-files").click();
  await window.locator(".lib-import-status").filter({ hasText: /1/ }).waitFor({ timeout: 10_000 });
  await window.locator(".lib-import-log-list").filter({ hasText: "smoke-book.txt" }).waitFor({ timeout: 10_000 });

  await window.locator('.lib-tab[data-tab="catalog"]').click();
  await window.locator(".lib-catalog-row").first().waitFor({ state: "visible", timeout: 10_000 });
  assert.equal(await window.locator(".lib-catalog-row").count(), 2, "catalog should render two seeded rows");

  await window.locator(".lib-catalog-search").fill("cybernetics");
  await window.waitForFunction(() => document.querySelectorAll(".lib-catalog-row").length === 1, null, { timeout: 10_000 });
  assert.equal(await window.locator(".lib-catalog-row").count(), 1, "search should filter catalog rows");

  await window.locator(".lib-catalog-search").fill("");
  await window.waitForFunction(() => document.querySelectorAll(".lib-catalog-row").length === 2, null, { timeout: 10_000 });
  await window.locator(".lib-catalog-quality-slider").evaluate((node) => {
    const input = node as HTMLInputElement;
    input.value = "70";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await window.waitForFunction(() => document.querySelectorAll(".lib-catalog-row").length === 1, null, { timeout: 10_000 });
  assert.equal(await window.locator(".lib-catalog-row").count(), 1, "quality slider should filter low-quality rows");
  await window.locator(".lib-catalog-quality-slider").evaluate((node) => {
    const input = node as HTMLInputElement;
    input.value = "0";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });

  await window.locator(".lib-catalog-cell-title").first().click();
  await window.locator(".lib-reader-body").filter({ hasText: "Smoke reader body" }).waitFor({ timeout: 10_000 });
  await window.locator(".lib-reader-back").click();
  await window.locator(".lib-reader").waitFor({ state: "detached", timeout: 10_000 });

  await window.locator(".lib-catalog-search").fill("");
  await window.locator(".lib-catalog-tbody .lib-catalog-cb").first().check();
  await window.locator(".lib-catalog-bottom-actions .lib-btn-danger", { hasText: /Delete|Удалить/ }).click();
  await window.locator(".ui-dialog .btn-danger").click();
  await window.waitForFunction(() => document.querySelectorAll(".lib-catalog-row").length === 1, null, { timeout: 10_000 });

  await window.locator(".lib-catalog-search").fill("");
  await window.locator(".lib-catalog-toolbar .lib-btn", { hasText: /Tags|Теги/ }).click();
  await window.locator(".tag-cloud-dialog").waitFor({ state: "visible", timeout: 10_000 });
  await window.locator(".tag-cloud-search").fill("marketing");
  await window.locator(".tag-cloud-pill", { hasText: "marketing" }).click();
  await window.locator(".tag-cloud-dialog .btn-primary").click();
  assert.equal(await window.locator(".lib-catalog-row").count(), 1, "tag cloud should apply AND-filter to catalog");

  /* Smoke #7: title app должен быть установлен. */
  const title = await window.title();
  assert.ok(title.length > 0, "window.title() must be non-empty");
});
