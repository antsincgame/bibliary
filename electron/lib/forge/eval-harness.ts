/**
 * Eval Harness — A/B сравнение base vs fine-tuned модели на eval-set.
 *
 * Метрики:
 *  - rouge-l (precision/recall/F1) — leksical overlap
 *  - LLM-as-judge — спрашиваем уже-загруженную BIG модель оценить пары
 *
 * Чистая логика, без UI. Принимает запросы и колбэк chat (для абстракции LM Studio).
 */

import type { ChatMLLine } from "./format";

export interface EvalChatFn {
  (modelKey: string, messages: Array<{ role: string; content: string }>): Promise<string>;
}

export interface EvalCase {
  prompt: string;
  expected: string;
  /** Опционально — system prompt поверх dataset baseline. */
  systemPrompt?: string;
}

export interface EvalResult {
  prompt: string;
  expected: string;
  baseAnswer: string;
  tunedAnswer: string;
  rougeBase: RougeScore;
  rougeTuned: RougeScore;
  judgeBase?: number;
  judgeTuned?: number;
  judgeWinner?: "base" | "tuned" | "tie";
}

export interface EvalSummary {
  cases: EvalResult[];
  meanRougeBase: number;
  meanRougeTuned: number;
  delta: number;
  judgeWins: { base: number; tuned: number; tie: number };
}

// ─────────────────────────────────────────────────────────────────────────────
// ROUGE-L (longest common subsequence)
// ─────────────────────────────────────────────────────────────────────────────

export interface RougeScore {
  precision: number;
  recall: number;
  f1: number;
}

export function rougeL(reference: string, hypothesis: string): RougeScore {
  const refTokens = tokenize(reference);
  const hypTokens = tokenize(hypothesis);
  if (refTokens.length === 0 || hypTokens.length === 0) {
    return { precision: 0, recall: 0, f1: 0 };
  }
  const lcs = lcsLen(refTokens, hypTokens);
  const precision = lcs / hypTokens.length;
  const recall = lcs / refTokens.length;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  return { precision: round3(precision), recall: round3(recall), f1: round3(f1) };
}

function tokenize(text: string): string[] {
  return text.toLowerCase().split(/\s+/).filter(Boolean);
}

function lcsLen(a: string[], b: string[]): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i]![j] = a[i - 1] === b[j - 1] ? dp[i - 1]![j - 1]! + 1 : Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
    }
  }
  return dp[m]![n]!;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

// ─────────────────────────────────────────────────────────────────────────────
// LLM-as-judge — простой 0/1/2 score
// ─────────────────────────────────────────────────────────────────────────────

const JUDGE_SYSTEM = `You are an impartial judge. You will compare two answers (A, B) to the same question against a reference answer.
Score each answer from 0 to 2:
- 2 = matches reference in meaning and quality
- 1 = partially correct or partially complete
- 0 = wrong or off-topic
Output STRICTLY in JSON: {"a": <0|1|2>, "b": <0|1|2>, "winner": "a"|"b"|"tie"}.
No explanations, no extra text.`;

export async function judgeOne(opts: {
  judgeChat: EvalChatFn;
  judgeModel: string;
  question: string;
  reference: string;
  answerA: string;
  answerB: string;
}): Promise<{ a: number; b: number; winner: "base" | "tuned" | "tie" }> {
  const userMsg = `Question: ${opts.question}\n\nReference: ${opts.reference}\n\nAnswer A: ${opts.answerA}\n\nAnswer B: ${opts.answerB}`;
  const raw = await opts.judgeChat(opts.judgeModel, [
    { role: "system", content: JUDGE_SYSTEM },
    { role: "user", content: userMsg },
  ]);
  const m = raw.match(/\{[^}]*"a"\s*:\s*(\d)[^}]*"b"\s*:\s*(\d)[^}]*"winner"\s*:\s*"(\w+)"/);
  if (!m) {
    return { a: 0, b: 0, winner: "tie" };
  }
  const a = Math.max(0, Math.min(2, Number(m[1])));
  const b = Math.max(0, Math.min(2, Number(m[2])));
  const winnerRaw = m[3];
  const winner: "base" | "tuned" | "tie" = winnerRaw === "a" ? "base" : winnerRaw === "b" ? "tuned" : "tie";
  return { a, b, winner };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main runner
// ─────────────────────────────────────────────────────────────────────────────

export async function runEval(opts: {
  cases: EvalCase[];
  baseModel: string;
  tunedModel: string;
  judgeModel?: string;
  chat: EvalChatFn;
  /** Опциональный progress callback. */
  onProgress?: (done: number, total: number) => void;
  /**
   * Если signal.aborted — выходим между case'ами без следующего chat-call.
   * IPC-handler передаёт сюда controller, чтобы forge:cancel-eval мог
   * прервать длительный прогон без зависания UI.
   */
  signal?: AbortSignal;
  /**
   * Логирование сбоя judge-вызова. Сам judge остаётся optional (не падаем),
   * но caller получает шанс залогировать в telemetry — раньше ошибки
   * молча терялись (audit MED).
   */
  onJudgeError?: (caseIndex: number, error: string) => void;
}): Promise<EvalSummary> {
  const results: EvalResult[] = [];
  let i = 0;
  for (const ec of opts.cases) {
    if (opts.signal?.aborted) {
      throw new Error("aborted: eval cancelled between cases");
    }
    i++;
    const messages: Array<{ role: string; content: string }> = [];
    if (ec.systemPrompt) messages.push({ role: "system", content: ec.systemPrompt });
    messages.push({ role: "user", content: ec.prompt });

    const baseAnswer = await opts.chat(opts.baseModel, messages);
    const tunedAnswer = await opts.chat(opts.tunedModel, messages);
    const rougeBase = rougeL(ec.expected, baseAnswer);
    const rougeTuned = rougeL(ec.expected, tunedAnswer);

    let judgeBase: number | undefined;
    let judgeTuned: number | undefined;
    let judgeWinner: "base" | "tuned" | "tie" | undefined;
    if (opts.judgeModel) {
      try {
        const j = await judgeOne({
          judgeChat: opts.chat,
          judgeModel: opts.judgeModel,
          question: ec.prompt,
          reference: ec.expected,
          answerA: baseAnswer,
          answerB: tunedAnswer,
        });
        judgeBase = j.a;
        judgeTuned = j.b;
        judgeWinner = j.winner;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`[forge.eval] judge failed for case ${i}/${opts.cases.length}: ${msg}`);
        opts.onJudgeError?.(i, msg);
      }
    }

    results.push({
      prompt: ec.prompt,
      expected: ec.expected,
      baseAnswer,
      tunedAnswer,
      rougeBase,
      rougeTuned,
      judgeBase,
      judgeTuned,
      judgeWinner,
    });
    opts.onProgress?.(i, opts.cases.length);
  }

  const meanRougeBase = round3(results.reduce((s, r) => s + r.rougeBase.f1, 0) / Math.max(1, results.length));
  const meanRougeTuned = round3(results.reduce((s, r) => s + r.rougeTuned.f1, 0) / Math.max(1, results.length));
  const judgeWins = results.reduce(
    (acc, r) => {
      if (r.judgeWinner === "base") acc.base++;
      else if (r.judgeWinner === "tuned") acc.tuned++;
      else if (r.judgeWinner === "tie") acc.tie++;
      return acc;
    },
    { base: 0, tuned: 0, tie: 0 }
  );

  return {
    cases: results,
    meanRougeBase,
    meanRougeTuned,
    delta: round3(meanRougeTuned - meanRougeBase),
    judgeWins,
  };
}

/**
 * Извлекает eval-cases из ChatML lines: берёт system + user как prompt, последний
 * assistant как expected.
 */
export function chatMLToEvalCases(lines: ChatMLLine[], maxCases = 50): EvalCase[] {
  const out: EvalCase[] = [];
  for (const line of lines) {
    if (out.length >= maxCases) break;
    const sys = line.messages.find((m) => m.role === "system");
    const user = line.messages.find((m) => m.role === "user");
    const assistant = line.messages.find((m) => m.role === "assistant");
    if (!user || !assistant) continue;
    out.push({
      prompt: user.content,
      expected: assistant.content,
      systemPrompt: sys?.content,
    });
  }
  return out;
}
