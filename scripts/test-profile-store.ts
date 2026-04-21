/**
 * Phase 3.1 — ProfileStore + bibliary-profile.json round-trip tests.
 * Run: `npx tsx scripts/test-profile-store.ts`
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { initProfileStore, getProfileStore, ProfileSchema } from "../electron/lib/profiles/store.js";
import {
  exportBibliaryProfile,
  importBibliaryProfile,
  BibliaryProfileSchema,
} from "../electron/lib/profiles/bibliary-profile.js";
import { initPromptStore } from "../electron/lib/prompts/store.js";
import { configureTelemetry } from "../electron/lib/resilience/telemetry.js";

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

async function setupWorkspace(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bibliary-profile-"));
  configureTelemetry({ filePath: path.join(dir, "telemetry.jsonl") });
  // Минимальный prompt-store нужен для bibliary-profile (он читает datasetRoles)
  const promptDefaults = path.join(dir, "defaults", "prompts");
  await fs.mkdir(promptDefaults, { recursive: true });
  // Пустые stub-файлы достаточно — store не упадёт на пустых.
  await fs.writeFile(path.join(promptDefaults, "mechanicus.md"), "stub");
  await fs.writeFile(path.join(promptDefaults, "mechanicus-grammar.json"), "{}");
  await fs.writeFile(
    path.join(promptDefaults, "dataset-roles.json"),
    JSON.stringify({ T1: stubRole("T1"), T2: stubRole("T2"), T3: stubRole("T3") })
  );
  const ps = initPromptStore({
    dataDir: path.join(dir, "data", "prompts"),
    defaultsDir: promptDefaults,
  });
  await ps.ensureDefaults();

  const profileStore = initProfileStore({ dataDir: path.join(dir, "data") });
  await profileStore.ensureDefaults();

  return {
    dir,
    cleanup: async () => {
      try {
        await fs.rm(dir, { recursive: true, force: true });
      } catch {
        await new Promise((r) => setTimeout(r, 100));
        await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  };
}

function stubRole(role: string) {
  return {
    role,
    system: `system for ${role}`,
    voice: "voice",
    format: "format",
    examples: [],
    sampling: { max_tokens: 1024 },
  };
}

async function main(): Promise<void> {
  console.log("Phase 3.1 — ProfileStore + bibliary-profile tests\n");

  const ws = await setupWorkspace();

  try {
    console.log("[ProfileStore]");

    await step("ensureDefaults seed BIG + SMALL", async () => {
      const all = await getProfileStore().readAll();
      assert(all.find((p) => p.id === "BIG"), "BIG missing");
      assert(all.find((p) => p.id === "SMALL"), "SMALL missing");
    });

    await step("upsert custom profile", async () => {
      const custom = ProfileSchema.parse({
        id: "tiny",
        label: "Tiny test profile",
        modelKey: "test/tiny-1b",
        quant: "Q4_K_M",
        sizeGB: 1,
        minVramGB: 4,
        capabilities: ["tool"],
        ttlSec: 300,
        defaultContextLength: 4096,
        builtin: false,
      });
      await getProfileStore().upsert(custom);
      const got = await getProfileStore().getById("tiny");
      assert(got?.label === "Tiny test profile", "label mismatch");
    });

    await step("upsert обновляет существующий", async () => {
      const existing = await getProfileStore().getById("tiny");
      assert(existing, "tiny missing");
      await getProfileStore().upsert({ ...existing!, label: "Renamed" });
      const got = await getProfileStore().getById("tiny");
      assert(got?.label === "Renamed", "label not updated");
    });

    await step("remove non-builtin OK", async () => {
      await getProfileStore().remove("tiny");
      const got = await getProfileStore().getById("tiny");
      assert(got === null, "tiny should be gone");
    });

    await step("remove builtin throws", async () => {
      let threw = false;
      try {
        await getProfileStore().remove("BIG");
      } catch (e) {
        threw = e instanceof Error && /builtin/i.test(e.message);
      }
      assert(threw, "should throw");
    });

    await step("ProfileSchema rejects malformed", () => {
      let threw = false;
      try {
        ProfileSchema.parse({ id: "" });
      } catch {
        threw = true;
      }
      assert(threw, "schema must reject empty id");
    });

    await step("resetToDefaults wipes custom", async () => {
      await getProfileStore().upsert(
        ProfileSchema.parse({
          id: "to-be-wiped",
          label: "X",
          modelKey: "x/x",
          quant: "Q4_K_M",
          sizeGB: 1,
          minVramGB: 4,
          capabilities: [],
          ttlSec: 100,
          defaultContextLength: 4096,
          builtin: false,
        })
      );
      await getProfileStore().resetToDefaults();
      const got = await getProfileStore().getById("to-be-wiped");
      assert(got === null, "custom profile should be wiped");
    });

    console.log("\n[bibliary-profile.json round-trip]");

    await step("exportBibliaryProfile создаёт валидный файл", async () => {
      // Сначала добавим custom для разнообразия
      await getProfileStore().upsert(
        ProfileSchema.parse({
          id: "exporttest",
          label: "Export test",
          modelKey: "ex/test",
          quant: "Q5_K_M",
          sizeGB: 2,
          minVramGB: 6,
          capabilities: ["tool"],
          ttlSec: 200,
          defaultContextLength: 8192,
          builtin: false,
        })
      );

      const dest = path.join(ws.dir, "exported.json");
      const file = await exportBibliaryProfile(dest);
      assert(file.profiles.find((p) => p.id === "exporttest"), "custom profile in export");
      assert(file.$schema === "bibliary-profile/v1", "schema version");

      const raw = await fs.readFile(dest, "utf8");
      const parsed = BibliaryProfileSchema.parse(JSON.parse(raw));
      assert(parsed.profiles.length >= 3, "at least 3 profiles");
    });

    await step("importBibliaryProfile восстанавливает custom", async () => {
      const dest = path.join(ws.dir, "exported2.json");
      await exportBibliaryProfile(dest);
      // Очистим всё custom
      await getProfileStore().resetToDefaults();
      const before = await getProfileStore().readAll();
      assert(!before.find((p) => p.id === "exporttest"), "exporttest should be wiped");

      const summary = await importBibliaryProfile(dest);
      assert(summary.profilesUpserted >= 1, "at least 1 imported");
      const after = await getProfileStore().readAll();
      assert(after.find((p) => p.id === "exporttest"), "exporttest restored");
    });

    await step("importBibliaryProfile пропускает builtin", async () => {
      const dest = path.join(ws.dir, "exported3.json");
      await exportBibliaryProfile(dest);
      const summary = await importBibliaryProfile(dest);
      // Импорт пропускает builtin → counted только non-builtin
      assert(summary.profilesUpserted >= 1, "at least 1 non-builtin");
    });

    await step("importBibliaryProfile отвергает мусор", async () => {
      const bad = path.join(ws.dir, "bad.json");
      await fs.writeFile(bad, JSON.stringify({ random: 42 }));
      let threw = false;
      try {
        await importBibliaryProfile(bad);
      } catch {
        threw = true;
      }
      assert(threw, "should throw on invalid format");
    });
  } finally {
    await ws.cleanup();
  }

  console.log("\n--- Summary ---");
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
