/**
 * Phase 3.1 — Hardware profiler smoke tests.
 * Не зависим от реального GPU — просто проверяем что детект не падает и
 * возвращает структуру правильной формы.
 *
 * Run: `npx tsx scripts/test-hardware.ts`
 */
import { detectHardware, clearHardwareCache } from "../electron/lib/hardware/profiler.js";

let passed = 0;
let failed = 0;

async function step(name: string, fn: () => Promise<void> | void): Promise<void> {
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
  console.log("Phase 3.1 — Hardware profiler smoke tests\n");

  await step("detectHardware возвращает структуру", async () => {
    const hw = await detectHardware();
    assert(typeof hw.os.platform === "string", "platform missing");
    assert(typeof hw.cpu.model === "string", "cpu.model missing");
    assert(hw.cpu.cores >= 1, "cores >= 1");
    assert(hw.cpu.threads >= hw.cpu.cores, "threads >= cores");
    assert(typeof hw.ramGB === "number" && hw.ramGB > 0, "ramGB > 0");
    assert(Array.isArray(hw.gpus), "gpus is array");
    assert(typeof hw.detectedAt === "string", "detectedAt is string");
  });

  await step("кеш повторного вызова работает", async () => {
    const a = await detectHardware();
    const b = await detectHardware();
    assert(a.detectedAt === b.detectedAt, "cache should be hit");
  });

  await step("force=true сбрасывает кеш", async () => {
    const a = await detectHardware();
    await new Promise((r) => setTimeout(r, 10));
    const b = await detectHardware({ force: true });
    assert(a.detectedAt !== b.detectedAt, "force should re-detect");
  });

  await step("clearHardwareCache сбрасывает", async () => {
    await detectHardware();
    clearHardwareCache();
    const fresh = await detectHardware();
    assert(typeof fresh.detectedAt === "string", "detect after clear works");
  });

  await step("bestGpu корректный или null", async () => {
    const hw = await detectHardware();
    if (hw.bestGpu) {
      assert(typeof hw.bestGpu.name === "string", "bestGpu.name");
      assert(["cuda", "metal", "rocm", "unknown"].includes(hw.bestGpu.backend), "valid backend");
    }
  });

  await step("ramGB > 1 на любой современной машине", async () => {
    const hw = await detectHardware();
    assert(hw.ramGB > 1, `ramGB=${hw.ramGB}, expected > 1`);
  });

  console.log("\n--- Summary ---");
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
