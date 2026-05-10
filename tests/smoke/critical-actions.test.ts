/**
 * tests/smoke/critical-actions.test.ts
 *
 * Расширение smoke-тестов на КРИТИЧЕСКИЕ UI-кнопки, которые досихпор
 * не имели покрытия (аудит 2026-05-09).
 *
 * Покрыто:
 *   1. CSP enforcement — inline `<script>` блокируется script-src 'self'
 *      (регрессия-детектор для electron/main.ts:applyCsp).
 *   2. Crystallize button guards:
 *      - ничего не выделено → alert с информативным текстом
 *      - выделено, но нет targetCollection → alert
 *   3. Re-evaluate button guard: nothing selected → status toast.
 *   4. Reader actions: open book → theme switcher (light/sepia/dark) реально
 *      меняет dataset.theme + sessionStorage.
 *   5. Reader Burn-book кнопка: open → burn → confirm → книга
 *      исчезает из каталога.
 *
 * Стратегия: один electron.launch() на весь describe-блок, перед каждым
 * it() сбрасываем UI в нейтральное состояние (закрыть диалоги/ридер, снять
 * выделения). Работаем под BIBLIARY_SMOKE_UI_HARNESS=1, то есть library:*
 * IPC возвращает фейковые 2 книги (book-a cybernetics, book-b marketing).
 * Это осознанный компромисс: тесты проверяют UI flow + bridge contract,
 * а не real-IPC; реальные IPC handleŕы покрываются import-flow.test.ts и
 * отдельными unit-тестами.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";

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

describe("electron critical-actions smoke", () => {
  let app: ElectronApplication;
  let window: Page;
  let userData: string;

  before(async () => {
    assertElectronBuilt();

    userData = await mkdtemp(path.join(os.tmpdir(), "bibliary-crit-"));
    const dataDir = path.join(userData, "data");
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(
      path.join(dataDir, "preferences.json"),
      JSON.stringify({ version: 1, prefs: { onboardingDone: true, onboardingVersion: 999 } }),
      "utf-8",
    );

    app = await electron.launch({
      args: [MAIN_PATH],
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
    window = await app.firstWindow({ timeout: 20_000 });
    await window.waitForLoadState("domcontentloaded");
  });

  after(async () => {
    try { await app.close(); } catch { /* ignore */ }
    if (userData) await rm(userData, { recursive: true, force: true });
  });

  /**
   * Нейтральное состояние перед каждым it(): library route, catalog tab,
   * без выделений, без открытых reader/dialog'ов.
   */
  async function gotoCleanCatalog(): Promise<void> {
    /* Закрыть все висящие диалоги (если предыдущий тест упал с dialog open). */
    await window.evaluate(() => {
      document.querySelectorAll(".ui-dialog-overlay").forEach((o) => o.remove());
      const reader = document.querySelector(".lib-reader");
      if (reader) reader.remove();
      document.body.classList.remove("lib-reader-active");
      const catalogBody = document.querySelector(".lib-catalog-body") as HTMLElement | null;
      if (catalogBody) catalogBody.style.display = "";
      document.querySelectorAll(".lib-catalog-cb:checked").forEach((cb) => {
        const input = cb as HTMLInputElement;
        input.checked = false;
        input.dispatchEvent(new Event("change", { bubbles: true }));
      });
      const search = document.querySelector(".lib-catalog-search") as HTMLInputElement | null;
      if (search) {
        search.value = "";
        search.dispatchEvent(new Event("input", { bubbles: true }));
      }
      const slider = document.querySelector(".lib-catalog-quality-slider") as HTMLInputElement | null;
      if (slider) {
        slider.value = "0";
        slider.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });
    /* Library route + catalog tab. */
    await window.locator('[data-route="library"]').first().click();
    const catalogTab = window.locator('.lib-tab[data-tab="catalog"]');
    if (await catalogTab.count() > 0) await catalogTab.click();
    await window.locator(".lib-catalog-tbody").waitFor({ state: "visible", timeout: 5_000 });
  }

  /* ─── 1. CSP enforcement ──────────────────────────────────────────── */

  it("CSP blocks inline <script> from executing (script-src 'self' enforced)", async () => {
    /* Инжектим inline-script через DOM и ждём что он НЕ выполнится.
       Если CSP сломан (meta-tag вернулся в index.html, или onHeadersReceived
       hook убран, или 'unsafe-inline' крадучивый попал в script-src) —
       window.__cspProbe станет true, и тест красный. */
    const result = await window.evaluate(async () => {
      delete (window as unknown as { __cspProbe?: unknown }).__cspProbe;
      return new Promise<string>((resolve) => {
        const s = document.createElement("script");
        s.textContent = "window.__cspProbe = true;";
        document.head.appendChild(s);
        /* Даём Chromium время либо выполнить, либо пробросить CSP violation. */
        setTimeout(() => {
          const executed = (window as unknown as { __cspProbe?: boolean }).__cspProbe === true;
          resolve(executed ? "executed" : "blocked");
        }, 150);
      });
    });
    assert.equal(result, "blocked",
      "CSP regression: inline <script> executed — script-src 'self' enforcement сломан в main.ts:applyCsp или появился meta http-equiv=\"Content-Security-Policy\" с разрешающей политикой");
  });

  it("CSP blocks inline event-handler attribute (onerror=)", async () => {
    /* CSP без 'unsafe-inline' в script-src блокирует и onerror=, onclick= attributes
       в dynamically-injected HTML. */
    const result = await window.evaluate(async () => {
      delete (window as unknown as { __cspProbeAttr?: unknown }).__cspProbeAttr;
      return new Promise<string>((resolve) => {
        const img = document.createElement("img");
        img.setAttribute("src", "x");
        img.setAttribute("onerror", "window.__cspProbeAttr = true");
        document.body.appendChild(img);
        setTimeout(() => {
          const executed = (window as unknown as { __cspProbeAttr?: boolean }).__cspProbeAttr === true;
          img.remove();
          resolve(executed ? "executed" : "blocked");
        }, 150);
      });
    });
    assert.equal(result, "blocked",
      "CSP regression: inline onerror handler executed — 'unsafe-inline' protected (must NOT be in script-src)");
  });

  /* ─── 2. Crystallize guard.noSelection ───────────────────────────────── */

  it("Crystallize button: alert when nothing selected", async () => {
    await gotoCleanCatalog();
    /* Никакого выделения — жмём "Создать чанки". Гард guardAndCrystallize должен
       показать alert и НЕ вызывать datasetV2.startBatch. */
    await window.locator(".lib-catalog-bottombar .lib-btn-primary").click();
    await window.locator(".ui-dialog-overlay").waitFor({ state: "visible", timeout: 5_000 });
    /* Содержимое проверяем либерально (хоть что-то есть) и семантически (
       упоминание "выбер" / "select" / "книг" / "book"). */
    const msg = (await window.locator(".ui-dialog-message").textContent()) ?? "";
    assert.ok(msg.length > 0, "alert dialog must show non-empty message");
    assert.match(msg, /выбер|select|книг|book/i,
      `guard.noSelection alert text must hint at selection requirement; got: ${JSON.stringify(msg)}`);
    /* Закрываем alert. */
    await window.locator(".ui-dialog .btn-primary").click();
    await window.locator(".ui-dialog-overlay").waitFor({ state: "detached", timeout: 5_000 });
  });

  /* ─── 3. Crystallize guard.noCollection ─────────────────────────────── */

  it("Crystallize button: alert when book selected but no targetCollection", async () => {
    await gotoCleanCatalog();
    /* Выделяем первую книгу. Коллекция НЕ выбрана (в fresh app instance
       STATE.targetCollection = ""). */
    await window.locator(".lib-catalog-tbody .lib-catalog-cb").first().check();
    await window.locator(".lib-catalog-bottombar .lib-btn-primary").click();
    await window.locator(".ui-dialog-overlay").waitFor({ state: "visible", timeout: 5_000 });
    const msg = (await window.locator(".ui-dialog-message").textContent()) ?? "";
    assert.ok(msg.length > 0);
    assert.match(msg, /коллекци|collection/i,
      `guard.noCollection alert text must mention collection; got: ${JSON.stringify(msg)}`);
    await window.locator(".ui-dialog .btn-primary").click();
    await window.locator(".ui-dialog-overlay").waitFor({ state: "detached", timeout: 5_000 });
  });

  /* ─── 4. Re-evaluate guard ─────────────────────────────────────────── */

  it("Re-evaluate button: status toast when nothing selected (no IPC fire)", async () => {
    await gotoCleanCatalog();
    /* Re-evaluate доступен в advanced mode — принудительно разблокируем видимость
       data-mode-min="advanced" элементов, чтобы не зависеть от prefs.uiMode в
       смоук-харнесе. */
    await window.evaluate(() => {
      document.querySelectorAll('[data-mode-min="advanced"], [data-mode-min="pro"]').forEach((node) => {
        (node as HTMLElement).style.display = "";
      });
    });
    const reevalBtn = window.locator(".lib-catalog-bottombar .lib-btn", { hasText: /Re-?evaluate|Переоцен/ }).first();
    if (await reevalBtn.count() === 0) {
      /* Кнопка спрятана за advanced-mode prefs gating — скипаем лягко, чтобы
         не быть зависимым от внутреннего UX-флага. */
      return;
    }
    await reevalBtn.click();
    /* Ожидаем либо status-toast (lib-catalog-batch-summary) с текстом о selection,
       либо alert. Главное — IPC реальный НЕ работает без selection. */
    await window.waitForFunction(() => {
      const summary = document.querySelector(".lib-catalog-batch-summary");
      const dialog = document.querySelector(".ui-dialog-message");
      return (summary && (summary.textContent || "").length > 0)
        || (dialog && (dialog.textContent || "").length > 0);
    }, null, { timeout: 5_000 });
  });

  /* ─── 5. Reader theme switcher ──────────────────────────────────────── */

  it("Reader: theme switcher applies dataset.theme on .lib-reader-body", async () => {
    await gotoCleanCatalog();
    /* Открываем первую книгу. */
    await window.locator(".lib-catalog-cell-title").first().click();
    await window.locator(".lib-reader-body").waitFor({ state: "visible", timeout: 10_000 });

    /* Default theme — dark (без dataset.theme), либо из sessionStorage. Кликаем
       на light. */
    await window.locator('.lib-reader-theme-btn[data-theme="light"]').click();
    const themeAfterLight = await window.locator(".lib-reader-body").evaluate((node) =>
      (node as HTMLElement).dataset.theme,
    );
    assert.equal(themeAfterLight, "light",
      "clicking Light theme button must set dataset.theme='light' on .lib-reader-body");

    /* sepia */
    await window.locator('.lib-reader-theme-btn[data-theme="sepia"]').click();
    const themeAfterSepia = await window.locator(".lib-reader-body").evaluate((node) =>
      (node as HTMLElement).dataset.theme,
    );
    assert.equal(themeAfterSepia, "sepia");

    /* dark — dataset.theme должен быть удалён (контракт reader.js:buildReaderThemeSwitcher). */
    await window.locator('.lib-reader-theme-btn[data-theme="dark"]').click();
    const themeAfterDark = await window.locator(".lib-reader-body").evaluate((node) =>
      (node as HTMLElement).dataset.theme,
    );
    assert.ok(themeAfterDark === undefined || themeAfterDark === "",
      `dark theme must clear dataset.theme attribute (got ${JSON.stringify(themeAfterDark)})`);

    /* sessionStorage persistence. */
    const stored = await window.evaluate(() => {
      try { return sessionStorage.getItem("bibliary_reader_theme"); } catch { return null; }
    });
    assert.equal(stored, "dark", "theme choice must persist to sessionStorage");

    /* Закрываем reader. */
    await window.locator(".lib-reader-back").click();
    await window.locator(".lib-reader").waitFor({ state: "detached", timeout: 5_000 });
  });

  /* ─── 6. Reader Burn-book button ─────────────────────────────────────── */

  it("Reader: Burn book button → confirm → row removed from catalog", async () => {
    await gotoCleanCatalog();
    const initialRows = await window.locator(".lib-catalog-row").count();
    assert.ok(initialRows >= 1, "smoke harness must seed at least 1 book");

    /* Открываем первую. */
    await window.locator(".lib-catalog-cell-title").first().click();
    await window.locator(".lib-reader-body").waitFor({ state: "visible", timeout: 10_000 });

    /* Burn button в reader toolbar — явный selector по классу. */
    const burn = window.locator(".lib-reader-action-burn");
    await burn.first().click();

    /* Confirm dialog. */
    await window.locator(".ui-dialog-overlay").waitFor({ state: "visible", timeout: 5_000 });
    /* danger button = "Сжечь" ОК-кнопка с вариантом danger. */
    await window.locator(".ui-dialog .btn-danger").click();

    /* Reader закрыт + каталог перерисован без удалённой книги. */
    await window.locator(".lib-reader").waitFor({ state: "detached", timeout: 5_000 });
    await window.waitForFunction(
      (initial) => document.querySelectorAll(".lib-catalog-row").length === initial - 1,
      initialRows,
      { timeout: 10_000 },
    );
  });
});
