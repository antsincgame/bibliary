/**
 * Arena cycle — фоновая калибровка ролей через Elo.
 *
 * АЛГОРИТМ:
 *   1. Перед стартом проверяем globalLlmLock.isBusy() — если LM Studio занята
 *      импортом / evaluator queue, cycle скипается (защита от OOM).
 *   2. Для каждой роли из `roles` (default = все поддерживаемые):
 *        a. Берём golden prompt этой роли (getGoldenForRole).
 *        b. Фильтруем loaded models по required capability роли.
 *        c. Если eligible.length < 2 — роль скипается (нечего сравнивать).
 *        d. Парим модели pairwise (round-robin), запускаем golden, считаем
 *           winner через LLM judge или objective fallback (length+latency).
 *        e. Обновляем Elo в roles[<role>] через recordMatch.
 *   3. Если arenaAutoPromoteWinner=true — устанавливаем winner как prefs[<role>Model].
 *
 * РОЛИ ИСКЛЮЧЕНИЯ:
 *   - arena_judge не калибруется самим собой (был бы цикл).
 */

import { chat, chatWithPolicy, listLoaded, type LoadedModelInfo } from "../../../lmstudio-client.js";
import { getPreferencesStore, type Preferences } from "../../preferences/store.js";
import { modelRoleResolver, getRolePrefKey, type ModelRole } from "../model-role-resolver.js";
import { recordMatch, readRatingsFile, recordCycleError, type ArenaRatingsFile } from "./ratings-store.js";
import { getGoldenForRole, type GoldenPrompt } from "./golden-prompts.js";
import { globalLlmLock } from "../global-llm-lock.js";

const MAX_JUDGE_CONTEXT_CHARS = 4_000;
const MODEL_RUN_MAX_TOKENS = 512;
const MODEL_RUN_TOP_K = 20;
const JUDGE_MAX_TOKENS = 8;
const JUDGE_TOP_K = 5;
const OBJECTIVE_MIN_ANSWER_CHARS = 20;
export const ARENA_MATCH_PAIRS_PER_CYCLE_MAX = 10;

/**
 * Какие роли поддерживаются arena (есть golden и есть смысл сравнивать).
 * Vision_ocr использует тот же golden что vision_meta — для unique cycle
 * включаем только vision_meta, vision_ocr резолвится через тот же Elo bucket.
 */
const CALIBRATABLE_ROLES: ModelRole[] = [
  "chat",
  "agent",
  "judge",
  "crystallizer",
  "evaluator",
  "vision_meta",
];

interface RunCycleDeps {
  chat: typeof chat;
  chatWithPolicy: typeof chatWithPolicy;
  listLoaded: typeof listLoaded;
  getPrefs: () => Promise<Preferences>;
  setPrefs: (partial: Partial<Preferences>) => Promise<Preferences>;
  resolveRole: typeof modelRoleResolver.resolve;
  invalidateRole: typeof modelRoleResolver.invalidate;
  recordMatch: typeof recordMatch;
  readRatingsFile: typeof readRatingsFile;
  recordCycleError: typeof recordCycleError;
  getGoldenForRole: typeof getGoldenForRole;
  getLockStatus: typeof globalLlmLock.isBusy;
  recordLockSkip: typeof globalLlmLock.recordSkip;
}

const defaultDeps: RunCycleDeps = {
  chat,
  chatWithPolicy,
  listLoaded,
  getPrefs: async () => getPreferencesStore().getAll(),
  setPrefs: async (partial) => getPreferencesStore().set(partial),
  resolveRole: (role) => modelRoleResolver.resolve(role),
  invalidateRole: (role) => modelRoleResolver.invalidate(role),
  recordMatch,
  readRatingsFile,
  recordCycleError,
  getGoldenForRole,
  getLockStatus: () => globalLlmLock.isBusy(),
  recordLockSkip: (reasons) => globalLlmLock.recordSkip(reasons),
};

let deps: RunCycleDeps = defaultDeps;

export function _setRunCycleDepsForTests(overrides: Partial<RunCycleDeps>): void {
  deps = { ...defaultDeps, ...overrides };
}

export function _resetRunCycleDepsForTests(): void {
  deps = defaultDeps;
}


export interface CycleOptions {
  /** Подмножество ролей для калибровки. Default = все CALIBRATABLE_ROLES. */
  roles?: ModelRole[];
  /** Сигнал отмены (например при app-quit). */
  signal?: AbortSignal;
  /** Если true — обходит globalLlmLock guard. Default false. Используется
   *  только когда юзер явно нажимает "Run cycle now" в UI и подтверждает. */
  bypassLock?: boolean;
  /** Manual user-triggered cycle runs even when background arena is disabled. */
  manual?: boolean;
}

export interface CycleRoleResult {
  role: ModelRole;
  matches: number;
  results: string[];
  ratings: Record<string, number>;
  skipped?: string;
}

export interface CycleReport {
  ok: boolean;
  message: string;
  /** True если cycle был пропущен из-за lock. */
  skipped?: boolean;
  /** Почему скипнули (e.g. "library-import: 3 active import(s)"). */
  skipReasons?: string[];
  perRole?: CycleRoleResult[];
}

function parseWinnerLetter(content: string): "A" | "B" | null {
  const t = content.trim().toUpperCase();
  if (t.startsWith("A")) return "A";
  if (t.startsWith("B")) return "B";
  if (t.includes("ANSWER: A") || t.includes("BETTER: A")) return "A";
  if (t.includes("ANSWER: B") || t.includes("BETTER: B")) return "B";
  return null;
}

function filterByRoleCaps(role: ModelRole, models: LoadedModelInfo[]): LoadedModelInfo[] {
  if (role === "vision_meta" || role === "vision_ocr") {
    return models.filter((m) => m.vision === true);
  }
  return models;
}

async function runOneModel(
  modelKey: string,
  g: GoldenPrompt,
  signal: AbortSignal,
): Promise<{ text: string; ms: number }> {
  const t0 = Date.now();
  const userContent: string | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> =
    g.imageUrl
      ? [
          { type: "text", text: g.user },
          { type: "image_url", image_url: { url: g.imageUrl } },
        ]
      : g.user;
  const r = await deps.chat({
    model: modelKey,
    messages: [
      { role: "system", content: g.system },
      /* chat() expects content: string. Vision models require richer payload —
         в нашем lmstudio-client.ts vision-meta выполняется через REST endpoint
         напрямую, не через chat(). Для arena vision-cycle мы можем отправить
         текстовое описание prompt без image и считать это базовым sanity-check.
         Полноценный vision-cycle будет в Фазе 7. */
      { role: "user", content: typeof userContent === "string" ? userContent : g.user },
    ],
    sampling: { temperature: 0.3, top_p: 0.9, max_tokens: MODEL_RUN_MAX_TOKENS, top_k: MODEL_RUN_TOP_K, min_p: 0, presence_penalty: 0 },
    signal,
  });
  return { text: r.content, ms: Date.now() - t0 };
}

async function decideWinner(
  prefs: Preferences,
  g: GoldenPrompt,
  a: string,
  b: string,
  ra: { text: string; ms: number },
  rb: { text: string; ms: number },
  signal: AbortSignal,
): Promise<"A" | "B"> {
  if (prefs.arenaUseLlmJudge) {
    const judge = await deps.resolveRole("arena_judge");
    if (judge) {
      try {
        const prompt =
          `Question: ${g.user}\n` +
          `Assistant A (model ${a}):\n${ra.text.slice(0, MAX_JUDGE_CONTEXT_CHARS)}\n\n` +
          `Assistant B (model ${b}):\n${rb.text.slice(0, MAX_JUDGE_CONTEXT_CHARS)}\n\n` +
          `Which answer is more accurate and helpful? Reply with exactly one character: A or B.`;
        const jresp = await deps.chatWithPolicy(
          {
            model: judge.modelKey,
            messages: [
              { role: "system", content: "You are a fair evaluator. Output only A or B." },
              { role: "user", content: prompt },
            ],
            sampling: { temperature: 0, top_p: 0.5, max_tokens: JUDGE_MAX_TOKENS, top_k: JUDGE_TOP_K, min_p: 0, presence_penalty: 0 },
          },
          { externalSignal: signal },
        );
        const w = parseWinnerLetter(jresp.content);
        if (w) return w;
      } catch {
        /* fallthrough to objective */
      }
    }
  }
  /* Objective fallback: оба ответа достаточно длинные → быстрее побеждает.
     Один пустой → побеждает другой. Оба пустые → быстрее. */
  const la = ra.text.replace(/\s+/g, " ").length;
  const lb = rb.text.replace(/\s+/g, " ").length;
  const okA = la > OBJECTIVE_MIN_ANSWER_CHARS;
  const okB = lb > OBJECTIVE_MIN_ANSWER_CHARS;
  if (okA && okB) return ra.ms <= rb.ms ? "A" : "B";
  if (okA) return "A";
  if (okB) return "B";
  return ra.ms <= rb.ms ? "A" : "B";
}

async function runCycleForRole(
  role: ModelRole,
  prefs: Preferences,
  loaded: LoadedModelInfo[],
  signal: AbortSignal,
): Promise<CycleRoleResult> {
  const golden = deps.getGoldenForRole(role);
  if (!golden) {
    return { role, matches: 0, results: [], ratings: {}, skipped: "no golden prompt" };
  }

  const eligible = filterByRoleCaps(role, loaded);
  if (eligible.length < 2) {
    return {
      role,
      matches: 0,
      results: [],
      ratings: {},
      skipped: `need at least 2 eligible models for role "${role}" (have ${eligible.length})`,
    };
  }

  const pairs = Math.min(prefs.arenaMatchPairsPerCycle, ARENA_MATCH_PAIRS_PER_CYCLE_MAX);
  const keys = eligible.map((m) => m.modelKey);
  const results: string[] = [];

  for (let p = 0; p < pairs; p++) {
    if (signal.aborted) break;
    const i = (p * 2) % keys.length;
    const j = (p * 2 + 1) % keys.length;
    const a = keys[i]!;
    const b = keys[j]!;
    if (a === b) continue;

    let ra: { text: string; ms: number };
    let rb: { text: string; ms: number };
    try {
      ra = await runOneModel(a, golden, signal);
      rb = await runOneModel(b, golden, signal);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      results.push(`pair ${a} vs ${b}: failed (${msg})`);
      continue;
    }

    const winner = await decideWinner(prefs, golden, a, b, ra, rb, signal);
    const winKey = winner === "A" ? a : b;
    const loseKey = winner === "A" ? b : a;
    await deps.recordMatch(role, winKey, loseKey);
    results.push(`${winKey} beat ${loseKey} (${winner})`);
  }

  const ratings = await deps.readRatingsFile();
  const roleRatings = ratings.roles[role] ?? {};

  /* Auto-promote: ОДНОКРАТНО после всех матчей, по топ-Elo среди участников
     текущего cycle. Старая логика записывала prefs[<role>Model] после КАЖДОГО
     матча — на промежуточных раундах в prefs могла оказаться слабая модель.
     Сейчас выбираем итогового лидера по агрегированному Elo. */
  if (prefs.arenaAutoPromoteWinner && results.length > 0) {
    let topKey: string | null = null;
    let topElo = -Infinity;
    for (const k of keys) {
      const e = roleRatings[k];
      if (typeof e === "number" && e > topElo) {
        topElo = e;
        topKey = k;
      }
    }
    if (topKey) {
      const prefKey = getRolePrefKey(role);
      const cur = (prefs as Record<string, unknown>)[prefKey];
      if (cur !== topKey) {
        await deps.setPrefs({ [prefKey]: topKey } as Partial<Preferences>);
        deps.invalidateRole(role);
        results.push(`auto-promoted ${topKey} (Elo ${Math.round(topElo)})`);
      }
    }
  }

  return {
    role,
    matches: results.length,
    results,
    ratings: roleRatings,
  };
}

/**
 * Главная точка входа: запустить arena cycle для одной или всех ролей.
 */
export async function runArenaCycle(opts: CycleOptions = {}): Promise<CycleReport> {
  try {
    return await runArenaCycleInner(opts);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    void deps.recordCycleError(msg);
    return { ok: false, message: `cycle threw: ${msg}` };
  }
}

async function runArenaCycleInner(opts: CycleOptions): Promise<CycleReport> {
  const prefs = await deps.getPrefs();
  if (!prefs.arenaEnabled && !opts.manual) {
    return { ok: true, message: "arena disabled" };
  }

  /* GUARD: проверяем GlobalLlmLock — если LM Studio занят (импорт/evaluator),
     скипаем cycle. Это критично для предотвращения OOM (см. global-llm-lock.ts). */
  if (!opts.bypassLock) {
    const lock = deps.getLockStatus();
    if (lock.busy) {
      deps.recordLockSkip(lock.reasons);
      return {
        ok: false,
        message: `cycle skipped — LM Studio busy: ${lock.reasons.join(", ")}`,
        skipped: true,
        skipReasons: lock.reasons,
      };
    }
  }

  const loaded = await deps.listLoaded();
  if (loaded.length < 2) {
    return { ok: false, message: "need at least 2 loaded LLM models" };
  }

  const targetRoles = opts.roles && opts.roles.length > 0
    ? opts.roles.filter((r) => CALIBRATABLE_ROLES.includes(r))
    : CALIBRATABLE_ROLES;

  if (targetRoles.length === 0) {
    return { ok: false, message: "no calibratable roles in opts.roles" };
  }

  const signal = opts.signal ?? new AbortController().signal;
  const perRole: CycleRoleResult[] = [];
  let totalMatches = 0;

  for (const role of targetRoles) {
    if (signal.aborted) break;
    const r = await runCycleForRole(role, prefs, loaded, signal);
    perRole.push(r);
    totalMatches += r.matches;
  }

  return {
    ok: true,
    message: `completed ${totalMatches} match(es) across ${perRole.length} role(s)`,
    perRole,
  };
}

/**
 * Backward-compat: старый вызов getChatRatings(arenaFile.roles).
 * В UI Pro mode мы используем readRatingsFile().roles целиком.
 */
export function getChatRatings(roles: ArenaRatingsFile["roles"]): Record<string, number> {
  return roles["chat"] ?? {};
}
