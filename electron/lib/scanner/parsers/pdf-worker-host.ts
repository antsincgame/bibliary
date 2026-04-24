/**
 * Main-thread обёртка PDF worker'а. Создаёт worker per call (без пула),
 * шлёт filePath, ждёт результат, обрабатывает abort/timeout/crash.
 *
 * Контракт:
 *   - `isWorkerPdfEnabled()` — true если ENV `BIBLIARY_PARSE_WORKERS=1`.
 *   - `parsePdfInWorker(filePath, opts)` — возвращает ParseResult или
 *     отбрасывает Error("worker not available", "aborted", "timeout",
 *     "worker crashed", или fwd parse-ошибку).
 *   - Per-call worker гарантирует, что crash/OOM не влияет на следующую
 *     книгу — каждая получает свежий thread.
 *   - AbortSignal abort'ится → `worker.terminate()` (true SIGKILL для thread).
 *
 * Worker entry — `pdf-worker.js` лежит рядом, разрешается через __dirname.
 * После tsc оба файла — в `dist-electron/lib/scanner/parsers/`.
 *
 * В dev-режиме (tsx loader) worker не запустится — это ожидаемо, dispatcher
 * в `pdf.ts` сделает fallback на main thread без потери функциональности.
 */

import { Worker } from "node:worker_threads";
import * as path from "node:path";
import { existsSync } from "node:fs";
import type { ParseOptions, ParseResult } from "./types.js";

/** ENV-флаг: «1» включает worker_threads для PDF. По умолчанию OFF (R4). */
export function isWorkerPdfEnabled(): boolean {
  return process.env.BIBLIARY_PARSE_WORKERS === "1";
}

/**
 * Таймаут парсинга в worker'е. По умолчанию 8 мин — тот же per-file, что
 * в `import.ts`, но здесь это второй уровень защиты: даже если внешний
 * AbortController не сработал (signal потеряли где-то по пути), worker
 * всё равно убьётся через terminate.
 */
const DEFAULT_WORKER_TIMEOUT_MS = 8 * 60 * 1000;

function resolveWorkerTimeoutMs(): number {
  const raw = process.env.BIBLIARY_PDF_WORKER_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_WORKER_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_WORKER_TIMEOUT_MS;
}

interface WorkerMessage {
  ok: boolean;
  result?: ParseResult;
  error?: string;
}

/**
 * Запускает worker, шлёт parse-задачу, ждёт результат. Не используется
 * пул — один call = один свежий thread (изоляция OOM/crash > overhead).
 */
export async function parsePdfInWorker(
  filePath: string,
  opts: ParseOptions = {},
): Promise<ParseResult> {
  /* AbortSignal pre-check ПЕРЕД любой инициализацией — caller отмена должна
     отвечать мгновенно, а не после resolveWorkerEntry. */
  if (opts.signal?.aborted) {
    throw new Error("aborted");
  }

  const workerPath = resolveWorkerEntry();
  if (!workerPath) {
    throw new Error("worker not available (pdf-worker.js not found in dist)");
  }

  const timeoutMs = resolveWorkerTimeoutMs();

  return new Promise<ParseResult>((resolve, reject) => {

    /* opts передаём без AbortSignal (он не сериализуется через postMessage). */
    const safeOpts = {
      ocrEnabled: opts.ocrEnabled,
      ocrLanguages: opts.ocrLanguages,
      ocrAccuracy: opts.ocrAccuracy,
      ocrPdfDpi: opts.ocrPdfDpi,
    };

    const worker = new Worker(workerPath, {
      workerData: { filePath, opts: safeOpts },
    });

    let settled = false;
    const settle = (action: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      action();
    };

    /* Кросс-cleanup: убрать listener'ы AbortSignal, остановить таймер,
       terminate worker (если ещё не помер). Безопасно для повторного вызова. */
    const onAbort = (): void => settle(() => {
      worker.terminate().catch(() => undefined);
      reject(new Error("aborted"));
    });

    const timer = setTimeout(() => {
      settle(() => {
        worker.terminate().catch(() => undefined);
        reject(new Error(`worker timeout after ${Math.round(timeoutMs / 1000)}s`));
      });
    }, timeoutMs);

    const cleanup = (): void => {
      clearTimeout(timer);
      if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
    };

    if (opts.signal) {
      opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    worker.on("message", (msg: WorkerMessage) => {
      if (msg.ok && msg.result) {
        settle(() => {
          worker.terminate().catch(() => undefined);
          resolve(msg.result as ParseResult);
        });
      } else {
        settle(() => {
          worker.terminate().catch(() => undefined);
          reject(new Error(msg.error ?? "worker returned unknown error"));
        });
      }
    });

    worker.on("error", (err) => {
      settle(() => reject(new Error(`worker crashed: ${err.message}`)));
    });

    worker.on("exit", (code) => {
      /* Если worker вышел сам без message и не по terminate (settled=false),
         это краш — отдаём осмысленную ошибку. */
      if (!settled) {
        settle(() => reject(new Error(`worker exited unexpectedly with code ${code}`)));
      }
    });
  });
}

/**
 * Резолвим путь к compiled worker entry. После `tsc` оба файла лежат
 * в одной директории `dist-electron/lib/scanner/parsers/`. Если файла
 * нет (dev через tsx, не сделан compile) — возвращаем null, caller
 * graceful fallback'нет на main thread.
 *
 * Cross-mode safety: в CJS-сборке (production tsc) `__dirname` определён;
 * в ESM (тесты через tsx, package.json "type":"module") — недоступен.
 * `typeof` не throws на undeclared identifiers, поэтому `typeof __dirname`
 * — безопасный способ детектировать режим. В ESM возвращаем null:
 * worker всё равно недоступен (тесты не загружают compiled .js), и
 * caller сделает корректный fallback на main-thread парсинг.
 */
function resolveWorkerEntry(): string | null {
  if (typeof __dirname === "undefined") {
    return null;
  }
  const candidate = path.join(__dirname, "pdf-worker.js");
  return existsSync(candidate) ? candidate : null;
}
