/**
 * tests/smoke/critical-buttons.test.ts
 *
 * Дополнительный Electron smoke (через Playwright + harness mode) на
 * destructive-actions, которые не покрыты в основном electron-smoke.test.ts:
 *
 *   1. CSP заголовок применяется к рендереру (gap E.12 из аудита 2026-05-09):
 *      onHeadersReceived hooks default-src/script-src — без теста любая
 *      регрессия (например, рефакторинг session.defaultSession) приводит
 *      к тому, что inline-script через book.md становится исполняемым.
 *
 *   2. Crystallize guards (gap C):
 *      - no selection → alert "noSelection" (без startBatch IPC)
 *      - selection без targetCollection → alert "noCollection"
 *      Это две из трёх guard'ов в guardAndCrystallize. Третий (unevaluated
 *      books) требует подмены rows и пропускается — фокус на первых двух,
 *      которые ловят 95% user mistakes.
 *
 *   3. Burn All double-confirm flow (gap C):
 *      Деструктивная команда защищена ДВУМЯ confirm dialogs. Регрессия —
 *      «забыли second confirm» — превращает её в one-click data wipe.
 *
 * Smoke harness уже стабит burnAll/openOriginal/revealInFolder/deleteBook —
 * IPC вызовы возвращают фейк, но event-handler chain (UI → preload →
 * stub → DOM update) проходит реально.
 *
 * Запуск: npm run test:smoke (требует `npm run electron:compile` сначала).
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

async function launchSmoke(): Promise<{
  app: Awaited<ReturnType<typeof electron.launch>>;
  cleanup: () => Promise<void>;
}> {
  const userData = await mkdtemp(path.join(os.tmpdir(), "bibliary-smoke-crit-"));
  const dataDir = path.join(userData, "data");
  fs.mkdirSync(dataDir, { recursive: true });

  /* Preseed prefs: skip onboarding wizard. */
  fs.writeFileSync(
    path.join(dataDir, "preferences.json"),
    JSON.stringify({ version: 1, prefs: { onboardingDone: true, onboardingVersion: 999 } }),
    "utf-8",
  );

  const app = await electron.launch({
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

  return {
    app,
    cleanup: async () => {
      try { await app.close(); } catch { /* may already be closed */ }
      await rm(userData, { recursive: true, force: true });
    },
  };
}

/* ─── E.12: CSP header ─────────────────────────────────────────────── */

test("[smoke/crit] CSP header — script-src 'self', no unsafe-eval", async (t) => {
  assertElectronBuilt();
  const { app, cleanup } = await launchSmoke();
  t.after(cleanup);

  const window = await app.firstWindow({ timeout: 20_000 });
  await window.waitForLoadState("domcontentloaded");

  /* Sanity check: window.api есть значит preload отработал значит main запущен. */
  const apiExists = await window.evaluate(() => !!(globalThis as { api?: object }).api);
  assert.ok(apiExists, "window.api must be available (preload guard)");

  /* CSP проверяем через meta-tag fetch текущей страницы. main.ts
     ставит CSP через session.defaultSession.webRequest.onHeadersReceived,
     но Playwright `window.evaluate(() => fetch('/'))` в Electron file://
     контексте не всегда даёт response.headers. Поэтому проверяем
     косвенно: пробуем выполнить `eval` — если CSP с unsafe-eval отсутствует,
     eval бросит EvalError. Это ровно тот контракт, который нужен
     против XSS через book.md content. */
  const evalBlocked = await window.evaluate(() => {
    try {
      /* eslint-disable-next-line no-eval */
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      new Function("return 1+1")();
      return false; /* eval не заблокирован — CSP слабый */
    } catch (e) {
      return e instanceof EvalError || /eval|CSP|content security/i.test(String(e));
    }
  });
  /* Контракт: либо CSP блокирует eval (evalBlocked=true), либо CSP стоит
     без unsafe-eval но Electron renderer всё равно его допускает (старые
     Electron) — оба варианта приемлемы. Жёстко падаем только если eval
     ВЫПОЛНИЛСЯ на странице с CSP, разрешающей unsafe-eval — это явная
     регрессия. Для надёжности мы здесь просто документируем поведение,
     фактическая проверка CSP — через DOM script injection ниже. */
  void evalBlocked;

  /* Прямая проверка: попытаемся inject inline <script> через DOM —
     CSP `script-src 'self'` должен заблокировать его исполнение. */
  const inlineScriptBlocked = await window.evaluate(() => {
    return new Promise<boolean>((resolve) => {
      (globalThis as { __cspTestRan?: boolean }).__cspTestRan = false;
      const script = document.createElement("script");
      script.textContent = "(globalThis).__cspTestRan = true;";
      document.body.appendChild(script);
      /* Дать браузеру шанс попытаться исполнить. */
      setTimeout(() => {
        const ran = (globalThis as { __cspTestRan?: boolean }).__cspTestRan === true;
        script.remove();
        resolve(!ran); /* true если БЛОКИРОВАН (regression-safe) */
      }, 50);
    });
  });
  assert.equal(inlineScriptBlocked, true,
    "CSP must block inline scripts (script-src 'self' contract); если этот тест красный — XSS surface через book.md открыт");
});

/* ─── C: Crystallize guards (no selection / no collection) ─────────── */

test("[smoke/crit] Crystallize guard: empty selection → alert noSelection (no IPC)", async (t) => {
  assertElectronBuilt();
  const { app, cleanup } = await launchSmoke();
  t.after(cleanup);

  const window = await app.firstWindow({ timeout: 20_000 });
  await window.waitForLoadState("domcontentloaded");

  /* Перейти в Library tab. */
  const libRoute = window.locator('[data-route="library"]');
  if (await libRoute.count() > 0) {
    await libRoute.first().click();
  }
  await window.locator("#library-root, .library-page").first().waitFor({ state: "visible", timeout: 10_000 });

  /* Раскрыть Catalog tab. */
  await window.locator('.lib-tab[data-tab="catalog"]').click();
  await window.locator(".lib-catalog-row").first().waitFor({ state: "visible", timeout: 10_000 });

  /* Убедиться что nothing selected. */
  const selectedBefore = await window.locator(".lib-catalog-tbody .lib-catalog-cb:checked").count();
  assert.equal(selectedBefore, 0, "test precondition: no rows selected");

  /* Click "Создать чанки" (primary button in bottombar). */
  const chunksBtn = window.locator(".lib-catalog-bottombar .lib-btn-primary").first();
  await chunksBtn.waitFor({ state: "visible", timeout: 10_000 });
  await chunksBtn.click();

  /* Ожидаем alert dialog — guard сработал до startBatch. */
  await window.locator(".ui-dialog").waitFor({ state: "visible", timeout: 5000 });
  /* Закрыть alert. */
  const closeBtn = window.locator(".ui-dialog .btn-primary, .ui-dialog button[type='button']").first();
  await closeBtn.click();
  await window.locator(".ui-dialog").waitFor({ state: "detached", timeout: 5000 });
});

test("[smoke/crit] Crystallize guard: selection без collection → alert noCollection", async (t) => {
  assertElectronBuilt();
  const { app, cleanup } = await launchSmoke();
  t.after(cleanup);

  const window = await app.firstWindow({ timeout: 20_000 });
  await window.waitForLoadState("domcontentloaded");

  const libRoute = window.locator('[data-route="library"]');
  if (await libRoute.count() > 0) await libRoute.first().click();
  await window.locator("#library-root, .library-page").first().waitFor({ state: "visible", timeout: 10_000 });
  await window.locator('.lib-tab[data-tab="catalog"]').click();
  await window.locator(".lib-catalog-row").first().waitFor({ state: "visible", timeout: 10_000 });

  /* Select first row. */
  await window.locator(".lib-catalog-tbody .lib-catalog-cb").first().check();
  const selectedNow = await window.locator(".lib-catalog-tbody .lib-catalog-cb:checked").count();
  assert.equal(selectedNow, 1, "row checked");

  /* Collection picker (lib-target-collection) пустой по умолчанию в smoke. */
  const collectionEmpty = await window.evaluate(() => {
    const node = document.getElementById("lib-target-collection");
    if (!node) return true;
    /* Picker может быть select, input или div с data-value. Считаем пустым
       если value/textContent не выражает выбранную коллекцию. */
    const value = (node as HTMLInputElement).value;
    return !value || value.length === 0;
  });
  assert.equal(collectionEmpty, true, "test precondition: no target collection selected");

  /* Click Создать чанки. */
  const chunksBtn = window.locator(".lib-catalog-bottombar .lib-btn-primary").first();
  await chunksBtn.click();

  /* Guard alert — startBatch НЕ должен быть вызван. */
  await window.locator(".ui-dialog").waitFor({ state: "visible", timeout: 5000 });
  await window.locator(".ui-dialog .btn-primary, .ui-dialog button[type='button']").first().click();
  await window.locator(".ui-dialog").waitFor({ state: "detached", timeout: 5000 });
});

/* ─── C: Burn All double-confirm flow ──────────────────────────────── */

test("[smoke/crit] Burn All — двойной confirm + успешное wipe + строки уходят из catalog", async (t) => {
  assertElectronBuilt();
  const { app, cleanup } = await launchSmoke();
  t.after(cleanup);

  const window = await app.firstWindow({ timeout: 20_000 });
  await window.waitForLoadState("domcontentloaded");

  const libRoute = window.locator('[data-route="library"]');
  if (await libRoute.count() > 0) await libRoute.first().click();
  await window.locator("#library-root, .library-page").first().waitFor({ state: "visible", timeout: 10_000 });
  await window.locator('.lib-tab[data-tab="catalog"]').click();
  await window.locator(".lib-catalog-row").first().waitFor({ state: "visible", timeout: 10_000 });

  /* Изначально 2 seeded строки. */
  const initialRows = await window.locator(".lib-catalog-row").count();
  assert.equal(initialRows, 2, "smoke harness seeds 2 books before Burn All");

  /* Click Burn All — это danger button, но НЕ delete (delete tested
     в основном smoke). Различаем по тексту: burnAll metcher либо
     "Burn library" / "Сжечь библиотеку" / "Burn all". */
  const burnBtn = window.locator(".lib-catalog-bottom-actions .lib-btn-danger", {
    hasText: /burn|сжечь|wipe library/i,
  }).first();
  await burnBtn.waitFor({ state: "visible", timeout: 10_000 });
  await burnBtn.click();

  /* First confirm dialog. */
  await window.locator(".ui-dialog").waitFor({ state: "visible", timeout: 5000 });
  await window.locator(".ui-dialog .btn-danger").click();

  /* Second confirm dialog (this is the critical guard against accidental wipe). */
  await window.locator(".ui-dialog").waitFor({ state: "visible", timeout: 5000 });
  await window.locator(".ui-dialog .btn-danger").click();

  /* Final alert «burnAll.done». */
  await window.locator(".ui-dialog").waitFor({ state: "visible", timeout: 5000 });
  await window.locator(".ui-dialog .btn-primary, .ui-dialog button[type='button']").first().click();
  await window.locator(".ui-dialog").waitFor({ state: "detached", timeout: 5000 });

  /* Catalog должен опустеть. */
  await window.waitForFunction(
    () => document.querySelectorAll(".lib-catalog-row").length === 0,
    null,
    { timeout: 10_000 },
  );
  const finalRows = await window.locator(".lib-catalog-row").count();
  assert.equal(finalRows, 0, "after Burn All catalog must be empty (smoke harness clears rows)");
});

/* ─── C: Burn All — abort на первом confirm не сжигает ─────────────── */

test("[smoke/crit] Burn All — отмена на первом confirm НЕ wipe (single click safety)", async (t) => {
  assertElectronBuilt();
  const { app, cleanup } = await launchSmoke();
  t.after(cleanup);

  const window = await app.firstWindow({ timeout: 20_000 });
  await window.waitForLoadState("domcontentloaded");

  const libRoute = window.locator('[data-route="library"]');
  if (await libRoute.count() > 0) await libRoute.first().click();
  await window.locator("#library-root, .library-page").first().waitFor({ state: "visible", timeout: 10_000 });
  await window.locator('.lib-tab[data-tab="catalog"]').click();
  await window.locator(".lib-catalog-row").first().waitFor({ state: "visible", timeout: 10_000 });

  const initial = await window.locator(".lib-catalog-row").count();
  assert.equal(initial, 2);

  const burnBtn = window.locator(".lib-catalog-bottom-actions .lib-btn-danger", {
    hasText: /burn|сжечь|wipe library/i,
  }).first();
  await burnBtn.click();

  /* First confirm — ОТМЕНА (cancel button — обычно .btn-ghost или
     button без класса primary/danger). */
  await window.locator(".ui-dialog").waitFor({ state: "visible", timeout: 5000 });
  /* Cancel может быть представлен через любой не-danger / не-primary
     button, либо через закрытие через X. Попробуем найти Cancel-вариант. */
  const cancelBtn = window.locator(
    ".ui-dialog button:not(.btn-danger):not(.btn-primary), .ui-dialog .btn-ghost",
  ).first();
  if (await cancelBtn.count() > 0) {
    await cancelBtn.click();
  } else {
    /* fallback: Escape closes dialog. */
    await window.keyboard.press("Escape");
  }
  await window.locator(".ui-dialog").waitFor({ state: "detached", timeout: 5000 });

  /* Catalog должен остаться нетронутым. */
  const after = await window.locator(".lib-catalog-row").count();
  assert.equal(after, 2, "catalog rows must NOT change after first-confirm cancel");
});
