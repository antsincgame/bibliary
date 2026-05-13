/**
 * Server-side hardware profiler. Detects CPU / RAM / GPU for the host
 * running the backend (admin's NAS/VPS). Server-tier — no Electron deps,
 * pure Node.
 *
 * Returns "unknown" fields rather than throwing; UI must tolerate gaps.
 * Result is cached for an hour (hardware doesn't change at runtime).
 */

import { exec } from "node:child_process";
import * as os from "node:os";
import { promisify } from "node:util";

const execAsync = promisify(exec);
const EXEC_TIMEOUT_MS = 3_000;
const CACHE_TTL_MS = 60 * 60 * 1000;

export interface GpuInfo {
  name: string;
  vramGB: number | null;
  backend: "cuda" | "metal" | "rocm" | "unknown";
  cudaVersion?: string;
}

export interface HardwareInfo {
  os: { platform: NodeJS.Platform; release: string; arch: string };
  cpu: { model: string; cores: number; threads: number };
  ramGB: number;
  gpus: GpuInfo[];
  bestGpu: GpuInfo | null;
  detectedAt: string;
}

let cached: { info: HardwareInfo; at: number } | null = null;

export async function detectHardware(opts: { force?: boolean } = {}): Promise<HardwareInfo> {
  const now = Date.now();
  if (!opts.force && cached && now - cached.at < CACHE_TTL_MS) {
    return cached.info;
  }

  const info: HardwareInfo = {
    os: {
      platform: process.platform,
      release: os.release(),
      arch: process.arch,
    },
    cpu: detectCpu(),
    ramGB: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
    gpus: await detectGpus(),
    bestGpu: null,
    detectedAt: new Date().toISOString(),
  };

  info.bestGpu = pickBestGpu(info.gpus);
  cached = { info, at: now };
  return info;
}

export function resetHardwareCacheForTesting(): void {
  cached = null;
}

function detectCpu(): HardwareInfo["cpu"] {
  const cpus = os.cpus();
  return {
    model: cpus[0]?.model.trim() ?? "unknown",
    cores: Math.max(1, Math.floor(cpus.length / 2)),
    threads: cpus.length,
  };
}

async function detectGpus(): Promise<GpuInfo[]> {
  switch (process.platform) {
    case "linux":
      return detectNvidiaLinux();
    case "darwin":
      return detectMacGpu();
    case "win32":
      return detectNvidiaWindows();
    default:
      return [];
  }
}

async function detectNvidiaLinux(): Promise<GpuInfo[]> {
  try {
    const { stdout } = await execAsync(
      "nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits",
      { timeout: EXEC_TIMEOUT_MS },
    );
    return stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [name, vramMB] = line.split(",").map((s) => s.trim());
        const vramGB = vramMB ? Math.round((Number(vramMB) / 1024) * 10) / 10 : null;
        return {
          name: name ?? "unknown",
          vramGB,
          backend: "cuda" as const,
        };
      });
  } catch {
    return [];
  }
}

async function detectNvidiaWindows(): Promise<GpuInfo[]> {
  return detectNvidiaLinux();
}

async function detectMacGpu(): Promise<GpuInfo[]> {
  try {
    const { stdout } = await execAsync(
      "system_profiler SPDisplaysDataType -json",
      { timeout: EXEC_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
    );
    const parsed = JSON.parse(stdout) as {
      SPDisplaysDataType?: Array<{
        sppci_model?: string;
        spdisplays_vram?: string;
      }>;
    };
    const list = parsed.SPDisplaysDataType ?? [];
    return list.map((entry) => ({
      name: entry.sppci_model ?? "Apple GPU",
      vramGB: parseAppleVram(entry.spdisplays_vram),
      backend: "metal" as const,
    }));
  } catch {
    return [];
  }
}

function parseAppleVram(raw: string | undefined): number | null {
  if (!raw) return null;
  const m = /(\d+(?:\.\d+)?)\s*(GB|MB)/i.exec(raw);
  if (!m) return null;
  const value = Number(m[1]);
  return m[2]?.toUpperCase() === "GB" ? value : Math.round((value / 1024) * 10) / 10;
}

function pickBestGpu(gpus: GpuInfo[]): GpuInfo | null {
  if (gpus.length === 0) return null;
  return gpus.reduce((best, g) => {
    if (!best) return g;
    if ((g.vramGB ?? 0) > (best.vramGB ?? 0)) return g;
    return best;
  });
}
