import { spawn, type ChildProcess, type SpawnOptions } from "child_process";
import * as telemetry from "./telemetry.js";

export interface ChildWatchdogOptions extends SpawnOptions {
  name: string;
  timeoutMs: number;
  killGraceMs?: number;
  signal?: AbortSignal;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  onStart?: (pid: number) => void;
}

export interface ChildWatchdogResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number;
  durationMs: number;
}

export class ChildWatchdogTimeoutError extends Error {
  readonly name = "ChildWatchdogTimeoutError";
  readonly killed: boolean;
  readonly elapsedMs: number;
  readonly child: ChildProcess;

  constructor(child: ChildProcess, elapsedMs: number, killed: boolean, watchdogName: string) {
    super(
      `Child process "${watchdogName}" (pid=${child.pid ?? "?"}) timed out after ${elapsedMs}ms${
        killed ? " (killed)" : " (kill failed)"
      }`,
    );
    this.child = child;
    this.elapsedMs = elapsedMs;
    this.killed = killed;
  }
}

const DEFAULT_KILL_GRACE_MS = 1500;
const DEFAULT_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

function attachOutputCollector(stream: NodeJS.ReadableStream | null, capBytes: number): {
  data: () => Buffer;
  destroy: () => void;
} {
  const chunks: Buffer[] = [];
  let total = 0;
  const onData = (chunk: Buffer): void => {
    if (total >= capBytes) return;
    const remaining = capBytes - total;
    const slice = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
    chunks.push(slice);
    total += slice.length;
  };
  if (stream) stream.on("data", onData);
  return {
    data: () => Buffer.concat(chunks),
    destroy: () => {
      if (stream) stream.off("data", onData);
    },
  };
}

export async function spawnWithWatchdog(
  command: string,
  args: ReadonlyArray<string>,
  opts: ChildWatchdogOptions,
): Promise<ChildWatchdogResult> {
  if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0) {
    throw new Error(`spawnWithWatchdog: timeoutMs must be positive, got ${opts.timeoutMs}`);
  }

  const externalSignal = opts.signal;
  if (externalSignal?.aborted) {
    throw new Error(`Child "${opts.name}" aborted before spawn`);
  }

  const startedAt = Date.now();
  const spawnOpts: SpawnOptions = {
    ...opts,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  };

  const child = spawn(command, [...args], spawnOpts);
  if (typeof child.pid === "number") opts.onStart?.(child.pid);

  const stdoutCollector = attachOutputCollector(
    child.stdout,
    opts.maxStdoutBytes ?? DEFAULT_MAX_BUFFER_BYTES,
  );
  const stderrCollector = attachOutputCollector(
    child.stderr,
    opts.maxStderrBytes ?? DEFAULT_MAX_BUFFER_BYTES,
  );

  let timedOut = false;
  let killSucceeded = false;
  const killGraceMs = Math.max(100, opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS);

  const watchdogTimer: NodeJS.Timeout = setTimeout(() => {
    timedOut = true;
    try {
      child.kill("SIGTERM");
      killSucceeded = true;
    } catch {
      killSucceeded = false;
    }
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill("SIGKILL");
          killSucceeded = true;
        } catch {
          killSucceeded = false;
        }
      }
    }, killGraceMs);
  }, opts.timeoutMs);

  const onExternalAbort = (): void => {
    try {
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          try { child.kill("SIGKILL"); } catch { /* ignore */ }
        }
      }, killGraceMs);
    } catch { /* ignore */ }
  };
  if (externalSignal) externalSignal.addEventListener("abort", onExternalAbort, { once: true });

  return new Promise<ChildWatchdogResult>((resolve, reject) => {
    let settled = false;

    const cleanup = (): void => {
      clearTimeout(watchdogTimer);
      stdoutCollector.destroy();
      stderrCollector.destroy();
      if (externalSignal) externalSignal.removeEventListener("abort", onExternalAbort);
    };

    child.once("error", (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err instanceof Error ? err : new Error(String(err)));
    });

    child.once("close", (code, signalName) => {
      if (settled) return;
      settled = true;
      const elapsed = Date.now() - startedAt;
      cleanup();

      if (timedOut) {
        telemetry.logEvent({
          type: "child.timeout",
          name: opts.name,
          command,
          elapsedMs: elapsed,
          killed: killSucceeded,
          exitCode: code,
          signalName: signalName ?? null,
        });
        reject(new ChildWatchdogTimeoutError(child, elapsed, killSucceeded, opts.name));
        return;
      }

      if (externalSignal?.aborted) {
        reject(new Error(`Child "${opts.name}" aborted by signal (exit=${code}, signal=${signalName ?? "?"})`));
        return;
      }

      const exitCode = typeof code === "number" ? code : 1;
      if (exitCode !== 0) {
        const stderrPreview = stderrCollector.data().toString("utf8").slice(0, 500);
        const errMsg = `Child "${opts.name}" exited ${exitCode}${stderrPreview ? `: ${stderrPreview}` : ""}`;
        const err = new Error(errMsg) as Error & { exitCode: number; stderr: Buffer; stdout: Buffer };
        err.exitCode = exitCode;
        err.stderr = stderrCollector.data();
        err.stdout = stdoutCollector.data();
        reject(err);
        return;
      }

      resolve({
        stdout: stdoutCollector.data(),
        stderr: stderrCollector.data(),
        exitCode,
        durationMs: elapsed,
      });
    });
  });
}

export function isChildWatchdogTimeoutError(err: unknown): err is ChildWatchdogTimeoutError {
  return err instanceof ChildWatchdogTimeoutError ||
    (typeof err === "object" && err !== null && (err as { name?: string }).name === "ChildWatchdogTimeoutError");
}
