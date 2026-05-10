/**
 * tests/renderer-i18n.test.ts
 *
 * Unit-тесты для pure-частей renderer/i18n.js: t() (key lookup +
 * template substitution + fallback), getLocale/setLocale/listLocales.
 *
 * Покрывает самую частую регрессию в UI: «забыли ключ в локали»,
 * «вариант substitution не сработал», «setLocale не свитчит таблицу».
 * До этого теста ни одна renderer-сторона не была покрыта (кроме
 * pure helpers в sanitize.js).
 *
 * NB: `applyI18n` требует DOM querySelectorAll и оставлен out of scope
 * (тест без jsdom). Pure-функции тестируются прямым импортом.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

/* ─── globals stub для импорта i18n.js ────────────────────────────── */

/* i18n.js при импорте вызывает readLocale() который трогает localStorage.
   Подделываем глобал ДО импорта чтобы не упасть с ReferenceError. */
const memStore = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => memStore.get(k) ?? null,
  setItem: (k: string, v: string) => { memStore.set(k, String(v)); },
  removeItem: (k: string) => { memStore.delete(k); },
  clear: () => { memStore.clear(); },
};
/* setLocale также трогает document.documentElement.lang. Подделываем
   минимальный document stub чтобы setLocale не падал. */
(globalThis as Record<string, unknown>).document = {
  documentElement: { lang: "" },
  querySelectorAll: () => [],
};

import { t, getLocale, setLocale, listLocales, onLocaleChange } from "../renderer/i18n.js";

/* ─── Locale enumeration ──────────────────────────────────────────── */

test("[i18n] listLocales returns exactly ['ru', 'en']", () => {
  const locales = listLocales();
  assert.deepEqual([...locales].sort(), ["en", "ru"]);
});

test("[i18n] getLocale returns 'ru' by default (no localStorage entry)", () => {
  /* Module-level state initialized via readLocale, which falls back to
     DEFAULT_LOCALE ("ru") когда localStorage пуст. */
  assert.equal(getLocale(), "ru");
});

/* ─── t() — known keys ────────────────────────────────────────────── */

test("[i18n] t: known key (ru) returns translated string", () => {
  /* "nav.library" — стабильный ключ из renderer/locales/ru.js. */
  const v = t("nav.library");
  assert.equal(typeof v, "string");
  assert.ok(v.length > 0, "translation not empty");
  assert.equal(v, "Библиотека");
});

test("[i18n] t: missing key returns key itself (graceful)", () => {
  const v = t("__totally.missing.key.never.exists__");
  assert.equal(v, "__totally.missing.key.never.exists__");
});

/* ─── t() — template substitution ─────────────────────────────────── */

test("[i18n] t: template substitution {var}", () => {
  /* Ключ "library.search.openExternalFallback" содержит {url}. */
  const v = t("library.search.openExternalFallback", { url: "https://example.com" });
  assert.match(v, /https:\/\/example\.com/);
  assert.ok(!v.includes("{url}"), "placeholder replaced");
});

test("[i18n] t: multiple substitutions in one string", () => {
  /* "library.preview.sampleHead": "{chapter} - #{index} - {chars} символов" */
  const v = t("library.preview.sampleHead", { chapter: "Глава 1", index: 5, chars: 1000 });
  assert.match(v, /Глава 1/);
  assert.match(v, /#5/);
  assert.match(v, /1000/);
});

test("[i18n] t: missing var → empty string in placeholder slot", () => {
  /* {chars} not provided → пустая строка, но {chapter} и {index} остаются. */
  const v = t("library.preview.sampleHead", { chapter: "X", index: 1 });
  assert.match(v, /X - #1 - {2}символов/);
});

test("[i18n] t: numeric vars stringified", () => {
  const v = t("library.search.status.doneCount", { count: 42 });
  assert.match(v, /42/);
});

test("[i18n] t: no vars passed → template returned as-is with placeholders", () => {
  /* Без vars подстановки не происходит, template возвращается as-is
     (производственное поведение — caller отвечает за vars). */
  const v = t("library.search.openExternalFallback");
  assert.match(v, /\{url\}/);
});

/* ─── setLocale: switching ────────────────────────────────────────── */

test("[i18n] setLocale('en') → t() returns english translation", () => {
  setLocale("en");
  assert.equal(getLocale(), "en");
  const v = t("nav.library");
  /* Английский перевод. */
  assert.notEqual(v, "Библиотека");
  assert.ok(v.length > 0);
  /* Сбросим обратно для других тестов. */
  setLocale("ru");
});

test("[i18n] setLocale('ru') restores russian", () => {
  setLocale("en");
  setLocale("ru");
  assert.equal(getLocale(), "ru");
  assert.equal(t("nav.library"), "Библиотека");
});

test("[i18n] setLocale: unknown locale ignored (no change)", () => {
  const before = getLocale();
  setLocale("fr" as "ru" | "en");
  assert.equal(getLocale(), before, "unknown locale doesn't change state");
});

test("[i18n] setLocale: persists to localStorage", () => {
  setLocale("en");
  /* Read from stub: должны увидеть запись. */
  const stored = memStore.get("bibliary_locale");
  assert.equal(stored, "en");
  setLocale("ru");
  assert.equal(memStore.get("bibliary_locale"), "ru");
});

/* ─── onLocaleChange subscriber ───────────────────────────────────── */

test("[i18n] onLocaleChange: subscriber fires on setLocale", () => {
  const seen: string[] = [];
  const unsubscribe = onLocaleChange((loc) => { seen.push(loc); });
  setLocale("en");
  setLocale("ru");
  unsubscribe();
  /* После unsubscribe больше не fire'ит. */
  setLocale("en");
  setLocale("ru");
  assert.deepEqual(seen, ["en", "ru"], "subscriber called twice, unsubscribe stopped further calls");
});

test("[i18n] onLocaleChange: doesn't fire if same locale (no-op)", () => {
  setLocale("ru");
  const seen: string[] = [];
  const unsubscribe = onLocaleChange((loc) => { seen.push(loc); });
  setLocale("ru"); /* same as current */
  unsubscribe();
  assert.deepEqual(seen, [], "no fire when locale unchanged");
});

test("[i18n] onLocaleChange: subscriber error doesn't break setLocale", () => {
  setLocale("ru");
  const unsub1 = onLocaleChange(() => { throw new Error("subscriber boom"); });
  const seen: string[] = [];
  const unsub2 = onLocaleChange((loc) => { seen.push(loc); });
  /* Должно не упасть, и второй subscriber должен получить событие. */
  setLocale("en");
  unsub1();
  unsub2();
  assert.deepEqual(seen, ["en"], "second subscriber called despite first throw");
  setLocale("ru");
});

/* ─── Cross-locale completeness check ─────────────────────────────── */

test("[i18n] cross-locale: known keys exist in both ru and en", () => {
  /* Защита от регрессии «забыли добавить перевод EN». Проверим
     несколько критичных ключей. */
  const criticalKeys = [
    "nav.library",
    "nav.models",
    "library.tab.browse",
    "library.collection.label",
    "library.empty",
  ];
  setLocale("ru");
  for (const k of criticalKeys) {
    const ru = t(k);
    assert.notEqual(ru, k, `ru: key '${k}' must have translation`);
  }
  setLocale("en");
  for (const k of criticalKeys) {
    const en = t(k);
    assert.notEqual(en, k, `en: key '${k}' must have translation`);
  }
  setLocale("ru"); /* restore */
});
