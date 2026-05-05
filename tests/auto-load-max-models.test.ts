/**
 * v1.0.8 (2026-05-05, /om /sparta «уничтожить ересь»):
 *
 * Анти-регрессионный тест: ПРОТИВОПОЛОЖНОСТЬ старому контракту Iter 14.5.
 *
 * История:
 *   - Iter 14.5 (2026-05-04): MAX_AUTO_LOAD lift 2 → 6 — proactive batch-load
 *     6 моделей в LM Studio после Olympics, чтобы решить баг «работает только
 *     одна нейросеть».
 *   - v1.0.7 (2026-05-04): per-book on-demand auto-load в evaluator-queue
 *     (allowAutoLoad opt-in). Это закрыло root-cause симптома без proactive
 *     batch.
 *   - v1.0.8 (2026-05-05): proactive batch ПОЛНОСТЬЮ УБРАН. Был 4-м каналом
 *     autonomous load моделей без user consent. Грузил до 6 моделей фоном +
 *     выгружал «лишние» через VRAM cleanup. Логировался ТОЛЬКО в console.log
 *     (не в actions-log) — невидимая ересь.
 *
 * Этот тест ЗАЩИЩАЕТ от рецидива: проверяем что в `arena.ipc.ts`:
 *   1. Больше НЕТ функции `ensureRecommendedModelsLoaded`.
 *   2. Больше НЕТ `MAX_AUTO_LOAD` константы.
 *   3. Больше НЕТ `BIBLIARY_MAX_AUTO_LOAD` env override.
 *   4. Больше НЕТ `activeAutoLoadCtrl` / `abortActiveAutoLoad`.
 *   5. Больше НЕТ импорта `loadModel` или `unloadModel` из lmstudio-client.
 *   6. ЕСТЬ структурное событие `OLYMPICS-APPLY-PREFS-ONLY` в actions-log.
 *
 * Если кто-то в будущем попытается вернуть proactive batch-load — этот тест
 * упадёт и заставит пройти review через v1.0.7 contract (per-book opt-in).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARENA_IPC_PATH = path.join(
  __dirname,
  "..",
  "electron",
  "ipc",
  "arena.ipc.ts",
);

test("v1.0.8 EXTERMINATUS: ensureRecommendedModelsLoaded удалена", () => {
  const src = readFileSync(ARENA_IPC_PATH, "utf8");
  /* Имя функции должно встречаться ТОЛЬКО в комментарии-эпитафии,
   * но НЕ как объявление функции (`async function ensureRecommendedModelsLoaded`)
   * и НЕ как вызов (`ensureRecommendedModelsLoaded(`). */
  assert.ok(
    !/async\s+function\s+ensureRecommendedModelsLoaded/.test(src),
    "Функция ensureRecommendedModelsLoaded должна быть удалена",
  );
  assert.ok(
    !/\bensureRecommendedModelsLoaded\s*\(/.test(src),
    "Вызовы ensureRecommendedModelsLoaded должны быть удалены",
  );
});

test("v1.0.8 EXTERMINATUS: MAX_AUTO_LOAD и env override удалены", () => {
  const src = readFileSync(ARENA_IPC_PATH, "utf8");
  /* Code-level mentions удалены. Допустимо в комментариях / changelog reference.
   * Проверяем что нет константы или env get. */
  assert.ok(
    !/const\s+MAX_AUTO_LOAD\b/.test(src),
    "Константа MAX_AUTO_LOAD должна быть удалена",
  );
  assert.ok(
    !/process\.env\.BIBLIARY_MAX_AUTO_LOAD/.test(src),
    "process.env.BIBLIARY_MAX_AUTO_LOAD должно быть удалено",
  );
});

test("v1.0.8 EXTERMINATUS: activeAutoLoadCtrl / abortActiveAutoLoad удалены", () => {
  const src = readFileSync(ARENA_IPC_PATH, "utf8");
  assert.ok(
    !/let\s+activeAutoLoadCtrl/.test(src),
    "Глобальный activeAutoLoadCtrl должен быть удалён",
  );
  assert.ok(
    !/function\s+abortActiveAutoLoad/.test(src),
    "Функция abortActiveAutoLoad должна быть удалена",
  );
});

test("v1.0.8 EXTERMINATUS: loadModel/unloadModel импорты удалены из arena.ipc.ts", () => {
  const src = readFileSync(ARENA_IPC_PATH, "utf8");
  /* Импорт из lmstudio-client больше не должен включать loadModel или unloadModel.
   * Только refreshLmStudioClient (для invalidate cache при apply prefs). */
  const importLine = src.match(/import\s+\{[^}]*\}\s+from\s+["']\.\.\/lmstudio-client\.js["']/);
  assert.ok(importLine, "Должен остаться один импорт из lmstudio-client.js");
  assert.ok(
    !importLine[0].includes("loadModel"),
    `arena.ipc.ts больше НЕ должен импортировать loadModel: "${importLine[0]}"`,
  );
  assert.ok(
    !importLine[0].includes("unloadModel"),
    `arena.ipc.ts больше НЕ должен импортировать unloadModel: "${importLine[0]}"`,
  );
});

test("v1.0.8: OLYMPICS-APPLY-PREFS-ONLY audit-trail событие пишется", () => {
  const src = readFileSync(ARENA_IPC_PATH, "utf8");
  assert.ok(
    src.includes("OLYMPICS-APPLY-PREFS-ONLY"),
    "После apply-recommendations должно писаться событие OLYMPICS-APPLY-PREFS-ONLY в actions-log",
  );
  assert.ok(
    /logModelAction\s*\(\s*["']OLYMPICS-APPLY-PREFS-ONLY["']/.test(src),
    "Событие должно идти через logModelAction (структурный лог), не console.log",
  );
});

test("v1.0.8: lmstudio-actions-log поддерживает OLYMPICS-APPLY-PREFS-ONLY", () => {
  const LOG_PATH = path.join(
    __dirname,
    "..",
    "electron",
    "lib",
    "llm",
    "lmstudio-actions-log.ts",
  );
  const src = readFileSync(LOG_PATH, "utf8");
  assert.ok(
    /["']OLYMPICS-APPLY-PREFS-ONLY["']/.test(src),
    "ModelActionKind должен включать OLYMPICS-APPLY-PREFS-ONLY",
  );
});
