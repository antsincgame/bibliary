/**
 * Memory Probe — RAM + VRAM мониторинг с adaptive cadence.
 *
 * Phalanx Risk Mitigation (Google review):
 *   - VRAM probe (nvidia-smi/wmic) heavy: 50–200 ms на вызов, gate не быстрее
 *     30s. RAM probe (os.freemem) light: 5s OK.
 *   - Probe только при активном импорте — сэкономить CPU вне работы.
 *   - Кэшировать ошибки: если nvidia-smi упал 1 раз → не вызываем до перезапуска
 *     процесса (нет драйвера / нет видеокарты).
 *   - Хранить last sample для UI; `getLastSample()` — non-blocking.
 *
 * Триггеры pressure:
 *   - free RAM < `ramPressureFreeMB` (по умолчанию 2048 MB / 2 GB).
 *   - VRAM utilization > `vramPressureRatio` (по умолчанию 0.92).
 *   - heap RSS > `rssPressureMB` (Node V8 sees memory pressure локально).
 */

import { exec } from "child_process";
import { promisify } from "util";
import * as os from "os";
import * as telemetry from "./telemetry.js";

const execAsync = promisify(exec);

export interface MemorySample {
  /** UNIX ms when sample was taken. */
  ts: number;
  ram: {
    /** Total RAM bytes (всегда из os.totalmem). */
    totalBytes: number;
    /** Free RAM bytes (os.freemem — light, fast, синхронный snapshot). */
    freeBytes: number;
    /** Process RSS bytes — что V8 реально удерживает. */
    rssBytes: number;
  };
  vram: {
    /** Сумма total VRAM по всем GPU (bytes). null если probe не удался. */
    totalBytes: number | null;
    /** Используемая VRAM суммарно (bytes). null если не получили. */
    usedBytes: number | null;
    /** Доля used / total. null если probe не удался. */
    utilization: number | null;
    /** "nvidia-smi" | "wmic" | "powershell" | "none" — для диагностики. */
    source: string;
  };
}

export interface MemoryProbeOptions {
  /** Интервал RAM probe (ms). По умолчанию 5_000. */
  ramIntervalMs?: number;
  /** Интервал VRAM probe (ms). Минимум 15_000 рекомендуется. По умолчанию 30_000. */
  vramIntervalMs?: number;
  /** Free RAM threshold для pressure (bytes). По умолчанию 2 GB. */
  ramPressureFreeBytes?: number;
  /** Process RSS threshold для pressure (bytes). По умолчанию 6 GB. */
  rssPressureBytes?: number;
  /** VRAM utilization threshold для pressure (0..1). По умолчанию 0.92. */
  vramPressureRatio?: number;
  /** Callback при detected pressure. */
  onPressure?: (kind: "ram" | "vram" | "rss", sample: MemorySample) => void;
  /** Callback на каждый sample (для UI/телеметрии). */
  onSample?: (sample: MemorySample) => void;
}

const DEFAULTS: Required<Omit<MemoryProbeOptions, "onPressure" | "onSample">> = {
  ramIntervalMs: 5_000,
  vramIntervalMs: 30_000,
  ramPressureFreeBytes: 2 * 1024 * 1024 * 1024,
  rssPressureBytes: 6 * 1024 * 1024 * 1024,
  vramPressureRatio: 0.92,
};

const VRAM_QUERY_TIMEOUT_MS = 3_000;

/**
 * Singleton instance pattern. Один импорт — один probe; повторные start
 * без stop ничего не ломают.
 */
class MemoryProbe {
  private ramTimer: NodeJS.Timeout | null = null;
  private vramTimer: NodeJS.Timeout | null = null;
  private vramDisabled = false;
  private vramSource = "none";
  private lastVram: { totalBytes: number | null; usedBytes: number | null } = {
    totalBytes: null,
    usedBytes: null,
  };
  private lastSample: MemorySample | null = null;
  private opts: Required<Omit<MemoryProbeOptions, "onPressure" | "onSample">> & {
    onPressure?: MemoryProbeOptions["onPressure"];
    onSample?: MemoryProbeOptions["onSample"];
  };
  private lastPressureLogAt: { ram: number; vram: number; rss: number } = {
    ram: 0,
    vram: 0,
    rss: 0,
  };

  constructor(options: MemoryProbeOptions = {}) {
    this.opts = {
      ramIntervalMs: Math.max(1_000, options.ramIntervalMs ?? DEFAULTS.ramIntervalMs),
      vramIntervalMs: Math.max(15_000, options.vramIntervalMs ?? DEFAULTS.vramIntervalMs),
      ramPressureFreeBytes: options.ramPressureFreeBytes ?? DEFAULTS.ramPressureFreeBytes,
      rssPressureBytes: options.rssPressureBytes ?? DEFAULTS.rssPressureBytes,
      vramPressureRatio: options.vramPressureRatio ?? DEFAULTS.vramPressureRatio,
      onPressure: options.onPressure,
      onSample: options.onSample,
    };
  }

  isRunning(): boolean {
    return this.ramTimer !== null;
  }

  start(): void {
    if (this.ramTimer !== null) return;
    /* Сброс кэша ошибок VRAM при каждом start(): GPU-драйвер мог
       восстановиться между stop()/start() (напр., после перезагрузки драйвера). */
    this.vramDisabled = false;
    /* Immediate first sample, then interval. */
    void this.sampleAll();
    this.ramTimer = setInterval(() => {
      void this.sampleRamOnly();
    }, this.opts.ramIntervalMs);
    this.vramTimer = setInterval(() => {
      void this.sampleVramOnly();
    }, this.opts.vramIntervalMs);
    /* Detached intervals so process exit isn't blocked. */
    this.ramTimer.unref?.();
    this.vramTimer?.unref?.();
  }

  stop(): void {
    if (this.ramTimer !== null) {
      clearInterval(this.ramTimer);
      this.ramTimer = null;
    }
    if (this.vramTimer !== null) {
      clearInterval(this.vramTimer);
      this.vramTimer = null;
    }
  }

  /** Last cached sample. */
  getLastSample(): MemorySample | null {
    return this.lastSample;
  }

  private async sampleAll(): Promise<void> {
    await this.sampleRamOnly();
    await this.sampleVramOnly();
  }

  private async sampleRamOnly(): Promise<void> {
    const totalBytes = os.totalmem();
    const freeBytes = os.freemem();
    const rssBytes = process.memoryUsage.rss();
    const ts = Date.now();
    const sample: MemorySample = {
      ts,
      ram: { totalBytes, freeBytes, rssBytes },
      vram: {
        totalBytes: this.lastVram.totalBytes,
        usedBytes: this.lastVram.usedBytes,
        utilization:
          this.lastVram.totalBytes && this.lastVram.usedBytes !== null
            ? this.lastVram.usedBytes / this.lastVram.totalBytes
            : null,
        source: this.vramSource,
      },
    };
    this.lastSample = sample;
    this.opts.onSample?.(sample);
    this.checkPressure(sample);
  }

  private async sampleVramOnly(): Promise<void> {
    if (this.vramDisabled) return;
    const result = await tryQueryVram();
    if (result === null) {
      this.vramDisabled = true;
      this.vramSource = "none";
      telemetry.logEvent({
        type: "memory.vram_probe_disabled",
        reason: "first_failure",
      });
      return;
    }
    this.lastVram = { totalBytes: result.totalBytes, usedBytes: result.usedBytes };
    this.vramSource = result.source;
    if (this.lastSample) {
      this.lastSample.vram = {
        totalBytes: result.totalBytes,
        usedBytes: result.usedBytes,
        utilization:
          result.totalBytes > 0 && result.usedBytes !== null
            ? result.usedBytes / result.totalBytes
            : null,
        source: result.source,
      };
      this.checkPressure(this.lastSample);
    }
  }

  private checkPressure(sample: MemorySample): void {
    const now = sample.ts;
    /* Throttle: log/emit pressure не чаще раза в 30s по каждому виду. */
    const PRESSURE_LOG_THROTTLE_MS = 30_000;
    if (
      sample.ram.freeBytes < this.opts.ramPressureFreeBytes &&
      now - this.lastPressureLogAt.ram > PRESSURE_LOG_THROTTLE_MS
    ) {
      this.lastPressureLogAt.ram = now;
      telemetry.logEvent({
        type: "memory.pressure",
        kind: "ram",
        freeBytes: sample.ram.freeBytes,
        rssBytes: sample.ram.rssBytes,
        totalBytes: sample.ram.totalBytes,
      });
      this.opts.onPressure?.("ram", sample);
    }
    if (
      sample.ram.rssBytes > this.opts.rssPressureBytes &&
      now - this.lastPressureLogAt.rss > PRESSURE_LOG_THROTTLE_MS
    ) {
      this.lastPressureLogAt.rss = now;
      telemetry.logEvent({
        type: "memory.pressure",
        kind: "rss",
        rssBytes: sample.ram.rssBytes,
      });
      this.opts.onPressure?.("rss", sample);
    }
    if (
      sample.vram.utilization !== null &&
      sample.vram.utilization > this.opts.vramPressureRatio &&
      now - this.lastPressureLogAt.vram > PRESSURE_LOG_THROTTLE_MS
    ) {
      this.lastPressureLogAt.vram = now;
      telemetry.logEvent({
        type: "memory.pressure",
        kind: "vram",
        utilization: sample.vram.utilization,
        source: sample.vram.source,
      });
      this.opts.onPressure?.("vram", sample);
    }
  }
}

/* ─── VRAM probe backends ─────────────────────────────────────────────── */

interface VramQueryResult {
  totalBytes: number;
  usedBytes: number | null;
  source: "nvidia-smi" | "wmic" | "powershell";
}

async function tryQueryVram(): Promise<VramQueryResult | null> {
  /* nvidia-smi gives both total and used → preferred. */
  const nvidia = await tryNvidiaSmi();
  if (nvidia) return nvidia;
  /* On Windows fall back to PowerShell (wmic deprecated на Win11 23H2+). */
  if (process.platform === "win32") {
    const ps = await tryPowerShell();
    if (ps) return ps;
    const wmic = await tryWmic();
    if (wmic) return wmic;
  }
  return null;
}

async function tryNvidiaSmi(): Promise<VramQueryResult | null> {
  try {
    const { stdout } = await execAsync(
      "nvidia-smi --query-gpu=memory.total,memory.used --format=csv,noheader,nounits",
      { timeout: VRAM_QUERY_TIMEOUT_MS },
    );
    let total = 0;
    let used = 0;
    let valid = false;
    for (const line of stdout.split(/\r?\n/)) {
      const row = line.trim();
      if (!row) continue;
      const [t, u] = row.split(",").map((s) => Number(s.trim()));
      if (Number.isFinite(t) && t > 0 && Number.isFinite(u)) {
        total += t * 1024 * 1024;
        used += u * 1024 * 1024;
        valid = true;
      }
    }
    if (!valid) return null;
    return { totalBytes: total, usedBytes: used, source: "nvidia-smi" };
  } catch {
    return null;
  }
}

async function tryPowerShell(): Promise<VramQueryResult | null> {
  try {
    const { stdout } = await execAsync(
      'powershell -NoProfile -Command "Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty AdapterRAM"',
      { timeout: VRAM_QUERY_TIMEOUT_MS },
    );
    let total = 0;
    for (const line of stdout.split(/\r?\n/)) {
      const v = Number(line.trim());
      if (Number.isFinite(v) && v > 0) total += v;
    }
    if (total <= 0) return null;
    return { totalBytes: total, usedBytes: null, source: "powershell" };
  } catch {
    return null;
  }
}

async function tryWmic(): Promise<VramQueryResult | null> {
  try {
    const { stdout } = await execAsync(
      "wmic path win32_VideoController get AdapterRAM /format:value",
      { timeout: VRAM_QUERY_TIMEOUT_MS },
    );
    let total = 0;
    for (const line of stdout.split(/\r?\n/)) {
      const m = /AdapterRAM=(\d+)/.exec(line);
      if (m) {
        const v = Number(m[1]);
        if (Number.isFinite(v) && v > 0) total += v;
      }
    }
    if (total <= 0) return null;
    return { totalBytes: total, usedBytes: null, source: "wmic" };
  } catch {
    return null;
  }
}

/* ─── Singleton API ───────────────────────────────────────────────────── */

let SINGLETON: MemoryProbe | null = null;

/**
 * Создаёт (или возвращает существующий) singleton probe.
 * Стартует только при первом `startMemoryProbe()`.
 */
export function getMemoryProbe(options?: MemoryProbeOptions): MemoryProbe {
  if (!SINGLETON) SINGLETON = new MemoryProbe(options);
  return SINGLETON;
}

export function startMemoryProbe(options?: MemoryProbeOptions): void {
  const probe = getMemoryProbe(options);
  probe.start();
}

export function stopMemoryProbe(): void {
  SINGLETON?.stop();
}

export function getLastMemorySample(): MemorySample | null {
  return SINGLETON?.getLastSample() ?? null;
}

export function _resetMemoryProbeForTests(): void {
  SINGLETON?.stop();
  SINGLETON = null;
}
