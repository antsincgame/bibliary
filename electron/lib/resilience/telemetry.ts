import { promises as fs } from "fs";
import * as path from "path";
import { TELEMETRY_MAX_BYTES } from "./constants";

export type TelemetryEvent =
  | { type: "batch.start"; batchId: string; pipeline: "extraction"; config: unknown; ts: string }
  | {
      type: "batch.chunk.ok";
      batchId: string;
      chunkId: string;
      latencyMs: number;
      tokens?: { prompt: number; completion: number };
      recovered?: boolean;
      ts: string;
    }
  | { type: "batch.chunk.fail"; batchId: string; chunkId: string; error: string; attempt: number; ts: string }
  | { type: "batch.end"; batchId: string; ok: number; failed: number; durationMs: number; ts: string }
  | { type: "shutdown.flush.start"; pendingBatches: string[]; ts: string }
  | { type: "shutdown.flush.ok"; durationMs: number; ts: string }
  | { type: "shutdown.flush.timeout"; pendingBatches: string[]; ts: string }
  | { type: "shutdown.flush.error"; error: string; ts: string }
  | { type: "lmstudio.offline"; consecutiveFailures: number; ts: string }
  | { type: "lmstudio.online"; ts: string }
  | { type: "lmstudio.throttle"; tps: number; newCoolDownMs: number; ts: string }
  | { type: "lmstudio.crash_detected"; modelKey: string; ts: string }
  | {
      /**
       * OOM был пойман в ModelPool.acquireExclusive и автоматически восстановлен:
       * вызвано evictAll() (или unloadAllHeavy() во второй попытке) и retry прошёл успешно.
       */
      type: "lmstudio.oom_recovered";
      modelKey: string;
      vramMB: number;
      strategy: "evict_all" | "unload_heavy";
      attempts: number;
      durationMs: number;
      ts: string;
    }
  | {
      /**
       * OOM повторился после всех попыток восстановления — модель так и не загрузилась.
       * Pool пробрасывает ошибку дальше, caller должен handle (warn в UI).
       */
      type: "lmstudio.oom_failed";
      modelKey: string;
      vramMB: number;
      attempts: number;
      lastError: string;
      ts: string;
    }
  | {
      /**
       * Circuit Breaker для LM Studio HTTP API перешёл в OPEN: errorRate в
       * sliding window превысил threshold. Все следующие запросы будут
       * мгновенно валиться CircuitOpenError до halfOpenAt.
       */
      type: "lmstudio.circuit_open";
      name: string;
      backoffMs: number;
      consecutiveOpens: number;
      windowFailures: number;
      windowSuccesses: number;
      ts: string;
    }
  | {
      /**
       * Circuit Breaker перешёл OPEN→HALF_OPEN — пропускаем пробный запрос.
       * Если он успешен — вернёмся в CLOSED, если нет — снова в OPEN с
       * увеличенным backoff.
       */
      type: "lmstudio.circuit_half_open";
      name: string;
      backoffMs: number;
      ts: string;
    }
  | {
      /** Circuit Breaker вернулся в CLOSED после серии успешных пробных запросов. */
      type: "lmstudio.circuit_closed";
      name: string;
      ts: string;
    }
  | {
      /**
       * OCR Quality Drift detected — мониторинг обнаружил что recent quality
       * значимо ниже baseline window. Telemetry-only сигнал для пост-морт
       * анализа (никаких автокорректировок).
       */
      type: "ocr.quality_drift";
      engine: "text-layer" | "system-ocr" | "vision-llm";
      baselineMean: number;
      recentMean: number;
      driftRatio: number;
      recentSamples: number;
      windowSize: number;
      ts: string;
    }
  | {
      /**
       * AIMD controller изменил concurrency limit для именованного контроллера
       * (lane scheduler, пул соединений и т.п.). Reason указывает на причину:
       *   - increase            — success rate высокий, latency в норме
       *   - decrease_failure    — была ошибка в недавнем окне
       *   - decrease_latency    — P95 latency превысил threshold
       */
      type: "aimd.adjusted";
      name: string;
      oldLimit: number;
      newLimit: number;
      reason: "increase" | "decrease_failure" | "decrease_latency" | "decrease_pressure";
      successRate: number;
      p95LatencyMs: number;
      windowSize: number;
      ts: string;
    }
  | {
      /**
       * Memory pressure detected (RAM/VRAM/RSS превысили threshold).
       * Срабатывает не чаще раза в 30s по каждому виду (throttle).
       */
      type: "memory.pressure";
      kind: "ram" | "vram" | "rss";
      freeBytes?: number;
      rssBytes?: number;
      totalBytes?: number;
      utilization?: number;
      source?: string;
      ts: string;
    }
  | {
      /**
       * VRAM probe был отключён (nvidia-smi/wmic упали). Caching стратегия:
       * один fail → не пытаемся снова до перезапуска приложения.
       */
      type: "memory.vram_probe_disabled";
      reason: "first_failure" | "no_devices";
      ts: string;
    }
  | {
      /**
       * Iter 12 P1.2: HARD+REPLACE editions — старая ревизия удалена в пользу
       * новой с более высоким revisionScore. Audit trail для пользователя.
       */
      type: "revision.replaced";
      oldBookId: string;
      newBookId: string;
      oldTitle: string;
      newTitle: string;
      oldFormat?: string;
      newFormat?: string;
      oldYear?: number;
      newYear?: number;
      ts: string;
    }
  | {
      /**
       * Child process (ddjvu/calibre/tesseract/etc) убит watchdog'ом по
       * timeoutMs. Используется для post-mortem анализа: какие книги стабильно
       * валят DjVuLibre, какой DPI требует больше времени, etc.
       */
      type: "child.timeout";
      name: string;
      command: string;
      elapsedMs: number;
      killed: boolean;
      exitCode: number | null;
      signalName: string | null;
      ts: string;
    }
  | {
      /**
       * Image preflight забраковал буфер до отправки в vision-LLM (магия
       * не сошлась, sharp не смог декодировать, размеры вне диапазона).
       * Защищает от LM Studio "Invalid image detected at index 0" RPC error.
       */
      type: "lmstudio.invalid_image_rejected";
      reason: string;
      bytes: number;
      modelKey?: string;
      ts: string;
    }
  | {
      /**
       * Hybrid response_format strategy: какую стратегию выбрали для запроса.
       * "json_schema" — обычные модели (constrained decoding).
       * "text" — thinking-модели (Qwen3.5+, DeepSeek-R1) где json_schema
       * рискует упереть schema constraint в reasoning stream и вернуть
       * пустой content (LM Studio bug-tracker #1773).
       */
      type: "lmstudio.response_format_picked";
      role: string;
      modelKey: string;
      strategy: "json_schema" | "text";
      ts: string;
    }
  | {
      /**
       * Iter 14.4 (2026-05-04): native DjVu parser bundle (RussCoder/djvu.js)
       * успешно загружен в vm sandbox при первом обращении. Используется для
       * проверки что замена DjVuLibre CLI инициализируется корректно.
       */
      type: "djvu.native.bundle_loaded";
      bundlePath: string;
      bundleBytes: number;
      loadMs: number;
      ts: string;
    }
  | {
      /**
       * Iter 14.4 (2026-05-04): native DjVu parser словил ошибку при чтении
       * конкретной страницы. Не fatal — caller продолжает со следующей.
       */
      type: "djvu.native.page_error";
      filePath: string;
      pageNumber: number;
      error: string;
      ts: string;
    }
;

export type TelemetryEventInput<E extends TelemetryEvent = TelemetryEvent> = E extends TelemetryEvent
  ? Omit<E, "ts"> & { ts?: string }
  : never;

let configuredPath: string | null = null;
let configuredMaxBytes = TELEMETRY_MAX_BYTES;
let writeChain: Promise<void> = Promise.resolve();

export function configureTelemetry(opts: { filePath: string; maxBytes?: number }): void {
  configuredPath = opts.filePath;
  if (typeof opts.maxBytes === "number" && opts.maxBytes > 0) {
    configuredMaxBytes = opts.maxBytes;
  }
}

export function logEvent<E extends TelemetryEvent>(event: TelemetryEventInput<E>): void {
  if (!configuredPath) return;
  const enriched = { ts: new Date().toISOString(), ...(event as object) } as TelemetryEvent;
  const line = JSON.stringify(enriched) + "\n";
  const targetPath = configuredPath;
  writeChain = writeChain
    .then(() => appendWithRotation(targetPath, line, configuredMaxBytes))
    .catch((err) => {
      console.error("[telemetry] write failed:", err instanceof Error ? err.message : err);
    });
}

export async function flush(): Promise<void> {
  await writeChain;
}

export async function tail(n: number): Promise<TelemetryEvent[]> {
  if (!configuredPath) return [];
  await flush();
  let raw: string;
  try {
    raw = await fs.readFile(configuredPath, "utf8");
  } catch {
    return [];
  }
  const lines = raw.split("\n").filter((line) => line.trim().length > 0);
  const slice = n > 0 ? lines.slice(-n) : lines;
  const events: TelemetryEvent[] = [];
  for (const line of slice) {
    try {
      events.push(JSON.parse(line) as TelemetryEvent);
    } catch {
      // повреждённую строку пропускаем
    }
  }
  return events;
}

async function appendWithRotation(filePath: string, line: string, maxBytes: number): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  let size = 0;
  try {
    const stat = await fs.stat(filePath);
    size = stat.size;
  } catch {
    size = 0;
  }

  if (size + line.length > maxBytes && size > 0) {
    await rotate(filePath);
  }

  await fs.appendFile(filePath, line, "utf8");
}

async function rotate(filePath: string): Promise<void> {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath, ".jsonl");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const rotated = path.join(dir, `${base}-${stamp}.jsonl`);
  try {
    await fs.rename(filePath, rotated);
  } catch (err) {
    console.error("[telemetry] rotation failed:", err instanceof Error ? err.message : err);
  }
}
