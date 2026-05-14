/**
 * PDF Worker Entry — runs in a worker_thread, isolated from the main process.
 *
 * Контракт:
 *   - Получает `workerData = { filePath, opts }` (без AbortSignal — он не
 *     сериализуется через postMessage; abort реализован в host'е через
 *     `worker.terminate()`).
 *   - Парсит PDF через main-thread implementation (`parsePdfMain`).
 *   - Отвечает одним сообщением: `{ ok: true, result }` или
 *     `{ ok: false, error }`.
 *
 * Изоляция:
 *   - Каждый worker — свежий thread. Crash/OOM не затрагивает main.
 *   - Глобальный state pdfjs-dist (font cache, internal references) не
 *     накапливается между книгами.
 *
 * Этот файл — единственная точка входа для worker'а. Не импортируется
 * никем из main кода (только запускается через `new Worker(filePath)`).
 */

import { parentPort, workerData } from "node:worker_threads";
import type { ParseOptions } from "./types.js";
import { parsePdfMain } from "./pdf.js";

interface WorkerInput {
  filePath: string;
  opts: ParseOptions;
}

async function run(): Promise<void> {
  if (!parentPort) {
    /* Запущен не как worker — некуда отвечать. Молча выходим, host
       поймёт по `exit`. */
    return;
  }
  const input = workerData as WorkerInput;
  try {
    const result = await parsePdfMain(input.filePath, input.opts);
    parentPort.postMessage({ ok: true, result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    parentPort.postMessage({ ok: false, error: message });
  }
}

void run();
