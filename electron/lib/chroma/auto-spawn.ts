/**
 * Auto-spawn Chroma vector store как child-process при старте Bibliary.
 *
 * Цель: пользователю не нужно вручную поднимать Chroma в отдельном
 * терминале (`uvx chromadb run --port 8000 --path ...`). Bibliary при boot
 * проверяет HTTP heartbeat — если offline, пытается spawn'нуть его сам.
 *
 * Стратегия:
 *   1. Если уже запущен (heartbeat OK) — skip, пользователь рулит руками.
 *   2. Иначе пробуем `uvx chromadb run --path <userData>/chroma --port 8000`.
 *   3. Если `uvx` нет — fallback на `python -m chromadb.cli run` (если pip
 *      install chromadb когда-то делали).
 *   4. Если ничего нет — log warning, return null. Welcome Wizard покажет
 *      install hint.
 *
 * Cleanup: child убивается через killChildTree в `before-quit`.
 *
 * Конфиг:
 *   - prefs.chromaAutoSpawn (default true) — выключить можно если человек
 *     гоняет Chroma на удалённом сервере или через Docker
 *   - port = 8000 (CHROMA_URL по умолчанию)
 *   - data path = <userData>/chroma — переживает переустановку app
 */

import { spawn, type ChildProcess } from "child_process";
import { promises as fs } from "fs";
import * as path from "path";
import { killChildTree } from "../resilience/kill-tree.js";

export interface ChromaSpawnResult {
  child: ChildProcess;
  port: number;
  dataPath: string;
  /** Promise resolved когда HTTP heartbeat начал отвечать. */
  ready: Promise<void>;
}

export interface ChromaSpawnOptions {
  /** Default 8000. */
  port?: number;
  /** Куда сохранять Chroma data. Default: $userDataPath/chroma. */
  dataPath: string;
  /** Heartbeat URL для проверки готовности. Default: http://localhost:<port>/api/v1/heartbeat */
  heartbeatUrl?: string;
  /** Max wait for ready. Default 30000ms. */
  readyTimeoutMs?: number;
}

const READY_POLL_INTERVAL_MS = 500;

let activeChild: ChildProcess | null = null;

/**
 * Проверка работающего Chroma: GET /api/v1/heartbeat. Возвращает true
 * если получил 200 OK. Никаких сторонних библиотек — global fetch.
 */
async function probeChroma(url: string, timeoutMs: number = 1500): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const resp = await fetch(url, { signal: ctrl.signal });
      return resp.ok;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

/**
 * Пробует найти доступный CLI: `uvx` (preferred) или `chromadb` (если
 * установлен через pip). Возвращает массив argv для spawn — null если
 * ничего нет.
 */
async function detectChromaCommand(dataPath: string, port: number): Promise<{ cmd: string; args: string[] } | null> {
  const portStr = String(port);

  /* uvx — preferred: tool runner от Astral, скачивает chromadb если надо. */
  if (await isCommandAvailable("uvx")) {
    return {
      cmd: "uvx",
      args: ["chromadb", "run", "--path", dataPath, "--port", portStr, "--host", "127.0.0.1"],
    };
  }

  /* chromadb напрямую — если pip install chromadb когда-то сделали. */
  if (await isCommandAvailable("chromadb")) {
    return {
      cmd: "chromadb",
      args: ["run", "--path", dataPath, "--port", portStr, "--host", "127.0.0.1"],
    };
  }

  /* python -m chromadb.cli — последний fallback. */
  for (const py of ["python3", "python"]) {
    if (await isCommandAvailable(py)) {
      return {
        cmd: py,
        args: ["-m", "chromadb.cli", "run", "--path", dataPath, "--port", portStr, "--host", "127.0.0.1"],
      };
    }
  }

  return null;
}

async function isCommandAvailable(cmd: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const which = process.platform === "win32" ? "where" : "which";
    const child = spawn(which, [cmd], { stdio: "ignore" });
    child.on("close", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });
}

/**
 * Запустить Chroma как child process.
 *
 * @returns ChromaSpawnResult с promise `ready` который зарезолвится когда
 *   heartbeat начал отвечать. Если spawn провалился (нет uvx/python) —
 *   throws Error с install hint.
 *
 * Если Chroma уже запущена (heartbeat OK перед spawn) — return null.
 * Caller знает что не надо ничего kill'ить.
 */
export async function startEmbeddedChroma(opts: ChromaSpawnOptions): Promise<ChromaSpawnResult | null> {
  const port = opts.port ?? 8000;
  const heartbeatUrl = opts.heartbeatUrl ?? `http://127.0.0.1:${port}/api/v1/heartbeat`;
  const readyTimeoutMs = opts.readyTimeoutMs ?? 30_000;

  /* Уже запущен (пользователем вручную или Docker'ом)? Не дублируем. */
  if (await probeChroma(heartbeatUrl)) {
    console.log(`[chroma-spawn] Chroma уже отвечает на ${heartbeatUrl} — пропускаем spawn`);
    return null;
  }

  /* Создать data dir если нет — Chroma сам не создаст вложенную структуру. */
  await fs.mkdir(opts.dataPath, { recursive: true });

  const command = await detectChromaCommand(opts.dataPath, port);
  if (!command) {
    throw new Error(
      "Chroma CLI not found. Install: `brew install uv` (recommended) " +
        "or `pip install chromadb`. Then restart Bibliary.",
    );
  }

  console.log(`[chroma-spawn] starting: ${command.cmd} ${command.args.join(" ")}`);

  const child = spawn(command.cmd, command.args, {
    /* stdio = pipe — мы хотим читать stdout/stderr для логирования.
     * detached false — child привязан к main process, kill при exit. */
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
  });

  activeChild = child;

  /* Логируем stdout/stderr с префиксом для отладки. Прерываем после первого
   * "ready" сообщения (после этого Chroma и так пишет много request logs). */
  let firstStdoutLogged = false;
  child.stdout?.on("data", (buf: Buffer) => {
    const text = buf.toString("utf8").trim();
    if (!text) return;
    if (!firstStdoutLogged) {
      console.log(`[chroma-spawn:stdout] ${text.split("\n")[0]}`);
      firstStdoutLogged = true;
    }
  });
  child.stderr?.on("data", (buf: Buffer) => {
    const text = buf.toString("utf8").trim();
    if (!text) return;
    /* Chroma пишет startup logs в stderr — нормально. Логируем только первые
     * чтобы не засрать main process console. */
    if (text.length < 200) console.log(`[chroma-spawn:stderr] ${text.split("\n")[0]}`);
  });

  child.on("exit", (code, signal) => {
    if (activeChild === child) activeChild = null;
    console.log(`[chroma-spawn] child exited: code=${code} signal=${signal}`);
  });
  child.on("error", (err) => {
    console.error("[chroma-spawn] spawn error:", err.message);
  });

  /* Дождаться ready: poll heartbeat каждые 500ms до timeout. */
  const ready = (async () => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < readyTimeoutMs) {
      if (child.exitCode !== null) {
        throw new Error(`Chroma child exited with code ${child.exitCode} before ready`);
      }
      if (await probeChroma(heartbeatUrl, 800)) {
        const elapsedMs = Date.now() - startedAt;
        console.log(`[chroma-spawn] ready in ${elapsedMs}ms on ${heartbeatUrl}`);
        return;
      }
      await new Promise((r) => setTimeout(r, READY_POLL_INTERVAL_MS));
    }
    throw new Error(`Chroma did not become ready within ${readyTimeoutMs}ms`);
  })();

  return {
    child,
    port,
    dataPath: opts.dataPath,
    ready,
  };
}

/**
 * Graceful shutdown активного child process. Вызывается из main.ts
 * before-quit. Idempotent — повторный вызов no-op.
 */
export async function stopEmbeddedChroma(): Promise<void> {
  if (!activeChild) return;
  const child = activeChild;
  activeChild = null;
  console.log("[chroma-spawn] stopping child process");
  try {
    killChildTree(child, { gracefulMs: 3000 });
  } catch (err) {
    console.warn("[chroma-spawn] kill error:", err instanceof Error ? err.message : err);
  }
}

/**
 * Default дата-путь для embedded Chroma. Лежит в userData чтобы переживало
 * переустановку app. На macOS это ~/Library/Application Support/bibliary/chroma,
 * на Windows %APPDATA%/bibliary/chroma.
 */
export function defaultChromaDataPath(userDataDir: string): string {
  return path.join(userDataDir, "chroma");
}
