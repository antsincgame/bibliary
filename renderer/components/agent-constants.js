// @ts-check
/**
 * Renderer-side зеркало agent-констант, которые используются и в backend
 * (`electron/lib/agent/history-sanitize.ts → DEFAULT_HISTORY_CAP`), и в
 * renderer (`renderer/forge-agent.js → AGENT_HISTORY_CAP`).
 *
 * S1.3 (Sherlok): раньше `50` дублировался в двух местах разных процессов
 * без явной связи — изменение одного значения легко забывалось во втором.
 * Теперь UI-сторона импортирует константу из одного места.
 *
 * Backend-сторона (electron/lib/agent/history-sanitize.ts) хранит ту же
 * константу `DEFAULT_HISTORY_CAP` — Renderer и Electron работают в разных
 * tsconfig/процессах, поэтому литеральная константа дублируется, но обе
 * точки явно ссылаются друг на друга через комментарии. Если меняешь
 * значение здесь — синхронизируй с DEFAULT_HISTORY_CAP в history-sanitize.ts.
 */

/**
 * Максимум сообщений в STATE.chatHistory агента.
 * Mirror of DEFAULT_HISTORY_CAP in electron/lib/agent/history-sanitize.ts.
 */
export const AGENT_HISTORY_CAP = 50;
