import { promises as fs } from "fs";
import * as path from "path";
import { z } from "zod";
import { withFileLock } from "../resilience/file-lock";
import { writeJsonAtomic, writeTextAtomic } from "../resilience/atomic-write";

const SamplingPartialSchema = z
  .object({
    temperature: z.number().optional(),
    top_p: z.number().optional(),
    top_k: z.number().optional(),
    min_p: z.number().optional(),
    presence_penalty: z.number().optional(),
    max_tokens: z.number().optional(),
  })
  .strict();

const RoleSchema = z.object({
  role: z.string(),
  system: z.string(),
  voice: z.string(),
  format: z.string(),
  exemplar: z.string(),
  anti_examples: z.array(z.string()),
  sampling: SamplingPartialSchema,
});

export const DatasetRolesSchema = z.object({
  T1: RoleSchema,
  T2: RoleSchema,
  T3: RoleSchema,
});

export type DatasetRoleSpec = z.infer<typeof RoleSchema>;
export type DatasetRoles = z.infer<typeof DatasetRolesSchema>;

export const MechanicusGrammarSchema = z.object({
  domains: z.array(z.string()).min(1),
  operators: z.record(z.string()),
  abbreviations: z.record(z.string()),
  principle: z.object({ minLength: z.number(), maxLength: z.number() }),
  explanation: z.object({ minLength: z.number(), maxLength: z.number() }),
});

export type MechanicusGrammar = z.infer<typeof MechanicusGrammarSchema>;

export type PromptFile = "grammar" | "dataset-roles";

const FILES: Record<PromptFile, string> = {
  grammar: "mechanicus-grammar.json",
  "dataset-roles": "dataset-roles.json",
};

export interface PromptStoreOptions {
  dataDir: string;
  defaultsDir: string;
}

export class FsPromptStore {
  private readonly dataDir: string;
  private readonly defaultsDir: string;

  constructor(opts: PromptStoreOptions) {
    this.dataDir = path.resolve(opts.dataDir);
    this.defaultsDir = path.resolve(opts.defaultsDir);
  }

  async ensureDefaults(): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true });
    for (const file of Object.values(FILES)) {
      const target = path.join(this.dataDir, file);
      // Lock на целевой файл — два параллельных процесса (UI + CLI) при первом
      // запуске не должны одновременно делать tmp+rename на один путь.
      await withFileLock(target, async () => {
        try {
          await fs.access(target);
          return;
        } catch {
          // continue → seed
        }
        const source = path.join(this.defaultsDir, file);
        const content = await fs.readFile(source, "utf8");
        await writeTextAtomic(target, content);
      });
    }
  }

  async resetToDefaults(file: PromptFile): Promise<void> {
    const target = path.join(this.dataDir, FILES[file]);
    const source = path.join(this.defaultsDir, FILES[file]);
    const content = await fs.readFile(source, "utf8");
    await withFileLock(target, async () => {
      await writeTextAtomic(target, content);
    });
  }

  async readGrammar(): Promise<MechanicusGrammar> {
    const raw = await this.readJson("grammar");
    return MechanicusGrammarSchema.parse(raw);
  }

  async writeGrammar(value: MechanicusGrammar): Promise<void> {
    MechanicusGrammarSchema.parse(value);
    await this.writeJson("grammar", value);
  }

  async readDatasetRoles(): Promise<DatasetRoles> {
    const raw = await this.readJson("dataset-roles");
    return DatasetRolesSchema.parse(raw);
  }

  async writeDatasetRoles(value: DatasetRoles): Promise<void> {
    DatasetRolesSchema.parse(value);
    await this.writeJson("dataset-roles", value);
  }

  private async readJson(file: PromptFile): Promise<unknown> {
    const target = path.join(this.dataDir, FILES[file]);
    const raw = await fs.readFile(target, "utf8");
    return JSON.parse(raw);
  }

  private async writeJson(file: PromptFile, value: unknown): Promise<void> {
    const target = path.join(this.dataDir, FILES[file]);
    await withFileLock(target, async () => {
      await writeJsonAtomic(target, value);
    });
  }
}

let singleton: FsPromptStore | null = null;

export function initPromptStore(opts: PromptStoreOptions): FsPromptStore {
  singleton = new FsPromptStore(opts);
  return singleton;
}

export function getPromptStore(): FsPromptStore {
  if (!singleton) {
    throw new Error("PromptStore not initialized. Call initPromptStore() in bootstrap.");
  }
  return singleton;
}
