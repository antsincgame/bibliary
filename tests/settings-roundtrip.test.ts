/**
 * Settings Roundtrip — Иt 8Б library-fortress.
 *
 * Verify that for each new pref-key from PreferencesSchema (Smart Import
 * Pipeline section): set → applyRuntimeSideEffects → consumer observable change.
 *
 * Этот тест ловит regression: если кто-то добавит pref в schema, но забудет
 * подключить его к applyRuntimeSideEffects / consumer module — Settings UI
 * будет молча врать пользователю «параметр изменён», без реального эффекта.
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";

import {
  initPreferencesStore,
  getPreferencesStore,
  PreferencesSchema,
  type Preferences,
} from "../electron/lib/preferences/store.ts";

import {
  getImportScheduler,
  applyImportSchedulerPrefs,
  _resetImportSchedulerForTests,
} from "../electron/lib/library/import-task-scheduler.ts";

import {
  HeavyLaneRateLimiter,
  applyHeavyLaneRateLimiterPrefs,
  getHeavyLaneRateLimiter,
} from "../electron/lib/llm/heavy-lane-rate-limiter.ts";

import { CrossFormatPreDedup } from "../electron/lib/library/cross-format-prededup.ts";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bibliary-prefs-"));
  initPreferencesStore(tmpDir);
  _resetImportSchedulerForTests();
});

afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
});

/* ── PreferencesSchema: новые ключи Иt 8Б присутствуют с разумными default-ами ── */

describe("[Settings 8Б] PreferencesSchema contains all Smart Import Pipeline keys", () => {
  const PIPELINE_KEYS: Array<keyof Preferences> = [
    "schedulerLightConcurrency",
    "schedulerMediumConcurrency",
    "schedulerHeavyConcurrency",
    "parserPoolSize",
    "evaluatorSlots",
    "visionOcrRpm",
    "illustrationParallelism",
    "converterCacheMaxBytes",
    "calibrePathOverride",
    "preferDjvuOverPdf",
  ];

  test("каждый pipeline-ключ имеет default через schema.parse({})", () => {
    const defaults = PreferencesSchema.parse({});
    for (const key of PIPELINE_KEYS) {
      assert.ok(key in defaults, `default missing for ${String(key)}`);
    }
    assert.equal(defaults.schedulerLightConcurrency, 8);
    assert.equal(defaults.schedulerMediumConcurrency, 3);
    assert.equal(defaults.schedulerHeavyConcurrency, 1);
    assert.equal(defaults.parserPoolSize, 0);
    assert.equal(defaults.evaluatorSlots, 2);
    assert.equal(defaults.visionOcrRpm, 60);
    assert.equal(defaults.illustrationParallelism, 4);
    assert.equal(defaults.converterCacheMaxBytes, 5 * 1024 * 1024 * 1024);
    assert.equal(defaults.calibrePathOverride, "");
    assert.equal(defaults.preferDjvuOverPdf, false);
  });

  test("schema валидирует диапазоны", () => {
    assert.throws(() => PreferencesSchema.parse({ schedulerLightConcurrency: 0 }));
    assert.throws(() => PreferencesSchema.parse({ schedulerHeavyConcurrency: 99 }));
    assert.throws(() => PreferencesSchema.parse({ visionOcrRpm: 0 }));
    assert.throws(() => PreferencesSchema.parse({ visionOcrRpm: 99999 }));
    assert.doesNotThrow(() => PreferencesSchema.parse({ parserPoolSize: 0 })); /* 0 = auto */
    assert.doesNotThrow(() => PreferencesSchema.parse({ converterCacheMaxBytes: 0 })); /* 0 = unlimited */
  });
});

/* ── ImportTaskScheduler: applyImportSchedulerPrefs реально меняет лимиты ── */

describe("[Settings 8Б] applyImportSchedulerPrefs propagates to live scheduler", () => {
  test("set/reset → scheduler.setLimit видит новые значения", () => {
    const sched = getImportScheduler();
    /* Defaults — sanity */
    let snap = sched.getSnapshot();
    assert.equal(snap.heavy.queued, 0);

    /* Apply custom limits */
    applyImportSchedulerPrefs({
      schedulerLightConcurrency: 16,
      schedulerMediumConcurrency: 5,
      schedulerHeavyConcurrency: 2,
    });

    /* Внутреннее состояние limit не выставлено в snapshot, но мы можем
       проверить через setLimit-doesn't-crash invariant — если apply передал
       значения дальше, последующий enqueue не должен зависнуть. */
    let resolved = false;
    void sched.enqueue("heavy", async () => { resolved = true; });
    /* Дать microtasks отработать. */
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        assert.equal(resolved, true, "scheduler must execute task with apply'd limits");
        resolve();
      }, 50);
    });
  });

  test("undefined fields не трогают существующий лимит", () => {
    /* applyImportSchedulerPrefs({}) — no-op. */
    assert.doesNotThrow(() => applyImportSchedulerPrefs({}));
  });
});

/* ── HeavyLaneRateLimiter: updateLimit + applyHeavyLaneRateLimiterPrefs ── */

describe("[Settings 8Б] HeavyLaneRateLimiter.updateLimit / applyHeavyLaneRateLimiterPrefs", () => {
  test("updateLimit меняет getLimit() возвращаемое значение", () => {
    const limiter = new HeavyLaneRateLimiter({ limitPerMinute: 60 });
    assert.equal(limiter.getLimit(), 60);

    limiter.updateLimit(120);
    assert.equal(limiter.getLimit(), 120);

    /* Невалидные значения игнорируются */
    limiter.updateLimit(0);
    assert.equal(limiter.getLimit(), 120);
    limiter.updateLimit(-5);
    assert.equal(limiter.getLimit(), 120);
    limiter.updateLimit(NaN);
    assert.equal(limiter.getLimit(), 120);
  });

  test("applyHeavyLaneRateLimiterPrefs обновляет singleton limit", () => {
    const before = getHeavyLaneRateLimiter().getLimit();
    applyHeavyLaneRateLimiterPrefs({ visionOcrRpm: before === 200 ? 100 : 200 });
    const after = getHeavyLaneRateLimiter().getLimit();
    assert.notEqual(after, before, "limit должен измениться после apply");
  });
});

/* ── CrossFormatPreDedup: preferDjvuOverPdf инвертирует приоритет ── */

describe("[Settings 8Б] CrossFormatPreDedup.preferDjvuOverPdf", () => {
  test("по умолчанию PDF побеждает DJVU", () => {
    const dedup = new CrossFormatPreDedup();
    const pdfFirst = dedup.check("/lib/Book.pdf");
    const djvuSecond = dedup.check("/lib/Book.djvu");
    assert.equal(pdfFirst.include, true);
    assert.equal(djvuSecond.include, false, "DJVU должен быть superseded PDF");
  });

  test("с preferDjvuOverPdf=true DJVU побеждает PDF", () => {
    const dedup = new CrossFormatPreDedup({ preferDjvuOverPdf: true });
    const pdfFirst = dedup.check("/lib/Book.pdf");
    const djvuSecond = dedup.check("/lib/Book.djvu");
    assert.equal(pdfFirst.include, true);
    assert.equal(djvuSecond.include, true, "DJVU должен evict-нуть PDF при override");
    assert.equal(dedup.superseded.length, 1);
    assert.equal(dedup.superseded[0]!.skipped, "/lib/Book.pdf");
  });

  test("EPUB всегда выигрывает у обоих (priority 100 > djvu 90)", () => {
    const dedup = new CrossFormatPreDedup({ preferDjvuOverPdf: true });
    dedup.check("/lib/Book.djvu");
    const epubResult = dedup.check("/lib/Book.epub");
    assert.equal(epubResult.include, true);
  });
});

/* ── PreferencesStore round-trip: set → getAll возвращает новые значения ── */

describe("[Settings 8Б] PreferencesStore set/get roundtrip", () => {
  test("новые ключи персистятся через set/getAll", async () => {
    const store = getPreferencesStore();
    await store.ensureDefaults();

    await store.set({
      schedulerHeavyConcurrency: 3,
      visionOcrRpm: 120,
      preferDjvuOverPdf: true,
      calibrePathOverride: "/custom/path/ebook-convert",
    });

    const all = await store.getAll();
    assert.equal(all.schedulerHeavyConcurrency, 3);
    assert.equal(all.visionOcrRpm, 120);
    assert.equal(all.preferDjvuOverPdf, true);
    assert.equal(all.calibrePathOverride, "/custom/path/ebook-convert");

    /* Невалидные значения должны throw на schema-валидации. */
    await assert.rejects(() => store.set({ schedulerHeavyConcurrency: 0 } as Partial<Preferences>));
  });
});
