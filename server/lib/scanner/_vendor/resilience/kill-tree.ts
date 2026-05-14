/**
 * Process tree killer — Windows + POSIX safe.
 *
 * Iter 14.3 (2026-05-04, /omnissiah audit): корневая причина жалобы
 * «после закрытия Bibliary остаются процессы».
 *
 * На Windows голый `child.kill()` посылает SIGTERM, который преобразуется
 * в `TerminateProcess` ТОЛЬКО для непосредственного child. Если child
 * запустил своих детей (7z.exe → распаковка через subprocess'ы; cmd.exe →
 * worker; wsl.exe → bash → python), они **переживут** kill родителя и
 * становятся orphans, продолжая держать handles, файлы, GPU и порты.
 *
 * `taskkill /T /F /PID <pid>` убивает дерево целиком (флаг `/T` = tree,
 * `/F` = force). На Linux/macOS используем `process.kill(-pid, "SIGKILL")`
 * чтобы убить process group (требует `detached: true` при spawn — у нас
 * это не везде так, поэтому ниже fallback на child.kill).
 *
 * Поведение:
 *   1. Сначала SIGTERM (graceful) — даём процессу шанс завершиться красиво.
 *   2. Через `gracefulMs` (по умолчанию 1500мс) — если ещё жив, tree-kill.
 *   3. Если pid отсутствует / процесс уже мёртв — no-op.
 */
import { execFile } from "node:child_process";
import type { ChildProcess } from "node:child_process";

const DEFAULT_GRACEFUL_MS = 1500;

export interface KillTreeOptions {
  /** Сколько ждать после SIGTERM перед force-kill дерева. Default 1500мс. */
  gracefulMs?: number;
  /** Skip graceful — сразу force-kill дерево. Используется при app-quit. */
  immediate?: boolean;
}

/**
 * Полностью убить дочерний процесс и всё его поддерево.
 * Безопасно вызывать многократно — повторные вызовы no-op.
 */
export function killChildTree(child: ChildProcess, opts: KillTreeOptions = {}): void {
  const pid = child.pid;
  if (!pid) return;
  if (child.exitCode !== null || child.signalCode !== null) return;

  const gracefulMs = Math.max(0, opts.gracefulMs ?? DEFAULT_GRACEFUL_MS);

  if (opts.immediate || gracefulMs === 0) {
    forceKillTree(pid, child);
    return;
  }

  try {
    child.kill("SIGTERM");
  } catch { /* already dead */ }

  const timer = setTimeout(() => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    forceKillTree(pid, child);
  }, gracefulMs);
  timer.unref();
}

function forceKillTree(pid: number, child: ChildProcess): void {
  if (process.platform === "win32") {
    /* `taskkill /T /F /PID <pid>` — terminate process tree.
       windowsHide:true чтобы не мигало консольным окном.
       Используем execFile а не execSync чтобы не блокировать event loop —
       мы же не ждём результата (процесс либо убит, либо уже мёртв). */
    execFile("taskkill", ["/T", "/F", "/PID", String(pid)], {
      windowsHide: true,
      timeout: 5000,
    }, () => {
      /* exit codes:
         0  = success
         128 = process not found (already dead — fine)
         иное — process resistant to taskkill, последняя попытка через child.kill */
      if (child.exitCode === null && child.signalCode === null) {
        try { child.kill("SIGKILL"); } catch { /* ignore */ }
      }
    });
    return;
  }

  /* POSIX: пробуем убить process group, если процесс был spawned с detached:true.
     Иначе fallback на одиночный SIGKILL. */
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try { child.kill("SIGKILL"); } catch { /* ignore */ }
  }
}
