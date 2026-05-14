/**
 * TokenBudgetManager — токенизация и budget-проверка перед LM Studio chat.
 *
 * Использует токенизатор `multilingual-e5-small` (тот же что для embeddings) — точность ±5%
 * против реального tokenizer LM Studio модели. Этого достаточно для headroom-расчёта
 * (мы держим 8% запаса по умолчанию).
 *
 * Trim-стратегия:
 *  1. Trim few-shot 5 → 3 → 1 → 0 пока не помещается.
 *  2. Если всё ещё не помещается — split user-chunk пополам с overlap.
 *  3. Если даже минимальный chunk + system не помещается — ChunkTooLargeError.
 */
import type { PreTrainedTokenizer } from "@xenova/transformers";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface TokenBudgetOptions {
  modelContext: number;
  safetyMargin?: number;
  maxCompletion?: number;
}

const DEFAULT_SAFETY_MARGIN = 0.08;
const DEFAULT_MAX_COMPLETION = 2048;
const TOKENIZER_MODEL = "Xenova/multilingual-e5-small";
const MIN_CHUNK_TOKENS = 64;

export class ChunkTooLargeError extends Error {
  readonly tokens: number;
  readonly limit: number;
  constructor(tokens: number, limit: number) {
    super(`chunk does not fit even minimal: tokens=${tokens} limit=${limit}`);
    this.name = "ChunkTooLargeError";
    this.tokens = tokens;
    this.limit = limit;
  }
}

let tokenizerCache: Promise<PreTrainedTokenizer> | null = null;

async function getTokenizer(): Promise<PreTrainedTokenizer> {
  if (!tokenizerCache) {
    const { AutoTokenizer } = await import("@xenova/transformers");
    tokenizerCache = AutoTokenizer.from_pretrained(TOKENIZER_MODEL);
  }
  return tokenizerCache;
}

export class TokenBudgetManager {
  private readonly modelContext: number;
  private readonly safetyMargin: number;
  private readonly maxCompletionDefault: number;
  private tokenizer: PreTrainedTokenizer | null = null;

  constructor(opts: TokenBudgetOptions) {
    this.modelContext = opts.modelContext;
    this.safetyMargin = opts.safetyMargin ?? DEFAULT_SAFETY_MARGIN;
    this.maxCompletionDefault = opts.maxCompletion ?? DEFAULT_MAX_COMPLETION;
  }

  async ensureReady(): Promise<void> {
    if (!this.tokenizer) this.tokenizer = await getTokenizer();
  }

  estimate(text: string): number {
    if (!this.tokenizer) {
      throw new Error("TokenBudgetManager.estimate: call ensureReady() first");
    }
    const encoded = this.tokenizer.encode(text);
    return encoded.length;
  }

  estimateMessages(messages: ChatMessage[]): number {
    let total = 0;
    for (const m of messages) {
      total += this.estimate(m.content) + 4;
    }
    return total + 2;
  }

  budget(): number {
    return Math.floor(this.modelContext * (1 - this.safetyMargin));
  }

  fits(messages: ChatMessage[], maxCompletion?: number): boolean {
    const completion = maxCompletion ?? this.maxCompletionDefault;
    return this.estimateMessages(messages) + completion <= this.budget();
  }

  /**
   * Trim few-shot блок (помеченный паттерном FEW_SHOT_MARKER) пока не помещается.
   * Возвращает уменьшенный список сообщений (system + user[trimmed]).
   * Не трогает system или последнее user-сообщение целиком.
   */
  trimFewShot(messages: ChatMessage[], maxCompletion?: number): ChatMessage[] {
    const completion = maxCompletion ?? this.maxCompletionDefault;
    if (this.fits(messages, completion)) return messages;

    const out = messages.map((m) => ({ ...m }));
    const lastUser = out.length - 1;
    if (lastUser < 0 || out[lastUser].role !== "user") return out;

    while (!this.fitsList(out, completion)) {
      const userText = out[lastUser].content;
      const trimmed = trimFewShotSection(userText);
      if (trimmed === userText) break;
      out[lastUser].content = trimmed;
    }
    return out;
  }

  private fitsList(messages: ChatMessage[], completion: number): boolean {
    return this.estimateMessages(messages) + completion <= this.budget();
  }

  /**
   * Split text по токенам пополам с overlap (overlap в токенах).
   * Возвращает массив строк. Гарантия: каждый кусок ≤ maxTokens.
   * Если даже минимальный фрагмент > maxTokens — выбрасывает ChunkTooLargeError.
   */
  splitByTokens(text: string, maxTokens: number, overlap: number): string[] {
    if (maxTokens < MIN_CHUNK_TOKENS) {
      throw new ChunkTooLargeError(maxTokens, MIN_CHUNK_TOKENS);
    }
    if (!this.tokenizer) {
      throw new Error("splitByTokens: call ensureReady() first");
    }
    const tokens = this.tokenizer.encode(text);
    if (tokens.length <= maxTokens) return [text];

    const stride = Math.max(1, maxTokens - overlap);
    const out: string[] = [];
    for (let start = 0; start < tokens.length; start += stride) {
      const end = Math.min(tokens.length, start + maxTokens);
      const slice = tokens.slice(start, end);
      const piece = this.tokenizer.decode(slice, { skip_special_tokens: true });
      if (piece.trim().length > 0) out.push(piece);
      if (end >= tokens.length) break;
    }
    if (out.length === 0) {
      throw new ChunkTooLargeError(tokens.length, maxTokens);
    }
    return out;
  }
}

const FEW_SHOT_MARKER = "FEW-SHOT EXAMPLES:";

function trimFewShotSection(userText: string): string {
  const idx = userText.indexOf(FEW_SHOT_MARKER);
  if (idx < 0) return userText;

  const before = userText.slice(0, idx);
  const after = userText.slice(idx);
  const exampleSplit = after.split(/(?=^EXAMPLE\s+\d+:)/m).filter((s) => s.trim().length > 0);
  if (exampleSplit.length <= 1) {
    return before.trimEnd();
  }
  // отбрасываем последний example
  exampleSplit.pop();
  return before + exampleSplit.join("");
}

export function resetTokenizerCache(): void {
  tokenizerCache = null;
}
