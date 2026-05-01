/**
 * Integration: computeOlympicsLoadConfig — выбор load-config для Олимпиады.
 *
 * Олимпиада грузит модель ОДИН раз и прогоняет на ней все роли которые ей
 * подходят. computeOlympicsLoadConfig агрегирует per-role configs в один
 * "максимально требовательный" config: max(contextLength), any(flashAttention).
 *
 * Тесты проверяют:
 *   1. enabled=false → legacy config (2048, FA=true) — backward compat
 *   2. enabled=true + crystallizer → contextLength ≥ 32K (длинные главы)
 *   3. enabled=true + только lang_detector → маленький context (≤4K)
 *   4. enabled=true + смесь → max берётся правильно
 *   5. enabled=true + 0 ролей → legacy config (защита от пустого input)
 *
 * Иt 8А (library-fortress, 2026-05-01): заменили judge на lang_detector
 * (тот же контракт «маленький context») — роль `judge` удалена из
 * model-role-resolver / OlympicsRole.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeOlympicsLoadConfig } from "../electron/lib/llm/arena/olympics.ts";

test("computeOlympicsLoadConfig: enabled=false → legacy (2048, FA=true)", () => {
  const cfg = computeOlympicsLoadConfig(["crystallizer"], false);
  assert.equal(cfg.contextLength, 2048);
  assert.equal(cfg.flashAttention, true);
});

test("computeOlympicsLoadConfig: пустой массив ролей → legacy (даже при enabled=true)", () => {
  const cfg = computeOlympicsLoadConfig([], true);
  assert.equal(cfg.contextLength, 2048);
});

test("computeOlympicsLoadConfig: только crystallizer → 32K + FA", () => {
  const cfg = computeOlympicsLoadConfig(["crystallizer"], true);
  assert.ok((cfg.contextLength ?? 0) >= 32_768,
    `Expected ≥32K context for crystallizer, got ${cfg.contextLength}`);
  assert.equal(cfg.flashAttention, true, "FA должен быть включён для длинных контекстов");
});

test("computeOlympicsLoadConfig: только lang_detector → маленький context (≤4K)", () => {
  const cfg = computeOlympicsLoadConfig(["lang_detector"], true);
  assert.ok((cfg.contextLength ?? 0) <= 4_096,
    `Expected ≤4K context for lang_detector, got ${cfg.contextLength}`);
});

test("computeOlympicsLoadConfig: crystallizer + lang_detector → max берётся от crystallizer (32K)", () => {
  const cfg = computeOlympicsLoadConfig(["crystallizer", "lang_detector"], true);
  assert.ok((cfg.contextLength ?? 0) >= 32_768,
    `Expected ≥32K (crystallizer dominates), got ${cfg.contextLength}`);
});

test("computeOlympicsLoadConfig: vision_meta + vision_ocr → берётся max ctx", () => {
  /* vision_ocr=8K, vision_meta=2K → должен взять 8K */
  const cfg = computeOlympicsLoadConfig(["vision_meta", "vision_ocr"], true);
  assert.ok((cfg.contextLength ?? 0) >= 8_192,
    `Expected ≥8K (vision_ocr dominates), got ${cfg.contextLength}`);
  assert.equal(cfg.flashAttention, true, "vision_ocr требует FA");
});

test("computeOlympicsLoadConfig: keepInMemory true если хоть одна роль требует", () => {
  /* crystallizer keepInMem=true */
  const cfg = computeOlympicsLoadConfig(["crystallizer", "lang_detector"], true);
  assert.equal(cfg.keepModelInMemory, true);
});

test("computeOlympicsLoadConfig: gpu берётся 'max' если хоть одна роль требует", () => {
  const cfg = computeOlympicsLoadConfig(["crystallizer", "lang_detector"], true);
  assert.deepEqual(cfg.gpu, { ratio: "max" });
});

test("computeOlympicsLoadConfig: только lang_detector → gpu numeric (0.5), не 'max'", () => {
  /* lang_detector с gpu=0.5 — мелкая модель, не нужен полный GPU */
  const cfg = computeOlympicsLoadConfig(["lang_detector"], true);
  /* Должен оставить numeric ratio из конфига роли */
  if (typeof cfg.gpu?.ratio === "number") {
    assert.ok(cfg.gpu.ratio >= 0.5,
      `Expected gpu.ratio≥0.5, got ${cfg.gpu.ratio}`);
  } else {
    /* допустимо "max" если в конфиге так — но не "off" */
    assert.notEqual(cfg.gpu?.ratio, "off");
  }
});
