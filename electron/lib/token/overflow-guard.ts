/**
 * ContextOverflowGuard — закрывает баг LM Studio #1806 (context overflow → garbage без ошибки).
 *
 * Хранит заявленный contextLength по identifier модели после load.
 * Перед каждым chat() pipeline должен вызывать `assertFits(modelKey, messages, maxCompletion)` —
 * если не помещается, выбрасывается `ContextOverflowError` с подробностями.
 */
import { TokenBudgetManager, type ChatMessage } from "./budget";

export class ContextOverflowError extends Error {
  readonly modelKey: string;
  readonly required: number;
  readonly available: number;
  constructor(modelKey: string, required: number, available: number) {
    super(`Context overflow for ${modelKey}: required ${required}, available ${available}`);
    this.name = "ContextOverflowError";
    this.modelKey = modelKey;
    this.required = required;
    this.available = available;
  }
}

interface ModelContextEntry {
  contextLength: number;
  registeredAt: number;
}

const registry = new Map<string, ModelContextEntry>();
const budgetCache = new Map<string, TokenBudgetManager>();

export function registerModelContext(modelKey: string, contextLength: number): void {
  registry.set(modelKey, { contextLength, registeredAt: Date.now() });
  budgetCache.delete(modelKey);
}

export function unregisterModelContext(modelKey: string): void {
  registry.delete(modelKey);
  budgetCache.delete(modelKey);
}

export function getModelContext(modelKey: string): number | null {
  return registry.get(modelKey)?.contextLength ?? null;
}

async function getBudget(modelKey: string): Promise<TokenBudgetManager | null> {
  const ctx = registry.get(modelKey);
  if (!ctx) return null;
  let budget = budgetCache.get(modelKey);
  if (!budget) {
    budget = new TokenBudgetManager({ modelContext: ctx.contextLength });
    await budget.ensureReady();
    budgetCache.set(modelKey, budget);
  }
  return budget;
}

/**
 * Проверка перед отправкой запроса. Если modelKey не зарегистрирован — проверка пропускается
 * (нельзя ни подтвердить, ни опровергнуть). Это безопасный fallback для legacy-кода.
 */
export async function assertFits(
  modelKey: string,
  messages: ChatMessage[],
  maxCompletion: number
): Promise<void> {
  const budget = await getBudget(modelKey);
  if (!budget) return;
  if (budget.fits(messages, maxCompletion)) return;
  const required = budget.estimateMessages(messages) + maxCompletion;
  throw new ContextOverflowError(modelKey, required, budget.budget());
}

/**
 * Trim-fallback: если не помещается, пробует урезать few-shot. Возвращает обновлённые messages
 * (которые точно помещаются) или бросает ContextOverflowError.
 */
export async function fitOrTrim(
  modelKey: string,
  messages: ChatMessage[],
  maxCompletion: number
): Promise<ChatMessage[]> {
  const budget = await getBudget(modelKey);
  if (!budget) return messages;
  if (budget.fits(messages, maxCompletion)) return messages;
  const trimmed = budget.trimFewShot(messages, maxCompletion);
  if (budget.fits(trimmed, maxCompletion)) return trimmed;
  const required = budget.estimateMessages(trimmed) + maxCompletion;
  throw new ContextOverflowError(modelKey, required, budget.budget());
}

export function resetOverflowGuard(): void {
  registry.clear();
  budgetCache.clear();
}
