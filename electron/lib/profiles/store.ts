/**
 * ProfileStore — хранилище профилей моделей и hardware-presets.
 *
 * Заменяет hardcoded `PROFILE` из electron/lmstudio-client.ts. Профили хранятся
 * в data/profiles.json через atomic-write + lockfile. Defaults seed-ятся при
 * первом запуске из electron/defaults/profiles.json (если есть) или из старого
 * жёсткого PROFILE.
 *
 * Почему отдельно от prompts/store: prompts — это текст/markdown и рассчитан
 * на ручное редактирование пользователем, профили — это конфиг с жёсткой
 * Zod-схемой и UI-формой.
 */

import { promises as fs } from "fs";
import * as path from "path";
import { z } from "zod";

import { writeJsonAtomic, withFileLock } from "../resilience";

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

export const ProfileSchema = z.object({
  /** Стабильный идентификатор профиля. Например "BIG", "SMALL", "qwen-14b-coder". */
  id: z.string().min(1).max(64),
  /** UI-метка. */
  label: z.string().min(1).max(128),
  /** Ключ модели в LM Studio (что лежит в .cache/lm-studio/models). */
  modelKey: z.string().min(1).max(256),
  /** Квантизация для отображения (Q4_K_M, Q8_0, bf16 и т.д.). */
  quant: z.string().min(1).max(32),
  /** Размер на диске (GB), для UI badge. */
  sizeGB: z.number().min(0).max(2048),
  /** Минимально требуемый VRAM (GB) для inference. */
  minVramGB: z.number().min(0).max(2048),
  /** Capabilities tags (vision, tool, reasoning, ...). */
  capabilities: z.array(z.string().min(1).max(32)).max(16),
  /** TTL кеша модели в LM Studio (секунды). */
  ttlSec: z.number().int().min(0).max(86400),
  /** Дефолтный контекст. Может быть переопределён через YaRN. */
  defaultContextLength: z.number().int().min(512).max(2_000_000).default(32768),
  /** Built-in профиль (BIG/SMALL) — не удаляется из UI. */
  builtin: z.boolean().default(false),
});

export type Profile = z.infer<typeof ProfileSchema>;

export const ProfilesFileSchema = z.object({
  version: z.literal(1),
  profiles: z.array(ProfileSchema),
});

export type ProfilesFile = z.infer<typeof ProfilesFileSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Default profiles — seed при первом запуске
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_PROFILES: Profile[] = [
  {
    id: "BIG",
    label: "Qwen3.6 35B-A3B (BIG)",
    modelKey: "qwen/qwen3.6-35b-a3b",
    quant: "Q4_K_M",
    sizeGB: 22.07,
    minVramGB: 24,
    capabilities: ["reasoning", "vision", "tool"],
    ttlSec: 1800,
    defaultContextLength: 32768,
    builtin: true,
  },
  {
    id: "SMALL",
    label: "Qwen3 4B-Instruct (SMALL)",
    modelKey: "qwen/qwen3-4b-2507",
    quant: "Q8_0",
    sizeGB: 4.28,
    minVramGB: 8,
    capabilities: ["tool"],
    ttlSec: 600,
    defaultContextLength: 32768,
    builtin: true,
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Store implementation
// ─────────────────────────────────────────────────────────────────────────────

export interface ProfileStoreOptions {
  /** Путь к data-папке (обычно `app.getPath("userData")/data`). */
  dataDir: string;
}

export class FsProfileStore {
  private readonly file: string;
  private cache: ProfilesFile | null = null;

  constructor(opts: ProfileStoreOptions) {
    this.file = path.join(opts.dataDir, "profiles.json");
  }

  /** Создаёт файл с defaults, если его нет. */
  async ensureDefaults(): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await withFileLock(this.file, async () => {
      try {
        const raw = await fs.readFile(this.file, "utf8");
        if (raw.trim()) return; // already there
      } catch {
        // ENOENT → seed
      }
      const seed: ProfilesFile = { version: 1, profiles: DEFAULT_PROFILES };
      await writeJsonAtomic(this.file, seed);
    });
  }

  async readAll(): Promise<Profile[]> {
    if (this.cache) return this.cache.profiles;
    try {
      const raw = await fs.readFile(this.file, "utf8");
      const parsed = ProfilesFileSchema.parse(JSON.parse(raw));
      this.cache = parsed;
      return parsed.profiles;
    } catch {
      return [...DEFAULT_PROFILES];
    }
  }

  async getById(id: string): Promise<Profile | null> {
    const all = await this.readAll();
    return all.find((p) => p.id === id) ?? null;
  }

  /** Создаёт или обновляет профиль. Builtin защищён от удаления, но редактируем. */
  async upsert(profile: Profile): Promise<void> {
    const validated = ProfileSchema.parse(profile);
    await withFileLock(this.file, async () => {
      const all = await this.readAll();
      const idx = all.findIndex((p) => p.id === validated.id);
      let next: Profile[];
      if (idx >= 0) {
        // Builtin поля не теряем
        next = [...all];
        next[idx] = { ...validated, builtin: all[idx]!.builtin || validated.builtin };
      } else {
        next = [...all, { ...validated, builtin: false }];
      }
      await writeJsonAtomic(this.file, { version: 1 as const, profiles: next });
      this.cache = { version: 1, profiles: next };
    });
  }

  async remove(id: string): Promise<void> {
    await withFileLock(this.file, async () => {
      const all = await this.readAll();
      const target = all.find((p) => p.id === id);
      if (!target) return;
      if (target.builtin) {
        throw new Error(`Cannot remove builtin profile: ${id}`);
      }
      const next = all.filter((p) => p.id !== id);
      await writeJsonAtomic(this.file, { version: 1 as const, profiles: next });
      this.cache = { version: 1, profiles: next };
    });
  }

  async resetToDefaults(): Promise<void> {
    await withFileLock(this.file, async () => {
      const seed: ProfilesFile = { version: 1, profiles: DEFAULT_PROFILES };
      await writeJsonAtomic(this.file, seed);
      this.cache = seed;
    });
  }

  /** Снять кеш — для тестов и редкого ручного reload. */
  invalidate(): void {
    this.cache = null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton
// ─────────────────────────────────────────────────────────────────────────────

let instance: FsProfileStore | null = null;

export function initProfileStore(opts: ProfileStoreOptions): FsProfileStore {
  instance = new FsProfileStore(opts);
  return instance;
}

export function getProfileStore(): FsProfileStore {
  if (!instance) throw new Error("ProfileStore not initialised. Call initProfileStore() in bootstrap.");
  return instance;
}
