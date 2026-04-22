/**
 * Pure helper для санитизации multiturn-истории агента (B1).
 *
 * Изначально жил inline в `agent.ipc.ts`, вынесен в отдельный модуль
 * чтобы покрыть unit-тестами без поднятия Electron/IPC. Контракт:
 *
 *   - принимает произвольный input (массив или мусор)
 *   - выкидывает не-объекты, неверные роли, пустой/не-строковый content
 *   - режет до последних `cap` сообщений (FIFO eviction)
 *   - возвращает чистый массив `AgentMessage`-совместимых объектов
 *
 * Используется в `agent:start` IPC и в тестах (`scripts/test-agent-internals.ts`).
 */

import type { AgentMessage } from "./types.js";

/**
 * Максимальная длина истории, передаваемая бэкенду по умолчанию.
 *
 * S1.3 (Sherlok): зеркало этой константы живёт в renderer-side
 * `renderer/components/agent-constants.js → AGENT_HISTORY_CAP`. Renderer
 * и Electron работают в разных tsconfig/процессах — единого импорта нет.
 * Если меняешь это значение — синхронизируй с renderer.
 */
export const DEFAULT_HISTORY_CAP = 50;

export interface RawHistoryItem {
  role?: unknown;
  content?: unknown;
}

/**
 * Очищает массив сообщений от мусора и обрезает до последних `cap` записей.
 * Возвращает только валидные `user`/`assistant` сообщения с непустым строковым контентом.
 */
export function sanitizeAgentHistory(
  raw: unknown,
  cap: number = DEFAULT_HISTORY_CAP,
): AgentMessage[] {
  if (!Array.isArray(raw)) return [];
  const limit = Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : DEFAULT_HISTORY_CAP;
  const out: AgentMessage[] = [];
  for (const item of raw as RawHistoryItem[]) {
    if (item === null || typeof item !== "object") continue;
    const role = item.role;
    const content = item.content;
    if (role !== "user" && role !== "assistant") continue;
    if (typeof content !== "string" || content.length === 0) continue;
    out.push({ role, content });
  }
  if (out.length <= limit) return out;
  return out.slice(out.length - limit);
}
