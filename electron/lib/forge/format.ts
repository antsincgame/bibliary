/**
 * Forge format converters — ShareGPT (Bibliary native) ↔ ChatML (2026 standard).
 *
 * Bibliary датасет — ShareGPT JSONL:
 *   { "conversations": [{ "from": "system|human|gpt", "value": "..." }, ...], "meta": {...} }
 *
 * 2026 fine-tuning стандарт — ChatML:
 *   { "messages": [{ "role": "system|user|assistant", "content": "..." }, ...] }
 *
 * Совместимы axolotl, unsloth, AutoTrain, llama-factory, TRL.
 */

import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// Converters
// ─────────────────────────────────────────────────────────────────────────────

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
  const messages = line.conversations.map((turn) => {
    const role = SHAREGPT_TO_CHATML[turn.from.toLowerCase()] ?? "user";
    return { role, content: turn.value };
  });
  return line.meta !== undefined ? { messages, meta: line.meta } : { messages };
}

export function chatMLToShareGPT(line: ChatMLLine): ShareGPTLine {
  const conversations = line.messages.map((msg) => ({
    from: CHATML_TO_SHAREGPT[msg.role] ?? msg.role,
    value: msg.content,
  }));
  return line.meta !== undefined ? { conversations, meta: line.meta } : { conversations };
}

// ─────────────────────────────────────────────────────────────────────────────
// Detect & parse
// ─────────────────────────────────────────────────────────────────────────────

export type DatasetFormat = "sharegpt" | "chatml" | "unknown";

export function detectFormat(line: unknown): DatasetFormat {
  if (typeof line !== "object" || line === null) return "unknown";
  const obj = line as Record<string, unknown>;
  if (Array.isArray(obj.conversations)) return "sharegpt";
  if (Array.isArray(obj.messages)) return "chatml";
  return "unknown";
}

/**
 * Парсит JSONL и нормализует в ChatML. Возвращает массив + сводку ошибок.
 * Не падает на одну битую строку — собирает их в `errors`.
 */
export function parseAsChatML(jsonl: string): { lines: ChatMLLine[]; errors: Array<{ line: number; reason: string }> } {
  const lines: ChatMLLine[] = [];
  const errors: Array<{ line: number; reason: string }> = [];
  const raw = jsonl.split(/\r?\n/);
  for (let i = 0; i < raw.length; i++) {
    const text = raw[i].trim();
    if (!text) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      errors.push({ line: i + 1, reason: e instanceof Error ? e.message : "parse error" });
      continue;
    }
    const fmt = detectFormat(parsed);
    if (fmt === "sharegpt") {
      try {
        const sg = ShareGPTLineSchema.parse(parsed);
        lines.push(shareGptToChatML(sg));
      } catch (e) {
        errors.push({ line: i + 1, reason: `invalid sharegpt: ${e instanceof Error ? e.message : e}` });
      }
    } else if (fmt === "chatml") {
      try {
        lines.push(ChatMLLineSchema.parse(parsed));
      } catch (e) {
        errors.push({ line: i + 1, reason: `invalid chatml: ${e instanceof Error ? e.message : e}` });
      }
    } else {
      errors.push({ line: i + 1, reason: "unknown format (no conversations or messages)" });
    }
  }
  return { lines, errors };
}

export function chatMLLinesToJsonl(lines: ChatMLLine[]): string {
  return lines.map((l) => JSON.stringify(l)).join("\n") + (lines.length > 0 ? "\n" : "");
}

// ─────────────────────────────────────────────────────────────────────────────
// Train / val / eval split
// ─────────────────────────────────────────────────────────────────────────────

export interface SplitOptions {
  /** Доля train (0-1). Default 0.9. */
  trainRatio?: number;
  /** Доля eval из total (0-1). Если задан — сначала отщепляется eval, остаток train+val. */
  evalRatio?: number;
  /** Seed для воспроизводимости. */
  seed?: number;
}

export interface SplitResult<T> {
  train: T[];
  val: T[];
  eval: T[];
}

/**
 * Атомарный train/val/eval split. Без shuffle с seed split всегда стабилен —
 * воспроизводимость важна для повторных запусков fine-tune.
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

/** Mulberry32 — воспроизводимый PRNG. */
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
