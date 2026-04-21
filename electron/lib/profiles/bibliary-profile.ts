/**
 * bibliary-profile.json — экспорт/импорт настроек между машинами и для команд.
 *
 * Содержит: env-переменные, custom профили моделей, dataset roles overrides.
 * Не содержит: HF/OpenAI tokens (они в OS keychain через safeStorage).
 *
 * Формат: один JSON-файл, версионированный, валидируемый Zod.
 */

import { promises as fs } from "fs";
import * as path from "path";
import { z } from "zod";

import { writeJsonAtomic } from "../resilience";
import { ProfileSchema, getProfileStore } from "./store";
import { getPromptStore } from "../prompts/store";

export const BibliaryProfileSchema = z.object({
  $schema: z.string().default("bibliary-profile/v1"),
  exportedAt: z.string(),
  exportedFrom: z.object({
    platform: z.string(),
    arch: z.string(),
    version: z.string(),
  }),
  /** Подсказки для подсказок UI на новой машине, не secrets. */
  envHints: z.object({
    lmStudioUrl: z.string().optional(),
    qdrantUrl: z.string().optional(),
  }),
  profiles: z.array(ProfileSchema),
  /** Dataset roles JSON (если правились). */
  datasetRoles: z.unknown().optional(),
});

export type BibliaryProfileFile = z.infer<typeof BibliaryProfileSchema>;

export interface ExportOptions {
  appVersion?: string;
}

export async function exportBibliaryProfile(
  destPath: string,
  opts: ExportOptions = {}
): Promise<BibliaryProfileFile> {
  const profiles = await getProfileStore().readAll();
  const promptStore = getPromptStore();
  const datasetRoles = await promptStore.readDatasetRoles().catch(() => null);

  const file: BibliaryProfileFile = {
    $schema: "bibliary-profile/v1",
    exportedAt: new Date().toISOString(),
    exportedFrom: {
      platform: process.platform,
      arch: process.arch,
      version: opts.appVersion || "unknown",
    },
    envHints: {
      lmStudioUrl: process.env.LM_STUDIO_URL || undefined,
      qdrantUrl: process.env.QDRANT_URL || undefined,
    },
    profiles,
    ...(datasetRoles ? { datasetRoles } : {}),
  };
  await writeJsonAtomic(destPath, file);
  return file;
}

export interface ImportSummary {
  profilesUpserted: number;
  rolesImported: boolean;
  warnings: string[];
}

export async function importBibliaryProfile(srcPath: string): Promise<ImportSummary> {
  const raw = await fs.readFile(srcPath, "utf8");
  const parsed = BibliaryProfileSchema.parse(JSON.parse(raw));
  const warnings: string[] = [];

  const store = getProfileStore();
  let profilesUpserted = 0;
  for (const p of parsed.profiles) {
    if (p.builtin) {
      // Builtin не импортируем — они должны браться из defaults.
      continue;
    }
    try {
      await store.upsert(p);
      profilesUpserted++;
    } catch (e) {
      warnings.push(`profile "${p.id}": ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  let rolesImported = false;
  if (parsed.datasetRoles) {
    try {
      const promptStore = getPromptStore();
      await promptStore.writeDatasetRoles(parsed.datasetRoles as never);
      rolesImported = true;
    } catch (e) {
      warnings.push(`datasetRoles: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return { profilesUpserted, rolesImported, warnings };
}

export function defaultExportFilename(): string {
  const ts = new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15);
  return `bibliary-profile-${ts}.json`;
}

/** @internal — для тестов */
export function getDefaultExportPath(dataDir: string): string {
  return path.join(dataDir, "exports", defaultExportFilename());
}
