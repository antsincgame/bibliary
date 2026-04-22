/**
 * Local runner — спавнит unsloth тренировку через WSL и стримит метрики.
 *
 * Output unsloth/HF Trainer обычно содержит JSON-like dict в логах:
 *   {'loss': 1.234, 'grad_norm': 0.567, 'learning_rate': 2e-4, 'epoch': 0.42, 'step': 12}
 *
 * Мы парсим это регекспом и эмитим события через EventEmitter.
 */

import { EventEmitter } from "events";
import * as path from "path";
import { promises as fs } from "fs";
import { spawnWsl, toWslPath } from "./wsl";

export interface TrainingMetric {
  step: number;
  loss?: number;
  gradNorm?: number;
  learningRate?: number;
  epoch?: number;
}

export interface RunnerEvents {
  on(event: "metric", listener: (m: TrainingMetric) => void): this;
  on(event: "stdout", listener: (line: string) => void): this;
  on(event: "stderr", listener: (line: string) => void): this;
  on(event: "exit", listener: (code: number | null) => void): this;
  on(event: "error", listener: (err: Error) => void): this;
}

/** Default heartbeat watchdog: если ни один stdout/stderr байт не пришёл за это
 *  время — считаем процесс зависшим. 30 минут — с запасом для длинных compile-фаз
 *  unsloth/bitsandbytes на холодном venv. */
const DEFAULT_HEARTBEAT_MS = 30 * 60 * 1000;

/** Hard wall-clock timeout: 12 часов на трен (LoRA 7B обычно 1-3 часа). 0 = без cap. */
const DEFAULT_MAX_WALL_MS = 12 * 60 * 60 * 1000;

export class LocalRunner extends EventEmitter implements RunnerEvents {
  private child: ReturnType<typeof spawnWsl> | null = null;
  private stdoutBuf = "";
  private stderrBuf = "";
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private wallTimer: NodeJS.Timeout | null = null;
  private lastIoAt = 0;
  private heartbeatMs = DEFAULT_HEARTBEAT_MS;

  /**
   * @param scriptWinPath Windows-путь к сгенерированному forge-train.py
   * @param distro WSL distro (default — null = default distro)
   * @param venvActivate путь к venv внутри WSL (default ~/bibliary-forge/.venv)
   * @param heartbeatMs макс пауза без stdout/stderr (default 30 мин); 0 = выкл
   * @param maxWallMs hard timeout всего процесса (default 12ч); 0 = выкл
   */
  start(opts: {
    scriptWinPath: string;
    distro?: string | null;
    venvActivate?: string;
    extraEnv?: Record<string, string>;
    heartbeatMs?: number;
    maxWallMs?: number;
  }): void {
    if (this.child) throw new Error("Runner already started");

    const wslPath = toWslPath(opts.scriptWinPath);
    const venv = opts.venvActivate ?? "$HOME/bibliary-forge/.venv";
    const envExports = Object.entries(opts.extraEnv ?? {})
      .map(([k, v]) => `export ${k}=${JSON.stringify(v)}`)
      .join("; ");

    const cmd = `${envExports ? envExports + "; " : ""}source ${venv}/bin/activate && python -u "${wslPath}"`;
    this.child = spawnWsl(["--", "bash", "-c", cmd], opts.distro);

    this.child.stdout?.on("data", (data: Buffer) => {
      this.lastIoAt = Date.now();
      this.stdoutBuf += data.toString("utf8");
      this.flushBuf("stdout");
    });
    this.child.stderr?.on("data", (data: Buffer) => {
      this.lastIoAt = Date.now();
      this.stderrBuf += data.toString("utf8");
      this.flushBuf("stderr");
    });
    this.child.on("exit", (code) => {
      this.clearWatchdogs();
      this.emit("exit", code);
    });
    this.child.on("error", (err) => {
      this.clearWatchdogs();
      this.emit("error", err);
    });

    this.lastIoAt = Date.now();
    this.heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    if (this.heartbeatMs > 0) {
      this.heartbeatTimer = setInterval(() => {
        if (!this.child) return;
        const idle = Date.now() - this.lastIoAt;
        if (idle > this.heartbeatMs) {
          this.emit("error", new Error(`heartbeat timeout: no output for ${Math.round(idle / 1000)}s — killing process`));
          this.killHard();
        }
      }, Math.min(60_000, Math.max(5_000, this.heartbeatMs / 4)));
    }

    const wallMs = opts.maxWallMs ?? DEFAULT_MAX_WALL_MS;
    if (wallMs > 0) {
      this.wallTimer = setTimeout(() => {
        if (!this.child) return;
        this.emit("error", new Error(`wall-clock timeout ${Math.round(wallMs / 60000)}min reached — killing process`));
        this.killHard();
      }, wallMs);
    }
  }

  private clearWatchdogs(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.wallTimer) {
      clearTimeout(this.wallTimer);
      this.wallTimer = null;
    }
  }

  private killHard(): void {
    if (!this.child) return;
    try {
      this.child.kill("SIGTERM");
      const proc = this.child;
      setTimeout(() => {
        try { proc.kill("SIGKILL"); } catch { /* already dead */ }
      }, 5_000);
    } catch { /* noop */ }
    this.child = null;
    this.clearWatchdogs();
  }

  private flushBuf(kind: "stdout" | "stderr"): void {
    const which = kind === "stdout" ? "stdoutBuf" : "stderrBuf";
    let buf = this[which];
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trimEnd();
      buf = buf.slice(idx + 1);
      if (line.length > 0) {
        this.emit(kind, line);
        const m = parseMetric(line);
        if (m) this.emit("metric", m);
      }
    }
    /* AUDIT P1 (god): защита от unbounded growth, если WSL-скрипт пишет
       прогресс-бары/бинарный мусор в один chunk БЕЗ \n. Без cap процесс
       Electron накапливал бы строку гигабайтами в RAM. Усекаем до
       MAX_PARTIAL_LINE_BYTES, эмитим как принудительную строку, чистим. */
    if (buf.length > LocalRunner.MAX_PARTIAL_LINE_BYTES) {
      const flushed = buf.slice(0, LocalRunner.MAX_PARTIAL_LINE_BYTES);
      this.emit(kind, `[truncated ${flushed.length}B no-newline chunk] ${flushed.slice(0, 200)}…`);
      buf = "";
    }
    this[which] = buf;
  }

  /** 1 MiB на одну неразорванную линию — после этого принудительный flush. */
  static readonly MAX_PARTIAL_LINE_BYTES = 1024 * 1024;

  cancel(): void {
    this.killHard();
  }

  isRunning(): boolean {
    return this.child !== null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Metric parser
// ─────────────────────────────────────────────────────────────────────────────

const METRIC_RE = /\{[^}]*'loss':\s*([\d.eE+-]+)[^}]*\}/;

export function parseMetric(line: string): TrainingMetric | null {
  // Trainer выводит примерно:
  // {'loss': 1.234, 'grad_norm': 0.567, 'learning_rate': 2e-4, 'epoch': 0.42}
  // Step обычно отдельным префиксом в строке.
  if (!METRIC_RE.test(line)) return null;
  const get = (key: string) => {
    const m = line.match(new RegExp(`'${key}':\\s*([\\d.eE+-]+)`));
    return m ? Number(m[1]) : undefined;
  };
  const stepMatch = line.match(/\b(\d+)\s*\/\s*\d+\b/);
  return {
    step: stepMatch ? Number(stepMatch[1]) : 0,
    loss: get("loss"),
    gradNorm: get("grad_norm"),
    learningRate: get("learning_rate"),
    epoch: get("epoch"),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// GGUF auto-import после успешной тренировки
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Копирует выданный GGUF в LM Studio models dir и возвращает путь.
 *
 * Ожидаемая структура внутри outputDir после тренировки:
 *   <outputDir>/gguf-q4_k_m/<model>.gguf
 */
export async function importGgufToLMStudio(
  outputDir: string,
  modelKey: string,
  lmStudioModelsRoot?: string
): Promise<{ destPath: string; copied: number }> {
  const root = lmStudioModelsRoot || path.join(process.env.USERPROFILE || process.env.HOME || ".", ".cache", "lm-studio", "models");
  const ggufDir = path.join(outputDir, "gguf-q4_k_m");
  const targetDir = path.join(root, "bibliary-finetuned", modelKey);
  await fs.mkdir(targetDir, { recursive: true });

  let copied = 0;
  let lastDest = "";
  const entries = await fs.readdir(ggufDir).catch(() => [] as string[]);
  for (const entry of entries) {
    if (!entry.endsWith(".gguf")) continue;
    const src = path.join(ggufDir, entry);
    const dst = path.join(targetDir, entry);
    await fs.copyFile(src, dst);
    lastDest = dst;
    copied++;
  }
  return { destPath: lastDest || targetDir, copied };
}
