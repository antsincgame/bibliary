/**
 * Arena ratings store — Elo-рейтинги моделей по ролям.
 *
 * Хранится в `data/arena-ratings.json` через atomic write + lockfile из
 * resilience layer. Один файл на app, не партиционируется по роли —
 * структура `roles[<role>][<modelKey>] = elo` достаточно компактная.
 *
 * Используется:
 *   - run-cycle.ts: recordMatch при каждом исходе пары
 *   - model-role-resolver.ts: топ-Elo как fallback в цепочке резолва
 *   - arena.ipc.ts: get-ratings возвращает в renderer для UI таблицы
 */

import { promises as fs } from "fs";
import * as path from "path";
import { z } from "zod";

import { writeJsonAtomic, withFileLock } from "../../resilience/index.js";

const RatingsFileSchema = z.object({
  version: z.literal(1),
  /** roleId -> modelKey -> Elo (default 1500 если отсутствует). */
  roles: z.record(z.string(), z.record(z.string(), z.number())).default({}),
  lastCycleAt: z.string().optional(),
  lastError: z.string().optional(),
});

export type ArenaRatingsFile = z.infer<typeof RatingsFileSchema>;

const DEFAULT_ELO = 1500;
const K_FACTOR = 32;

let filePath: string | null = null;

/**
 * Инициализирует путь к файлу рейтингов. Должна вызываться из main.ts ДО
 * первого использования (registerArenaIpc / runArenaCycle / resolver top-Elo).
 */
export function initArenaRatingsStore(dataDir: string): void {
  filePath = path.join(dataDir, "arena-ratings.json");
}

/**
 * Возвращает путь к файлу рейтингов или null если store не инициализирован.
 * Null path означает "нет данных" — callers получают graceful empty вместо throw.
 * Это важно для unit-тестов и для model-role-resolver (topByElo читает без init).
 */
function resolvePath(): string | null {
  return filePath;
}

/**
 * Чтение файла рейтингов. Возвращает пустую структуру если:
 *   - store не инициализирован (initArenaRatingsStore не вызывался)
 *   - файл не существует
 *   - файл повреждён / Zod validation failed
 *
 * Это "lenient read" — arena и resolver никогда не должны падать из-за
 * отсутствующего/повреждённого файла рейтингов.
 */
export async function readRatingsFile(): Promise<ArenaRatingsFile> {
  const fp = resolvePath();
  if (!fp) return { version: 1, roles: {} };
  try {
    const raw = await fs.readFile(fp, "utf8");
    return RatingsFileSchema.parse(JSON.parse(raw));
  } catch {
    return { version: 1, roles: {} };
  }
}

export async function saveRatingsFile(data: ArenaRatingsFile): Promise<void> {
  const fp = resolvePath();
  if (!fp) throw new Error("Arena ratings store not initialised. Call initArenaRatingsStore(dataDir) at startup.");
  await withFileLock(fp, async () => {
    await writeJsonAtomic(fp, data);
  });
}

/**
 * winner победил loser в матче по роли `role`. Обновляет Elo обоих по
 * стандартной формуле (K=32). Атомарно: read → mutate → atomic-write
 * под file-lock.
 */
export async function recordMatch(role: string, winnerKey: string, loserKey: string): Promise<void> {
  if (winnerKey === loserKey) return;
  const fp = resolvePath();
  if (!fp) throw new Error("Arena ratings store not initialised. Call initArenaRatingsStore(dataDir) at startup.");
  await withFileLock(fp, async () => {
    const cur = await readRatingsFile();
    if (!cur.roles[role]) cur.roles[role] = {};
    const r = cur.roles[role]!;
    const ra = r[winnerKey] ?? DEFAULT_ELO;
    const rb = r[loserKey] ?? DEFAULT_ELO;
    const ea = 1 / (1 + 10 ** ((rb - ra) / 400));
    const eb = 1 / (1 + 10 ** ((ra - rb) / 400));
    r[winnerKey] = ra + K_FACTOR * (1 - ea);
    r[loserKey] = rb + K_FACTOR * (0 - eb);
    cur.lastCycleAt = new Date().toISOString();
    delete cur.lastError;
    await writeJsonAtomic(fp, cur);
  });
}

export async function resetRatings(): Promise<void> {
  await saveRatingsFile({ version: 1, roles: {} });
}

/**
 * Записать последнюю ошибку цикла. Вызывается из run-cycle при
 * неожиданном throw чтобы `lastError` не оставалось мёртвым полем.
 * Graceful: если store не инициализирован — no-op (не кидает).
 */
export async function recordCycleError(message: string): Promise<void> {
  const fp = resolvePath();
  if (!fp) return;
  try {
    await withFileLock(fp, async () => {
      const cur = await readRatingsFile();
      cur.lastError = message;
      await writeJsonAtomic(fp, cur);
    });
  } catch {
    /* Не падаем при ошибке записи диагностики — это вспомогательная функция. */
  }
}

/** Сброс пути для unit-тестов (позволяет переинициализировать с другим tmpDir). */
export function _resetArenaRatingsStoreForTests(): void {
  filePath = null;
}

export function getDefaultElo(): number {
  return DEFAULT_ELO;
}
