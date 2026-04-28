/**
 * Arena ratings store — Elo ratings per role.
 *
 * Stored in `data/arena-ratings.json` via atomic write + lockfile from
 * resilience layer.
 */

import { promises as fs } from "fs";
import * as path from "path";
import { z } from "zod";

import { writeJsonAtomic, withFileLock } from "../../resilience/index.js";

const RatingsFileSchema = z.object({
  version: z.literal(1),
  roles: z.record(z.string(), z.record(z.string(), z.number())).default({}),
  lastCycleAt: z.string().optional(),
  lastError: z.string().optional(),
});

export type ArenaRatingsFile = z.infer<typeof RatingsFileSchema>;

const DEFAULT_ELO = 1500;
const K_FACTOR = 32;

let filePath: string | null = null;

export function initArenaRatingsStore(dataDir: string): void {
  filePath = path.join(dataDir, "arena-ratings.json");
}

function resolvePath(): string | null {
  return filePath;
}

export async function readRatingsFile(): Promise<ArenaRatingsFile> {
  const fp = resolvePath();
  if (!fp) return { version: 1, roles: {} };
  try {
    const raw = await fs.readFile(fp, "utf8");
    return RatingsFileSchema.parse(JSON.parse(raw));
  } catch {
    return { version: 1, roles: {} };
  }
}

export async function saveRatingsFile(data: ArenaRatingsFile): Promise<void> {
  const fp = resolvePath();
  if (!fp) throw new Error("Arena ratings store not initialised");
  await withFileLock(fp, async () => {
    await writeJsonAtomic(fp, data);
  });
}

export async function recordMatch(role: string, winnerKey: string, loserKey: string): Promise<void> {
  if (winnerKey === loserKey) return;
  const fp = resolvePath();
  if (!fp) throw new Error("Arena ratings store not initialised");
  await withFileLock(fp, async () => {
    const cur = await readRatingsFile();
    if (!cur.roles[role]) cur.roles[role] = {};
    const r = cur.roles[role]!;
    const ra = r[winnerKey] ?? DEFAULT_ELO;
    const rb = r[loserKey] ?? DEFAULT_ELO;
    const ea = 1 / (1 + 10 ** ((rb - ra) / 400));
    const eb = 1 / (1 + 10 ** ((ra - rb) / 400));
    r[winnerKey] = ra + K_FACTOR * (1 - ea);
    r[loserKey] = rb + K_FACTOR * (0 - eb);
    cur.lastCycleAt = new Date().toISOString();
    delete cur.lastError;
    await writeJsonAtomic(fp, cur);
  });
}

export async function resetRatings(): Promise<void> {
  await saveRatingsFile({ version: 1, roles: {} });
}

export async function recordCycleError(message: string): Promise<void> {
  const fp = resolvePath();
  if (!fp) return;
  try {
    await withFileLock(fp, async () => {
      const cur = await readRatingsFile();
      cur.lastError = message;
      await writeJsonAtomic(fp, cur);
    });
  } catch { /* best-effort diagnostics */ }
}

export function _resetArenaRatingsStoreForTests(): void {
  filePath = null;
}

export function getDefaultElo(): number {
  return DEFAULT_ELO;
}
