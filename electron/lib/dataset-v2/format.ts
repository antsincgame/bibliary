/**
 * Dataset format converters — ShareGPT ↔ ChatML + reproducible train/val/eval split.
 *
 * Адаптировано из Forge format.ts (только полезные для облачного fine-tuning части —
 * без self-hosted кодогенерации).
 *
 * ShareGPT (Together AI, HuggingFace):
 *   { "conversations": [{ "from": "system|human|gpt", "value": "..." }, ...], "meta": {...} }
 *
 * ChatML (OpenAI, Fireworks, Mistral):
 *   { "messages": [{ "role": "system|user|assistant", "content": "..." }, ...] }
 */

import { z } from "zod";

export const ShareGPTTurnSchema = z.object({
  from: z.string().min(1),
  value: z.string().min(0),
});

export const ShareGPTLineSchema = z.object({
  conversations: z.array(ShareGPTTurnSchema).min(1),
  meta: z.unknown().optional(),
});

export const ChatMLMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.string(),
});

export const ChatMLLineSchema = z.object({
  messages: z.array(ChatMLMessageSchema).min(1),
  meta: z.unknown().optional(),
});

export type ShareGPTLine = z.infer<typeof ShareGPTLineSchema>;
export type ChatMLLine = z.infer<typeof ChatMLLineSchema>;
export type DatasetFormat = "sharegpt" | "chatml";

const SHAREGPT_TO_CHATML: Record<string, "system" | "user" | "assistant" | "tool"> = {
  system: "system",
  human: "user",
  user: "user",
  gpt: "assistant",
  assistant: "assistant",
  tool: "tool",
  function: "tool",
};

const CHATML_TO_SHAREGPT: Record<string, string> = {
  system: "system",
  user: "human",
  assistant: "gpt",
  tool: "tool",
};

export function shareGptToChatML(line: ShareGPTLine): ChatMLLine {
  const messages = line.conversations.map((turn) => ({
    role: SHAREGPT_TO_CHATML[turn.from.toLowerCase()] ?? ("user" as const),
    content: turn.value,
  }));
  return line.meta !== undefined ? { messages, meta: line.meta } : { messages };
}

export function chatMLToShareGPT(line: ChatMLLine): ShareGPTLine {
  const conversations = line.messages.map((msg) => ({
    from: CHATML_TO_SHAREGPT[msg.role] ?? msg.role,
    value: msg.content,
  }));
  return line.meta !== undefined ? { conversations, meta: line.meta } : { conversations };
}

export function shareGptLinesToJsonl(lines: ShareGPTLine[]): string {
  return lines.map((l) => JSON.stringify(l)).join("\n") + (lines.length > 0 ? "\n" : "");
}

export function chatMLLinesToJsonl(lines: ChatMLLine[]): string {
  return lines.map((l) => JSON.stringify(l)).join("\n") + (lines.length > 0 ? "\n" : "");
}

export interface SplitOptions {
  /** Доля train (0.05..0.99). Default 0.9. */
  trainRatio?: number;
  /** Доля eval из total (0..0.5). Если задан — eval отщепляется первым, остаток train+val. */
  evalRatio?: number;
  /** Seed для воспроизводимости. Default 42. */
  seed?: number;
}

export interface SplitResult<T> {
  train: T[];
  val: T[];
  eval: T[];
}

/**
 * Детерминированный train/val/eval split с seed-based shuffle (Mulberry32 PRNG).
 * Воспроизводимость критична для повторных run-ов fine-tune.
 */
export function splitLines<T>(lines: T[], opts: SplitOptions = {}): SplitResult<T> {
  const trainRatio = clamp(opts.trainRatio ?? 0.9, 0.05, 0.99);
  const evalRatio = clamp(opts.evalRatio ?? 0, 0, 0.5);

  const shuffled = seededShuffle(lines, opts.seed ?? 42);
  const total = shuffled.length;
  const evalCount = Math.floor(total * evalRatio);
  const remainder = total - evalCount;
  const trainCount = Math.floor(remainder * trainRatio);

  return {
    train: shuffled.slice(0, trainCount),
    val: shuffled.slice(trainCount, remainder),
    eval: shuffled.slice(remainder),
  };
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

/** Mulberry32 PRNG — воспроизводимый shuffle. */
function seededShuffle<T>(arr: T[], seed: number): T[] {
  const out = [...arr];
  let s = seed >>> 0;
  const rng = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}
