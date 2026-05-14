import { test } from "node:test";
import assert from "node:assert/strict";
import {
  spawnWithWatchdog,
  isChildWatchdogTimeoutError,
} from "../server/lib/scanner/_vendor/resilience/child-watchdog.ts";

const NODE_BIN = process.execPath;

function nodeArgs(snippet: string): readonly string[] {
  return ["-e", snippet];
}

test("spawnWithWatchdog: returns stdout for fast successful command", async () => {
  const result = await spawnWithWatchdog(
    NODE_BIN,
    nodeArgs("process.stdout.write('hello-world');"),
    { name: "test-fast", timeoutMs: 5_000 },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.toString("utf8"), "hello-world");
});

test("spawnWithWatchdog: kills hung child by SIGTERM after timeoutMs", async () => {
  const startedAt = Date.now();
  await assert.rejects(
    spawnWithWatchdog(
      NODE_BIN,
      nodeArgs("setInterval(()=>{}, 1_000_000);"),
      { name: "test-hang", timeoutMs: 200, killGraceMs: 200 },
    ),
    (err: unknown) => {
      assert.ok(isChildWatchdogTimeoutError(err), "expected ChildWatchdogTimeoutError");
      return true;
    },
  );
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed >= 200 && elapsed < 5_000, `unexpected elapsed: ${elapsed}ms`);
});

test("spawnWithWatchdog: rejects with stderr-tagged error for non-zero exit", async () => {
  await assert.rejects(
    spawnWithWatchdog(
      NODE_BIN,
      nodeArgs("process.stderr.write('boom-boom');process.exit(7);"),
      { name: "test-exit", timeoutMs: 5_000 },
    ),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      const e = err as Error & { exitCode?: number; stderr?: Buffer };
      assert.equal(e.exitCode, 7);
      assert.match(e.message, /boom-boom/);
      return true;
    },
  );
});

test("spawnWithWatchdog: respects external AbortSignal mid-flight", async () => {
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), 100);
  await assert.rejects(
    spawnWithWatchdog(
      NODE_BIN,
      nodeArgs("setInterval(()=>{}, 1_000_000);"),
      { name: "test-abort", timeoutMs: 5_000, signal: ctl.signal },
    ),
  );
});

test("spawnWithWatchdog: throws synchronously on already-aborted signal", async () => {
  const ctl = new AbortController();
  ctl.abort();
  await assert.rejects(
    spawnWithWatchdog(
      NODE_BIN,
      nodeArgs("process.stdout.write('never-runs');"),
      { name: "test-pre-abort", timeoutMs: 5_000, signal: ctl.signal },
    ),
    /aborted before spawn/,
  );
});

test("spawnWithWatchdog: caps stdout buffer at maxStdoutBytes", async () => {
  const result = await spawnWithWatchdog(
    NODE_BIN,
    nodeArgs("process.stdout.write('A'.repeat(50_000));"),
    { name: "test-cap", timeoutMs: 5_000, maxStdoutBytes: 4096 },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.length, 4096);
});

test("spawnWithWatchdog: rejects invalid timeoutMs", async () => {
  await assert.rejects(
    spawnWithWatchdog(NODE_BIN, ["-e", "1"], { name: "x", timeoutMs: 0 }),
    /timeoutMs must be positive/,
  );
  await assert.rejects(
    spawnWithWatchdog(NODE_BIN, ["-e", "1"], { name: "x", timeoutMs: -1 }),
    /timeoutMs must be positive/,
  );
});
