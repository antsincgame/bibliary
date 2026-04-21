/**
 * LM Studio config patcher — пишет / откатывает rope_scaling JSON в model card.
 *
 * Гарантии:
 *  - Atomic write (tmp + rename). Сбой питания не оставляет полу-записанный config.
 *  - Бэкап перед первой записью в `config.bibliary.bak.json` рядом с config.
 *  - Cross-process safety через withFileLock.
 *  - revert восстанавливает оригинал из бэкапа и удаляет .bak.
 *
 * Где ищем model card:
 *  - LM Studio складывает GGUF в `~/.cache/lm-studio/models/<author>/<repo>/`.
 *  - Конфиг лежит как `config.json` рядом с .gguf (если был импортирован c HF).
 *  - Если `config.json` отсутствует, мы создаём его: rope_scaling — единственное
 *    поле, которое реально нужно для YaRN; остальные поля LM Studio читает из
 *    .gguf metadata.
 */

import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";

import { withFileLock } from "../resilience/file-lock";
import { writeJsonAtomic } from "../resilience/atomic-write";
import { LOCK_RETRIES, LOCK_STALE_MS } from "../resilience/constants";
import type { RopeScalingConfig } from "./engine";

// ─────────────────────────────────────────────────────────────────────────────
// Поиск model card
// ─────────────────────────────────────────────────────────────────────────────

/** Корень моделей LM Studio. Override через ENV для тестов. */
export function getLMStudioModelsRoot(): string {
  if (process.env.LMSTUDIO_MODELS_DIR) return process.env.LMSTUDIO_MODELS_DIR;
  return path.join(os.homedir(), ".cache", "lm-studio", "models");
}

/** Преобразует modelKey "qwen/qwen3.6-35b-a3b" в путь "<root>/qwen/qwen3.6-35b-a3b". */
export function resolveModelDir(modelKey: string): string {
  const root = getLMStudioModelsRoot();
  return path.join(root, modelKey);
}

/** Путь к config.json для конкретного modelKey. */
export function resolveConfigPath(modelKey: string): string {
  return path.join(resolveModelDir(modelKey), "config.json");
}

/** Путь к нашему backup config'у. */
export function resolveBackupPath(modelKey: string): string {
  return path.join(resolveModelDir(modelKey), "config.bibliary.bak.json");
}

// ─────────────────────────────────────────────────────────────────────────────
// I/O helpers
// ─────────────────────────────────────────────────────────────────────────────

async function readJsonOrNull<T>(filePath: string): Promise<T | null> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  // withFileLock создаёт sentinel пустой файл при первом обращении — это не "был config",
  // это просто placeholder для lockfile. Воспринимаем как отсутствующий.
  if (!raw.trim()) return null;
  return JSON.parse(raw) as T;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

const LOCK_OPTS = { retries: LOCK_RETRIES, stale: LOCK_STALE_MS };

// ─────────────────────────────────────────────────────────────────────────────
// API
// ─────────────────────────────────────────────────────────────────────────────

export interface PatchResult {
  configPath: string;
  backupCreated: boolean;
  /** Был ли rope_scaling уже в файле до записи. */
  hadPriorRopeScaling: boolean;
}

/**
 * Записать rope_scaling JSON в config.json модели.
 *
 * Если model dir не существует — кидает ошибку (модель не скачана).
 * Если config.json отсутствует — создаёт минимальный с одним полем rope_scaling.
 * Если config.json есть, но без бэкапа — копирует в .bak перед первой правкой.
 * Повторные правки не пересоздают .bak (он защищает оригинал).
 */
export async function applyRopeScaling(
  modelKey: string,
  scaling: RopeScalingConfig
): Promise<PatchResult> {
  const dir = resolveModelDir(modelKey);
  const configPath = resolveConfigPath(modelKey);
  const backupPath = resolveBackupPath(modelKey);

  if (!(await pathExists(dir))) {
    throw new Error(`Model directory not found: ${dir}`);
  }

  return withFileLock(
    configPath,
    async () => {
      const current = await readJsonOrNull<Record<string, unknown>>(configPath);
      const hadPriorRopeScaling = current != null && typeof current.rope_scaling === "object" && current.rope_scaling != null;

      // Бэкап только при первой правке (пока .bak не существует).
      let backupCreated = false;
      if (!(await pathExists(backupPath))) {
        if (current != null) {
          await writeJsonAtomic(backupPath, current);
          backupCreated = true;
        } else {
          // config.json отсутствовал — пишем sentinel-бэкап `null` чтобы revert смог удалить config.
          await writeJsonAtomic(backupPath, { __bibliary_no_original__: true });
          backupCreated = true;
        }
      }

      const next = { ...(current ?? {}), rope_scaling: scaling };
      await writeJsonAtomic(configPath, next);

      return { configPath, backupCreated, hadPriorRopeScaling };
    },
    LOCK_OPTS
  );
}

export interface RevertResult {
  configPath: string;
  restored: boolean;
  /** True, если backup был sentinel — config.json удалён вместо восстановления. */
  configRemoved: boolean;
}

/**
 * Откатить YaRN: восстановить config.json из бэкапа, удалить .bak.
 *
 * Если бэкапа нет — кидает ошибку (нечего восстанавливать).
 * Если backup это sentinel `{ __bibliary_no_original__: true }` — удаляет
 * config.json (значит до нас файла не было).
 */
export async function revertRopeScaling(modelKey: string): Promise<RevertResult> {
  const configPath = resolveConfigPath(modelKey);
  const backupPath = resolveBackupPath(modelKey);

  if (!(await pathExists(backupPath))) {
    throw new Error(`No backup found for ${modelKey} at ${backupPath}`);
  }

  return withFileLock(
    configPath,
    async () => {
      const backup = await readJsonOrNull<Record<string, unknown>>(backupPath);
      if (backup == null) {
        throw new Error(`Backup file unreadable at ${backupPath}`);
      }
      let configRemoved = false;
      if (backup.__bibliary_no_original__) {
        await fs.unlink(configPath).catch(() => undefined);
        configRemoved = true;
      } else {
        await writeJsonAtomic(configPath, backup);
      }
      await fs.unlink(backupPath).catch(() => undefined);
      return { configPath, restored: true, configRemoved };
    },
    LOCK_OPTS
  );
}

/**
 * Прочитать текущий rope_scaling (если есть) — для UI «slider показывает текущее».
 * Не требует lock'а: чтение неконкурирующее, atomic-write гарантирует целостность.
 */
export async function readCurrentRopeScaling(modelKey: string): Promise<RopeScalingConfig | null> {
  const configPath = resolveConfigPath(modelKey);
  const config = await readJsonOrNull<{ rope_scaling?: RopeScalingConfig }>(configPath);
  if (!config || !config.rope_scaling) return null;
  const rs = config.rope_scaling;
  if (rs.rope_type !== "yarn") return null;
  return rs;
}

/**
 * Есть ли активный YaRN-патч (для UI badge "Memory: extended").
 */
export async function hasActivePatch(modelKey: string): Promise<boolean> {
  return (await readCurrentRopeScaling(modelKey)) !== null;
}

/**
 * Есть ли бэкап (значит — мы патчили модель, можно revert).
 */
export async function hasBackup(modelKey: string): Promise<boolean> {
  return pathExists(resolveBackupPath(modelKey));
}
