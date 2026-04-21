/**
 * PreferencesStore -- user-tunable constants backed by data/preferences.json.
 *
 * Pattern: same as ProfileStore (Zod schema, atomic write, lockfile, singleton).
 * Every constant has a sensible default; the file only stores overrides.
 * UI mode (Simple/Advanced/Pro) controls which settings are exposed, not stored.
 */

import { promises as fs } from "fs";
import * as path from "path";
import { z } from "zod";

import { writeJsonAtomic, withFileLock } from "../resilience";

// ---------------------------------------------------------------------------
// Schema -- every field is optional (missing = use default)
// ---------------------------------------------------------------------------

export const PreferencesSchema = z.object({
  // -- RAG & Chat --
  ragTopK: z.number().int().min(1).max(100).default(15),
  ragScoreThreshold: z.number().min(0).max(1).default(0.55),
  chatTemperature: z.number().min(0).max(2).default(0.7),
  chatTopP: z.number().min(0).max(1).default(0.8),
  chatMaxTokens: z.number().int().min(256).max(131072).default(16384),

  // -- Scanner / Ingest --
  ingestParallelism: z.number().int().min(1).max(16).default(3),
  ingestUpsertBatch: z.number().int().min(1).max(256).default(32),
  maxBookChars: z.number().int().min(100_000).max(50_000_000).default(5_000_000),

  // -- Semantic Chunker (Crystal) --
  chunkSafeLimit: z.number().int().min(500).max(20_000).default(4000),
  chunkMinWords: z.number().int().min(50).max(2000).default(300),
  driftThreshold: z.number().min(0).max(1).default(0.45),
  maxParagraphsForDrift: z.number().int().min(100).max(5000).default(800),
  overlapParagraphs: z.number().int().min(0).max(10).default(1),

  // -- Judge & Dedup --
  judgeScoreThreshold: z.number().min(0).max(1).default(0.6),
  crossLibDupeThreshold: z.number().min(0).max(1).default(0.85),
  intraDedupThreshold: z.number().min(0).max(1).default(0.88),

  // -- Resilience / Timeouts --
  policyMaxRetries: z.number().int().min(0).max(20).default(3),
  policyBaseBackoffMs: z.number().int().min(100).max(30_000).default(1000),
  hardTimeoutCapMs: z.number().int().min(30_000).max(3_600_000).default(600_000),

  // -- Resilience / File locks (Phase 2.5R) --
  lockRetries: z.number().int().min(0).max(20).default(5),
  lockStaleMs: z.number().int().min(1_000).max(60_000).default(10_000),

  // -- Resilience / LM Studio watchdog (Phase 2.5R) --
  healthPollIntervalMs: z.number().int().min(1_000).max(60_000).default(5_000),
  healthFailThreshold: z.number().int().min(1).max(20).default(3),
  watchdogLivenessTimeoutMs: z.number().int().min(500).max(15_000).default(3_000),

  // -- Forge --
  forgeHeartbeatMs: z.number().int().min(60_000).max(7_200_000).default(1_800_000),
  forgeMaxWallMs: z.number().int().min(3_600_000).max(172_800_000).default(43_200_000),

  // -- BookHunter --
  searchPerSourceLimit: z.number().int().min(1).max(50).default(6),
  downloadMaxRetries: z.number().int().min(1).max(10).default(3),

  // -- Qdrant --
  qdrantTimeoutMs: z.number().int().min(1000).max(60_000).default(8000),
  qdrantSearchLimit: z.number().int().min(1).max(100).default(12),

  // -- UI --
  refreshIntervalMs: z.number().int().min(2000).max(60_000).default(7000),
  toastTtlMs: z.number().int().min(1000).max(30_000).default(5000),
  spinDurationMs: z.number().int().min(100).max(3000).default(600),
  resilienceBarHideDelayMs: z.number().int().min(1000).max(30_000).default(4000),

  // -- OCR (Phase 6.0, OS-native via @napi-rs/system-ocr) --
  ocrEnabled: z.boolean().default(false),
  ocrLanguages: z.array(z.string().min(2).max(10)).max(8).default([]),
  ocrAccuracy: z.enum(["fast", "accurate"]).default("accurate"),
  ocrPdfDpi: z.number().int().min(100).max(400).default(200),

  // -- Library UI --
  libraryGroupBy: z.enum(["none", "ext", "status", "folder"]).default("none"),
});

export type Preferences = z.infer<typeof PreferencesSchema>;

export const DEFAULTS: Preferences = PreferencesSchema.parse({});

export const PreferencesFileSchema = z.object({
  version: z.literal(1),
  prefs: PreferencesSchema.partial(),
});

export type PreferencesFile = z.infer<typeof PreferencesFileSchema>;

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class FsPreferencesStore {
  private readonly file: string;
  private cache: PreferencesFile | null = null;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, "preferences.json");
  }

  async ensureDefaults(): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    try {
      const raw = await fs.readFile(this.file, "utf8");
      if (raw.trim()) return;
    } catch { /* ENOENT */ }
    await writeJsonAtomic(this.file, { version: 1 as const, prefs: {} });
  }

  async getAll(): Promise<Preferences> {
    const overrides = await this.readOverrides();
    return { ...DEFAULTS, ...overrides };
  }

  async get<K extends keyof Preferences>(key: K): Promise<Preferences[K]> {
    const all = await this.getAll();
    return all[key];
  }

  async set(partial: Partial<Preferences>): Promise<Preferences> {
    await withFileLock(this.file, async () => {
      const overrides = await this.readOverrides();
      const merged = { ...overrides, ...partial };
      const validated = PreferencesSchema.partial().parse(merged);
      const file: PreferencesFile = { version: 1, prefs: validated };
      await writeJsonAtomic(this.file, file);
      this.cache = file;
    });
    return this.getAll();
  }

  async reset(): Promise<Preferences> {
    await withFileLock(this.file, async () => {
      const file: PreferencesFile = { version: 1, prefs: {} };
      await writeJsonAtomic(this.file, file);
      this.cache = file;
    });
    return DEFAULTS;
  }

  invalidate(): void {
    this.cache = null;
  }

  private async readOverrides(): Promise<Partial<Preferences>> {
    if (this.cache) return this.cache.prefs;
    try {
      const raw = await fs.readFile(this.file, "utf8");
      const parsed = PreferencesFileSchema.parse(JSON.parse(raw));
      this.cache = parsed;
      return parsed.prefs;
    } catch {
      return {};
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let instance: FsPreferencesStore | null = null;

export function initPreferencesStore(dataDir: string): FsPreferencesStore {
  instance = new FsPreferencesStore(dataDir);
  return instance;
}

export function getPreferencesStore(): FsPreferencesStore {
  if (!instance) throw new Error("PreferencesStore not initialised. Call initPreferencesStore() in bootstrap.");
  return instance;
}
