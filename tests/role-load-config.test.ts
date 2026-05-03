/**
 * role-load-config — per-role LM Studio tuning.
 *
 * Тесты проверяют:
 *   1. Каждая роль из ModelRole имеет валидный load config
 *   2. contextLength внутри разумных границ (1K..64K)
 *   3. flashAttention обязателен для длинных контекстов (≥8K)
 *   4. Inference defaults — temperature ∈ [0..1], maxTokens > 0
 *   5. Безопасный fallback для неизвестной роли
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ROLE_LOAD_CONFIG,
  ROLE_INFERENCE_DEFAULTS,
  getRoleLoadConfig,
  getRoleInferenceDefaults,
} from "../electron/lib/llm/role-load-config.ts";

const KNOWN_ROLES = [
  "crystallizer",
  "vision_meta",
  "vision_ocr",
  "vision_illustration",
  "evaluator",
  "ukrainian_specialist",
  "lang_detector",
  "translator",
  "layout_assistant",
] as const;

test("role-load-config: каждая известная роль имеет load config", () => {
  for (const role of KNOWN_ROLES) {
    const cfg = ROLE_LOAD_CONFIG[role];
    assert.ok(cfg, `Роль ${role}: ROLE_LOAD_CONFIG отсутствует`);
    assert.ok(typeof cfg.contextLength === "number", `Роль ${role}: contextLength must be number`);
    assert.ok(cfg.contextLength! >= 512 && cfg.contextLength! <= 65_536,
      `Роль ${role}: contextLength=${cfg.contextLength} вне [512, 65536]`);
  }
});

test("role-load-config: длинные контексты (≥8K) требуют flashAttention", () => {
  /* FlashAttention даёт x2 на длинных контекстах. Если ctx≥8K и FA выключен —
   * это пропуск производительности, либо неверная конфигурация роли. */
  const violators: string[] = [];
  for (const role of KNOWN_ROLES) {
    const cfg = ROLE_LOAD_CONFIG[role];
    if ((cfg.contextLength ?? 0) >= 8_192 && cfg.flashAttention !== true) {
      violators.push(`${role}: ctx=${cfg.contextLength} но flashAttention=${cfg.flashAttention}`);
    }
  }
  assert.deepEqual(violators, [], `Длинные контексты без FA:\n  - ${violators.join("\n  - ")}`);
});

test("role-load-config: inference defaults валидны для каждой роли", () => {
  for (const role of KNOWN_ROLES) {
    const inf = ROLE_INFERENCE_DEFAULTS[role];
    assert.ok(inf, `Роль ${role}: inference defaults отсутствуют`);
    assert.ok(inf.temperature >= 0 && inf.temperature <= 2,
      `Роль ${role}: temperature=${inf.temperature} вне [0, 2]`);
    assert.ok(inf.topP > 0 && inf.topP <= 1,
      `Роль ${role}: topP=${inf.topP} вне (0, 1]`);
    assert.ok(inf.maxTokens > 0 && inf.maxTokens <= 16_384,
      `Роль ${role}: maxTokens=${inf.maxTokens} вне (0, 16384]`);
  }
});

test("role-load-config: structured-output роли имеют низкую температуру (≤0.3)", () => {
  /* JSON-генерация и one-token-output требуют детерминизма.
   * Высокая температура → нестабильный JSON / случайные A/B / случайные языки. */
  const STRUCTURED = ["lang_detector", "vision_meta", "vision_ocr", "evaluator"];
  const violators: string[] = [];
  for (const role of STRUCTURED) {
    const inf = ROLE_INFERENCE_DEFAULTS[role as never];
    if (inf.temperature > 0.3) {
      violators.push(`${role}: temp=${inf.temperature} (ожидаем ≤0.3 для структурного output)`);
    }
  }
  assert.deepEqual(violators, [], `Высокая температура у структурного output:\n  - ${violators.join("\n  - ")}`);
});

/* Тест "judge maxTokens ≤32" удалён 2026-05-01 (Иt 8А library-fortress)
 * вместе с самой ролью `judge` в model-role-resolver / role-load-config. */

test("role-load-config: lang_detector maxTokens должен быть очень маленьким (≤16)", () => {
  const inf = ROLE_INFERENCE_DEFAULTS.lang_detector;
  assert.ok(inf.maxTokens <= 16, `lang_detector maxTokens=${inf.maxTokens}, ожидаем ≤16`);
});

test("role-load-config: crystallizer maxTokens должен быть достаточным для structured output (≥1024)", () => {
  /* Crystallizer возвращает JSON со списком facts/entities/relations.
   * При маленьком maxTokens модель truncates JSON → невалидный output. */
  const inf = ROLE_INFERENCE_DEFAULTS.crystallizer;
  assert.ok(inf.maxTokens >= 1024, `crystallizer maxTokens=${inf.maxTokens}, ожидаем ≥1024`);
});

test("role-load-config: getRoleLoadConfig возвращает безопасный fallback для unknown role", () => {
  /* @ts-expect-error — намеренно неизвестная роль. */
  const cfg = getRoleLoadConfig("unknown_role");
  assert.ok(cfg.contextLength && cfg.contextLength >= 1024,
    `Fallback должен иметь contextLength ≥1024, получили ${cfg.contextLength}`);
  assert.ok(cfg.gpu, "Fallback должен задать gpu");
});

test("role-load-config: getRoleInferenceDefaults возвращает безопасный fallback для unknown role", () => {
  /* @ts-expect-error — unknown role. */
  const inf = getRoleInferenceDefaults("unknown_role");
  assert.ok(inf.temperature >= 0 && inf.temperature <= 1, `temp out of range`);
  assert.ok(inf.topP > 0 && inf.topP <= 1, `topP out of range`);
  assert.ok(inf.maxTokens > 0, `maxTokens must be positive`);
});

test("role-load-config: vision-роли все имеют keepModelInMemory=true", () => {
  /* Vision-модели тяжело грузить (часто 7B+ multimodal). Если их свопить в
   * диск каждый раз — batch import обложек/иллюстраций встанет. */
  const VISION_ROLES = ["vision_meta", "vision_ocr", "vision_illustration"] as const;
  const violators: string[] = [];
  for (const role of VISION_ROLES) {
    if (ROLE_LOAD_CONFIG[role].keepModelInMemory !== true) {
      violators.push(role);
    }
  }
  assert.deepEqual(violators, [], `Vision-роли без keepModelInMemory: ${violators.join(", ")}`);
});
