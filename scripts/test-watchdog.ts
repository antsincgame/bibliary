/**
 * Phase 2.5R.6 — Watchdog behaviour test (через mock LM Studio).
 * Run: `npx tsx scripts/test-watchdog.ts`
 *
 * Тестирует:
 *  - watchdog активируется при reportBatchStart
 *  - 3 подряд timeout → emit lmstudio.offline + pauseAll
 *  - возврат liveness → lmstudio.online + resumeAll
 *  - watchdog деактивируется при reportBatchEnd последнего batch
 */
import { MockLMStudio } from "./test-lib/mock-lmstudio.js";

let passed = 0;
let failed = 0;

async function step(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (e) {
    console.error(`  FAIL  ${name}: ${e instanceof Error ? e.message : e}`);
    failed++;
  }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

async function main(): Promise<void> {
  console.log("Phase 2.5R.6 — Watchdog tests");

  const mock = new MockLMStudio({ port: 0 });
  await mock.start();
  process.env.LM_STUDIO_URL = mock.url();

  // динамический import после установки env
  const resilience = await import("../electron/lib/resilience/index.js");
  const watchdog = await import("../electron/lib/resilience/lmstudio-watchdog.js");

  // фейковый pipeline для тестирования pauseAll / resumeAll
  const pauseCalls: string[] = [];
  const resumeCalls: string[] = [];
  const dummyStore = {
    save: async () => undefined,
    load: async () => null,
    list: async () => [],
    remove: async () => undefined,
    scan: async () => [],
    getPath: () => "",
  };
  resilience.coordinator.registerPipeline({
    name: "dataset",
    store: dummyStore,
    pause: async (id: string) => {
      pauseCalls.push(id);
    },
    resume: async (id: string) => {
      resumeCalls.push(id);
    },
    cancel: async () => undefined,
    discard: async () => undefined,
    flushPending: async () => undefined,
  });

  watchdog.startWatchdog(() => null);

  await step("watchdog inactive when no active batch", async () => {
    mock.resetLog();
    await new Promise((r) => setTimeout(r, 200));
    assert(mock.getRequestLog().length === 0, `expected 0 polls, got ${mock.getRequestLog().length}`);
  });

  await step("watchdog activates on reportBatchStart", async () => {
    mock.resetLog();
    resilience.coordinator.reportBatchStart({
      batchId: "test-batch",
      pipeline: "dataset",
      startedAt: new Date().toISOString(),
      config: {},
    });
    // poll every 5s, but первый poll сразу через setInterval — ждём 5.5s
    await new Promise((r) => setTimeout(r, 5500));
    const requests = mock.getRequestLog().filter((r) => r.url === "/v1/models");
    assert(requests.length >= 1, `expected polls, got ${requests.length}`);
  });

  await step("offline triggers pauseAll after 3 failures", async () => {
    pauseCalls.length = 0;
    mock.setHealthy(false);
    // ждём 3 polls × 5s + buffer = 18s
    await new Promise((r) => setTimeout(r, 18000));
    assert(pauseCalls.length >= 1, `expected pause calls, got ${pauseCalls.length}`);
    assert(pauseCalls.includes("test-batch"), `expected test-batch in pauseCalls, got ${pauseCalls.join(",")}`);
  });

  await step("online triggers resumeAll", async () => {
    resumeCalls.length = 0;
    mock.setHealthy(true);
    // ждём один poll
    await new Promise((r) => setTimeout(r, 6000));
    assert(resumeCalls.length >= 1, `expected resume calls, got ${resumeCalls.length}`);
  });

  await step("watchdog deactivates after reportBatchEnd", async () => {
    resilience.coordinator.reportBatchEnd("test-batch");
    mock.resetLog();
    await new Promise((r) => setTimeout(r, 6000));
    const requests = mock.getRequestLog().filter((r) => r.url === "/v1/models");
    assert(requests.length === 0, `expected 0 polls after end, got ${requests.length}`);
  });

  watchdog.stopWatchdog();
  await mock.stop();

  console.log(`\n--- Summary ---\nPassed: ${passed}\nFailed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
