import {
  ABORT_GRACE_MS,
  POLICY_BASE_BACKOFF_MS,
  POLICY_HARD_TIMEOUT_CAP_MS,
  POLICY_MAX_RETRIES,
  POLICY_MIN_OBSERVED_TPS,
  POLICY_TIMEOUT_BUFFER_MS,
} from "./constants";

export interface RequestPolicyContext {
  expectedTokens: number;
  observedTps: number;
}

export interface RequestPolicy {
  maxRetries: number;
  baseBackoffMs: number;
  perRequestTimeout: (ctx: RequestPolicyContext) => number;
  abortGraceMs: number;
}

export const DEFAULT_POLICY: RequestPolicy = {
  maxRetries: POLICY_MAX_RETRIES,
  baseBackoffMs: POLICY_BASE_BACKOFF_MS,
  perRequestTimeout: ({ expectedTokens, observedTps }) => {
    const tps = Math.max(observedTps, POLICY_MIN_OBSERVED_TPS);
    const dynamic = Math.ceil((expectedTokens / tps) * 1000) + POLICY_TIMEOUT_BUFFER_MS;
    return Math.min(dynamic, POLICY_HARD_TIMEOUT_CAP_MS);
  },
  abortGraceMs: ABORT_GRACE_MS,
};

export interface PolicyContext {
  expectedTokens: number;
  observedTps: number;
}

const ABORT_SENTINEL = "__withPolicy:aborted__";
const TIMEOUT_SENTINEL = "__withPolicy:timeout__";

/**
 * Оборачивает один логический LLM-запрос:
 *  - ставит таймаут (адаптивный или из policy.perRequestTimeout)
 *  - уважает внешний AbortSignal — не ретраит при user-cancel
 *  - на таймаут / транзитную ошибку — ретрай с экспоненциальным backoff
 *  - между abort и retry ждёт abortGraceMs (LM Studio bug #1203)
 */
export async function withPolicy<T>(
  policy: RequestPolicy,
  externalSignal: AbortSignal,
  ctx: PolicyContext,
  attempt: (innerSignal: AbortSignal) => Promise<T>
): Promise<T> {
  let lastError: unknown = null;

  for (let i = 0; i <= policy.maxRetries; i++) {
    if (externalSignal.aborted) {
      throw new Error(ABORT_SENTINEL);
    }

    const timeoutMs = policy.perRequestTimeout(ctx);
    const innerCtl = new AbortController();
    const onExternalAbort = (): void => innerCtl.abort("external");
    externalSignal.addEventListener("abort", onExternalAbort, { once: true });

    let timer: NodeJS.Timeout | null = null;
    let timedOut = false;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        innerCtl.abort("timeout");
        reject(new Error(TIMEOUT_SENTINEL));
      }, timeoutMs);
    });

    try {
      const result = await Promise.race([attempt(innerCtl.signal), timeoutPromise]);
      return result;
    } catch (err) {
      lastError = err;
      if (externalSignal.aborted) throw new Error(ABORT_SENTINEL);
      const message = err instanceof Error ? err.message : String(err);

      const isTimeout = timedOut || message === TIMEOUT_SENTINEL;
      const isAbort = message === ABORT_SENTINEL || /aborted/i.test(message);

      if (isAbort && !isTimeout) {
        throw err;
      }

      if (i === policy.maxRetries) {
        throw err instanceof Error ? err : new Error(String(err));
      }

      // backoff + abortGrace
      const backoff = policy.baseBackoffMs * Math.pow(2, i);
      const wait = backoff + (isTimeout ? policy.abortGraceMs : 0);
      await sleep(wait, externalSignal);
    } finally {
      if (timer) clearTimeout(timer);
      externalSignal.removeEventListener("abort", onExternalAbort);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error(ABORT_SENTINEL));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error(ABORT_SENTINEL));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function isAbortError(err: unknown): boolean {
  if (!err) return false;
  const message = err instanceof Error ? err.message : String(err);
  return message === ABORT_SENTINEL || /aborted/i.test(message);
}
