/**
 * LM Studio Actions Log — единая структурированная летопись действий
 * Bibliary с моделями LM Studio. Введён в v1.0.7 после "autonomous heresy"
 * инцидента, когда приложение при старте без команды пользователя начало
 * грузить модели. Лог даёт пользователю полную видимость:
 *
 *   - Кто инициировал (caller / role / reason)
 *   - Что произошло (LOAD / UNLOAD / ACQUIRE / RELEASE / etc.)
 *   - Когда (ISO timestamp)
 *   - Сколько времени заняло
 *   - Если ошибка — текст ошибки
 *
 * Хранение:
 *   - Файл: `${BIBLIARY_DATA_DIR}/logs/lmstudio-actions.log`
 *   - Формат: JSONL (одно событие = одна строка JSON)
 *   - Никакой ротации (на типичной нагрузке размер << 10 MB / месяц)
 *
 * Использование:
 *   import { logModelAction } from "../llm/lmstudio-actions-log.js";
 *   logModelAction("LOAD", { modelKey: "qwen3.5", role: "evaluator", reason: "user-import" });
 *
 * Чтение:
 *   - IPC `lmstudio:get-actions-log` → текст последних N строк
 *   - UI отображает в Models page → раздел "Логи действий"
 */

import { promises as fs } from "fs";
import * as path from "path";

export type ModelActionKind =
  | "LOAD"                     /* lmstudio.load выполнен */
  | "UNLOAD"                   /* lmstudio.unload выполнен */
  | "ACQUIRE"                  /* pool.acquire начался */
  | "ACQUIRE-OK"               /* pool.acquire успешно завершился */
  | "ACQUIRE-FAIL"             /* pool.acquire упал */
  | "RELEASE"                  /* handle.release */
  | "EVICT"                    /* pool автоматически выгрузил модель */
  | "AUTO-LOAD-START"          /* model-role-resolver.defaultAutoLoad начал */
  | "AUTO-LOAD-OK"             /* defaultAutoLoad успешно загрузил */
  | "AUTO-LOAD-FAIL"           /* defaultAutoLoad упал */
  | "RESOLVE-PASSIVE-SKIP"     /* passive caller отказался триггерить autoLoad */
  | "EVALUATOR-DEFER-RESUME"   /* книга не оценена при cold-start, ждёт явной команды */
  | "EVALUATOR-PICK-FAIL"      /* picker не смог выбрать модель */
  | "EVALUATOR-SURROGATE-TRUNCATE" /* surrogate обрезан под n_ctx модели (v1.1.2 fix) */
  | "UNIQUENESS-JUDGE";        /* uniqueness-evaluator вызвал LLM judge для серой зоны */

export interface ModelActionEvent {
  kind: ModelActionKind;
  modelKey?: string;
  role?: string;
  reason?: string;
  durationMs?: number;
  errorMsg?: string;
  /** Дополнительные структурные поля (любые, попадут в JSON как есть) */
  meta?: Record<string, unknown>;
}

let _logFilePath: string | null = null;
let _writeQueue: Promise<void> = Promise.resolve();

function getLogFilePath(): string {
  if (_logFilePath) return _logFilePath;
  const dataDir = process.env.BIBLIARY_DATA_DIR || ".";
  const logsDir = path.join(dataDir, "logs");
  _logFilePath = path.join(logsDir, "lmstudio-actions.log");
  return _logFilePath;
}

/**
 * Логирует событие модели. Fire-and-forget: НЕ блокирует caller'а, но
 * сериализует все записи через promise queue (избегаем concurrent appendFile,
 * который на NTFS может вырезать строки между собой).
 */
export function logModelAction(kind: ModelActionKind, opts: Omit<ModelActionEvent, "kind"> = {}): void {
  const ts = new Date().toISOString();
  const event = { ts, kind, ...opts };
  const line = JSON.stringify(event) + "\n";
  _writeQueue = _writeQueue
    .then(async () => {
      try {
        const p = getLogFilePath();
        await fs.mkdir(path.dirname(p), { recursive: true });
        await fs.appendFile(p, line, "utf8");
      } catch (e) {
        console.warn("[lmstudio-actions-log] write failed:", e instanceof Error ? e.message : e);
      }
    });
  /* Дублируем в console для dev-режима. Используем разные тэги по тяжести. */
  const isHeavy = kind === "LOAD" || kind === "AUTO-LOAD-START" || kind === "AUTO-LOAD-OK";
  const consoleFn = isHeavy ? console.log : console.debug;
  consoleFn(`[lmstudio-action] ${kind}`, opts);
}

/**
 * Читает последние `maxLines` строк лога. Если файла нет — возвращает "".
 * Ошибки чтения превращает в пустую строку (caller сам решит что показать).
 */
export async function readActionsLog(maxLines = 500): Promise<string> {
  try {
    const content = await fs.readFile(getLogFilePath(), "utf8");
    const lines = content.split("\n").filter((l) => l.length > 0);
    const tail = lines.slice(-maxLines);
    return tail.join("\n");
  } catch {
    return "";
  }
}

/**
 * Очищает лог (удаляет файл). Использует UI «Очистить» button.
 */
export async function clearActionsLog(): Promise<void> {
  try {
    await fs.rm(getLogFilePath(), { force: true });
  } catch (e) {
    console.warn("[lmstudio-actions-log] clear failed:", e instanceof Error ? e.message : e);
  }
}

/**
 * Для тестов: переопределить путь к файлу лога. После теста — null.
 */
export function _setLogFilePathForTests(p: string | null): void {
  _logFilePath = p;
}

/**
 * Дренаж очереди записей. Ждать пока всё что мы залогали — на диске.
 * Используется в shutdown handler'ах и в тестах.
 */
export async function flushActionsLog(): Promise<void> {
  await _writeQueue;
}
