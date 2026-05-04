/**
 * Регрессионный тест: MAX_AUTO_LOAD lift 2 → 6 (Iter 14.5, 2026-05-04).
 *
 * Симптом: после Олимпиады «работает только одна нейросеть» в LM Studio.
 * Корень: MAX_AUTO_LOAD=2 покрывал лишь 2 из 6-8 уникальных champion-моделей
 * → 4-6 ролей оставались без модели → resolver fallback на единственную
 * случайно загруженную → пайплайн «не работает».
 *
 * Фикс: lift до 6 + env override BIBLIARY_MAX_AUTO_LOAD.
 *
 * Здесь тест не идёт в реальный LM Studio — проверяем только что число
 * прошито в коде arena.ipc.ts. Это «characterization test» по Feathers.
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

test("MAX_AUTO_LOAD = 6 (lift с 2 для покрытия champion-set)", () => {
  const src = readFileSync(ARENA_IPC_PATH, "utf8");
  /* Ищем `?? 6` (default value), не `MAX_AUTO_LOAD = 2`. */
  assert.ok(
    /MAX_AUTO_LOAD\s*=\s*envOverride\s*\?\?\s*6\b/.test(src),
    "MAX_AUTO_LOAD должен быть 6 (или env-override). Старое значение 2 было слишком мало.",
  );
  /* Дополнительно: убедиться что env-override используется (BIBLIARY_MAX_AUTO_LOAD). */
  assert.ok(
    src.includes("BIBLIARY_MAX_AUTO_LOAD"),
    "env BIBLIARY_MAX_AUTO_LOAD должен быть прописан как override",
  );
});

test("warn о пропущенных моделях (skipped > 0)", () => {
  const src = readFileSync(ARENA_IPC_PATH, "utf8");
  /* Skipped логирование должно быть warn, чтобы пользователь увидел что
   * не все champions загрузились. */
  assert.ok(
    src.includes("skipped") && src.includes("BIBLIARY_MAX_AUTO_LOAD"),
    "Skipped models должны логироваться с подсказкой про env override",
  );
});
