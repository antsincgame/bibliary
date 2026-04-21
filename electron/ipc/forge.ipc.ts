import { ipcMain, shell as electronShell, type BrowserWindow } from "electron";
import { promises as fs } from "fs";
import * as path from "path";
import {
  ForgeSpecSchema,
  generateAutoTrainYaml,
  generateAxolotlYaml,
  generateColabNotebook,
  generateUnslothPython,
  prepareDataset,
  generateBundle,
  parseAsChatML,
  getForgeStore,
  nextForgeRunId,
  LocalRunner,
  importGgufToLMStudio,
  runEval,
  chatMLToEvalCases,
  type ForgeRunState,
  type TrainingMetric,
  type EvalSummary,
} from "../lib/forge/index.js";
import { listBatchFiles } from "../finetune-state.js";
import { coordinator, telemetry } from "../lib/resilience/index.js";
import { getPreferencesStore } from "../lib/preferences/store.js";
import { chat } from "../lmstudio-client.js";

export function registerForgeIpc(getMainWindow: () => BrowserWindow | null): void {
  ipcMain.handle("forge:list-source-batches", async (): Promise<string[]> => {
    return listBatchFiles();
  });

  ipcMain.handle("forge:next-run-id", async (): Promise<string> => nextForgeRunId());

  ipcMain.handle(
    "forge:preview-source",
    async (_e, sourcePath: string): Promise<{ format: string; total: number; sample: unknown[]; errors: number }> => {
      const raw = await fs.readFile(sourcePath, "utf8");
      const { lines, errors } = parseAsChatML(raw);
      const sample = lines.slice(0, 3);
      return {
        format: "chatml",
        total: lines.length,
        sample,
        errors: errors.length,
      };
    }
  );

  ipcMain.handle(
    "forge:prepare",
    async (
      _e,
      args: { spec: unknown; sourcePath: string; trainRatio?: number; evalRatio?: number; seed?: number }
    ) => {
      const spec = ForgeSpecSchema.parse(args.spec);
      const dataDir = path.resolve("data");
      const workspaceDir = path.join(dataDir, "forge", spec.runId);
      const result = await prepareDataset({
        spec,
        sourceJsonl: args.sourcePath,
        workspaceDir,
        trainRatio: args.trainRatio,
        evalRatio: args.evalRatio,
        seed: args.seed,
      });

      const initialState: ForgeRunState = {
        runId: spec.runId,
        target: "bundle",
        spec,
        artifacts: {
          trainPath: result.trainPath,
          valPath: result.valPath,
          evalPath: result.evalPath,
          bundleDir: workspaceDir,
        },
        startedAt: new Date().toISOString(),
        status: "preparing",
      };
      await getForgeStore().save(spec.runId, initialState);
      return result;
    }
  );

  ipcMain.handle(
    "forge:generate-bundle",
    async (_e, args: { spec: unknown; runId: string; target: ForgeRunState["target"] }) => {
      const spec = ForgeSpecSchema.parse(args.spec);
      const dataDir = path.resolve("data");
      const workspaceDir = path.join(dataDir, "forge", args.runId);
      const result = await generateBundle({ spec, workspaceDir });

      const state = await getForgeStore().load(args.runId);
      if (state) {
        await getForgeStore().save(args.runId, {
          ...state,
          target: args.target,
          status: "submitted",
          artifacts: { ...state.artifacts, bundleDir: result.bundleDir },
        });
      }

      coordinator.reportBatchStart({
        batchId: args.runId,
        pipeline: "forge",
        startedAt: new Date().toISOString(),
        config: spec,
      });
      telemetry.logEvent({
        type: "forge.run.start",
        runId: args.runId,
        target: args.target,
        baseModel: spec.baseModel,
        method: spec.method,
      });

      return result;
    }
  );

  ipcMain.handle(
    "forge:gen-config",
    async (_e, args: { spec: unknown; kind: "unsloth" | "autotrain" | "axolotl" | "colab" }) => {
      const spec = ForgeSpecSchema.parse(args.spec);
      switch (args.kind) {
        case "unsloth":
          return { content: generateUnslothPython(spec), ext: "py" };
        case "autotrain":
          return { content: generateAutoTrainYaml(spec), ext: "yaml" };
        case "axolotl":
          return { content: generateAxolotlYaml(spec), ext: "yaml" };
        case "colab":
          return { content: JSON.stringify(generateColabNotebook(spec), null, 2), ext: "ipynb" };
      }
    }
  );

  ipcMain.handle("forge:open-bundle-folder", async (_e, runId: string) => {
    const dataDir = path.resolve("data");
    const dir = path.join(dataDir, "forge", runId);
    await electronShell.openPath(dir);
    return dir;
  });

  ipcMain.handle("forge:list-runs", async (): Promise<ForgeRunState[]> => {
    const items = await getForgeStore().scan().catch((err) => {
      console.error("[forge:list-runs] store scan failed:", err instanceof Error ? err.message : err);
      return [];
    });
    return items.map((i) => i.snapshot);
  });

  /** Активные local runners (один на runId). */
  const activeRunners = new Map<string, LocalRunner>();

  ipcMain.handle(
    "forge:start-local",
    async (_e, args: { runId: string; scriptWinPath: string; distro?: string }) => {
      if (activeRunners.has(args.runId)) {
        throw new Error(`Local runner for ${args.runId} already active`);
      }
      const runner = new LocalRunner();
      activeRunners.set(args.runId, runner);

      const win = getMainWindow();
      runner.on("metric", (m: TrainingMetric) => {
        if (win && !win.isDestroyed()) {
          win.webContents.send("forge:local-metric", { runId: args.runId, metric: m });
        }
      });
      runner.on("stdout", (line: string) => {
        if (win && !win.isDestroyed()) {
          win.webContents.send("forge:local-stdout", { runId: args.runId, line });
        }
      });
      runner.on("stderr", (line: string) => {
        if (win && !win.isDestroyed()) {
          win.webContents.send("forge:local-stderr", { runId: args.runId, line });
        }
      });
      runner.on("exit", (code: number | null) => {
        activeRunners.delete(args.runId);
        if (win && !win.isDestroyed()) {
          win.webContents.send("forge:local-exit", { runId: args.runId, code });
        }
      });
      runner.on("error", (err: Error) => {
        if (win && !win.isDestroyed()) {
          win.webContents.send("forge:local-error", { runId: args.runId, error: err.message });
        }
      });
      const prefs = await getPreferencesStore().getAll();
      runner.start({
        scriptWinPath: args.scriptWinPath,
        distro: args.distro ?? null,
        heartbeatMs: prefs.forgeHeartbeatMs,
        maxWallMs: prefs.forgeMaxWallMs,
      });
      return { ok: true };
    }
  );

  ipcMain.handle("forge:cancel-local", async (_e, runId: string): Promise<boolean> => {
    const runner = activeRunners.get(runId);
    if (!runner) return false;
    runner.cancel();
    activeRunners.delete(runId);
    return true;
  });

  ipcMain.handle(
    "forge:import-gguf",
    async (_e, args: { outputDir: string; modelKey: string }): Promise<{ destPath: string; copied: number }> => {
      return importGgufToLMStudio(args.outputDir, args.modelKey);
    }
  );

  ipcMain.handle(
    "forge:run-eval",
    async (
      _e,
      args: {
        evalPath: string;
        baseModel: string;
        tunedModel: string;
        judgeModel?: string;
        maxCases?: number;
      }
    ): Promise<EvalSummary> => {
      const raw = await fs.readFile(args.evalPath, "utf8");
      const { lines } = parseAsChatML(raw);
      const cases = chatMLToEvalCases(lines, args.maxCases || 20);

      const win = getMainWindow();
      return runEval({
        cases,
        baseModel: args.baseModel,
        tunedModel: args.tunedModel,
        judgeModel: args.judgeModel,
        chat: async (modelKey, messages) => {
          const reply = await chat({
            model: modelKey,
            messages: messages as Array<{ role: "system" | "user" | "assistant"; content: string }>,
            sampling: {
              temperature: 0.3,
              top_p: 0.9,
              top_k: 30,
              min_p: 0,
              presence_penalty: 0,
              max_tokens: 1024,
            },
          });
          return reply.content || "";
        },
        onProgress: (done, total) => {
          if (win && !win.isDestroyed()) {
            win.webContents.send("forge:eval-progress", { done, total });
          }
        },
      });
    }
  );

  ipcMain.handle("forge:mark-status", async (_e, args: { runId: string; status: ForgeRunState["status"] }) => {
    const state = await getForgeStore().load(args.runId);
    if (!state) return null;
    const next: ForgeRunState = {
      ...state,
      status: args.status,
      finishedAt: ["succeeded", "failed", "cancelled"].includes(args.status)
        ? new Date().toISOString()
        : state.finishedAt,
    };
    await getForgeStore().save(args.runId, next);
    if (next.status === "succeeded") {
      coordinator.reportBatchEnd(args.runId);
      const dur = Date.parse(next.finishedAt!) - Date.parse(next.startedAt);
      telemetry.logEvent({ type: "forge.run.success", runId: args.runId, durationMs: dur });
    } else if (next.status === "failed") {
      coordinator.reportBatchEnd(args.runId);
      telemetry.logEvent({
        type: "forge.run.fail",
        runId: args.runId,
        target: next.target,
        error: "marked failed by user",
      });
    } else if (next.status === "cancelled") {
      coordinator.reportBatchEnd(args.runId);
    }
    return next;
  });
}
