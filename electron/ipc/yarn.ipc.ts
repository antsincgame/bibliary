import { ipcMain } from "electron";
import {
  recommend as yarnRecommend,
  applyRopeScaling,
  revertRopeScaling,
  readCurrentRopeScaling,
  hasBackup as yarnHasBackup,
  buildSuggestions,
  getModelArch,
  listKnownModels,
  type KVDtype,
} from "../lib/yarn/index.js";
import { telemetry } from "../lib/resilience/index.js";

export function registerYarnIpc(): void {
  ipcMain.handle(
    "yarn:recommend",
    async (
      _e,
      args: { modelKey: string; targetTokens: number; availableForKVGb?: number }
    ) => {
      const arch = getModelArch(args.modelKey);
      const recommendation = yarnRecommend({
        modelKey: args.modelKey,
        targetTokens: args.targetTokens,
        availableForKVGb: args.availableForKVGb,
      });
      const suggestions = buildSuggestions({
        arch,
        recommendation,
        availableForKVGb: args.availableForKVGb ?? null,
      });
      return { arch, recommendation, suggestions };
    }
  );

  ipcMain.handle("yarn:read-current", async (_e, modelKey: string) => {
    return readCurrentRopeScaling(modelKey);
  });

  ipcMain.handle(
    "yarn:apply",
    async (_e, args: { modelKey: string; targetTokens: number; kvDtype: KVDtype }) => {
      const arch = getModelArch(args.modelKey);
      const recommendation = yarnRecommend({
        modelKey: args.modelKey,
        targetTokens: args.targetTokens,
      });
      if (!recommendation.ropeScaling) {
        const reason = `YaRN not needed: target ${args.targetTokens} ≤ native ${arch.nativeTokens}`;
        telemetry.logEvent({ type: "yarn.error", modelKey: args.modelKey, error: reason });
        throw new Error(reason);
      }
      try {
        const result = await applyRopeScaling(args.modelKey, recommendation.ropeScaling);
        const kv = recommendation.kvVariants[args.kvDtype] ?? recommendation.kvVariants.fp16;
        telemetry.logEvent({
          type: "yarn.applied",
          modelKey: args.modelKey,
          factor: recommendation.ropeScaling.factor,
          kvDtype: args.kvDtype,
          vramEstimateGb: kv.gb,
        });
        return { ok: true as const, configPath: result.configPath, backupCreated: result.backupCreated };
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        telemetry.logEvent({ type: "yarn.error", modelKey: args.modelKey, error });
        throw err;
      }
    }
  );

  ipcMain.handle("yarn:revert", async (_e, modelKey: string) => {
    try {
      const result = await revertRopeScaling(modelKey);
      telemetry.logEvent({ type: "yarn.reverted", modelKey, reason: "user-requested" });
      return { ok: true as const, restored: result.restored, configRemoved: result.configRemoved };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      telemetry.logEvent({ type: "yarn.error", modelKey, error });
      throw err;
    }
  });

  ipcMain.handle("yarn:list-models", async () => {
    return listKnownModels().map((m) => ({
      modelKey: m.modelKey,
      displayName: m.displayName,
      nativeTokens: m.nativeTokens,
      yarnMaxTokens: m.yarnMaxTokens,
    }));
  });

  ipcMain.handle("yarn:has-backup", async (_e, modelKey: string) => yarnHasBackup(modelKey));
}
