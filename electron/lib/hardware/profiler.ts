/**
 * Hardware profiler — кросс-платформенный детект GPU / CPU / RAM / OS.
 *
 * Используется:
 *  - Welcome wizard (3.1) для подбора hardware-preset
 *  - Memory Forge (3.0) для VRAM-bar
 *  - Forge wizard (3.2) для VRAM-калькулятора
 *  - Models route для GPU offload рекомендаций
 *
 * Принципы:
 *  - Никогда не ломать UI — на любую ошибку возвращаем `unknown` поля
 *  - Кешируем результат (детект ≤ 1 раз в час, hardware не меняется)
 *  - Безопасный exec — все команды read-only, с timeout 3 сек
 */

import { exec } from "child_process";
import { promisify } from "util";
import * as os from "os";

const execAsync = promisify(exec);
const EXEC_TIMEOUT_MS = 3_000;

// ─────────────────────────────────────────────────────────────────────────────
// Типы
// ─────────────────────────────────────────────────────────────────────────────

export interface GpuInfo {
  name: string;
  /** VRAM в GB (округлено до 0.1). null если неизвестно. */
  vramGB: number | null;
  /** CUDA версия для NVIDIA, "metal" для Apple Silicon, "rocm" для AMD/Linux. */
  backend: "cuda" | "metal" | "rocm" | "unknown";
  cudaVersion?: string;
}

export interface HardwareInfo {
  os: { platform: NodeJS.Platform; release: string; arch: string };
  cpu: {
    model: string;
    cores: number;
    threads: number;
  };
  /** Total RAM в GB. */
  ramGB: number;
  /** Список GPU. На NVIDIA-ноутах с iGPU+dGPU будет 2 элемента. */
  gpus: GpuInfo[];
  /** Лучший GPU для inference: dedicated dGPU > iGPU. Null если нет GPU. */
  bestGpu: GpuInfo | null;
  /** ISO timestamp детекта. */
  detectedAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Кеш
// ─────────────────────────────────────────────────────────────────────────────

let cache: HardwareInfo | null = null;
let cacheAt = 0;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 час

// ─────────────────────────────────────────────────────────────────────────────
// Главный entry
// ─────────────────────────────────────────────────────────────────────────────

export async function detectHardware(opts?: { force?: boolean }): Promise<HardwareInfo> {
  if (!opts?.force && cache && Date.now() - cacheAt < CACHE_TTL_MS) return cache;

  const platform = process.platform;
  const cpus = os.cpus();
  const cpuModel = cpus[0]?.model ?? "unknown";
  const physicalCores = countPhysicalCores(cpus);

  const ramGB = round1(os.totalmem() / 1024 ** 3);
  const gpus = await detectGpus(platform);
  const bestGpu = pickBestGpu(gpus);

  const info: HardwareInfo = {
    os: { platform, release: os.release(), arch: os.arch() },
    cpu: { model: cpuModel.trim(), cores: physicalCores, threads: cpus.length },
    ramGB,
    gpus,
    bestGpu,
    detectedAt: new Date().toISOString(),
  };
  cache = info;
  cacheAt = Date.now();
  return info;
}

// ─────────────────────────────────────────────────────────────────────────────
// GPU detection per platform
// ─────────────────────────────────────────────────────────────────────────────

async function detectGpus(platform: NodeJS.Platform): Promise<GpuInfo[]> {
  // Сначала пробуем nvidia-smi (универсально для Win/Linux), потом platform-fallback.
  const nvidia = await tryNvidiaSmi();
  if (nvidia.length > 0) return nvidia;

  if (platform === "win32") return await detectGpusWindows();
  if (platform === "darwin") return await detectGpusMac();
  return [];
}

async function tryNvidiaSmi(): Promise<GpuInfo[]> {
  try {
    const { stdout } = await execAsync(
      "nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits",
      { timeout: EXEC_TIMEOUT_MS }
    );
    const cudaVersion = await readCudaVersion();
    const gpus: GpuInfo[] = [];
    for (const line of stdout.split(/\r?\n/)) {
      const row = line.trim();
      if (!row) continue;
      const parts = row.split(",").map((s) => s.trim());
      if (parts.length < 2) continue;
      const name = parts[0] || "NVIDIA GPU";
      const vramMB = Number(parts[1]);
      if (!Number.isFinite(vramMB)) continue;
      gpus.push({
        name,
        vramGB: round1(vramMB / 1024),
        backend: "cuda",
        cudaVersion,
      });
    }
    return gpus;
  } catch {
    return [];
  }
}

async function readCudaVersion(): Promise<string | undefined> {
  try {
    const { stdout } = await execAsync("nvidia-smi --query-gpu=driver_version --format=csv,noheader", {
      timeout: EXEC_TIMEOUT_MS,
    });
    const v = stdout.trim().split(/\r?\n/)[0];
    return v || undefined;
  } catch {
    return undefined;
  }
}

async function detectGpusWindows(): Promise<GpuInfo[]> {
  // Fallback через wmic (deprecated в Win11, но всё ещё работает на 11+).
  // На Win11 23H2+ wmic могут удалить — тогда fallback на PowerShell CIM.
  const tryOne = async (cmd: string): Promise<GpuInfo[]> => {
    const { stdout } = await execAsync(cmd, { timeout: EXEC_TIMEOUT_MS });
    const lines = stdout
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && !s.startsWith("Name") && !s.startsWith("AdapterRAM"));
    const gpus: GpuInfo[] = [];
    for (const line of lines) {
      // wmic-формат: "AdapterRAM Name"  →  "8589934592 NVIDIA GeForce RTX 3060"
      const m = line.match(/^(\d+)\s+(.+)$/);
      if (m) {
        const ram = Number(m[1]);
        const name = (m[2] || "").trim();
        gpus.push({
          name,
          vramGB: Number.isFinite(ram) && ram > 0 ? round1(ram / 1024 ** 3) : null,
          backend: detectBackend(name),
        });
      } else if (line.length > 0) {
        gpus.push({ name: line, vramGB: null, backend: detectBackend(line) });
      }
    }
    return gpus;
  };

  try {
    return await tryOne("wmic path win32_VideoController get Name,AdapterRAM /format:value");
  } catch {
    // Игнор → попробуем PowerShell
  }
  try {
    const { stdout } = await execAsync(
      'powershell -NoProfile -Command "Get-CimInstance Win32_VideoController | Select-Object -Property Name,AdapterRAM | ConvertTo-Json -Compress"',
      { timeout: EXEC_TIMEOUT_MS }
    );
    const parsed: unknown = JSON.parse(stdout || "[]");
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    return arr
      .filter((x): x is { Name: string; AdapterRAM: number } => typeof x === "object" && x != null)
      .map((x) => ({
        name: x.Name,
        vramGB: typeof x.AdapterRAM === "number" ? round1(x.AdapterRAM / 1024 ** 3) : null,
        backend: detectBackend(x.Name),
      }));
  } catch {
    return [];
  }
}

async function detectGpusMac(): Promise<GpuInfo[]> {
  try {
    const { stdout } = await execAsync("system_profiler SPDisplaysDataType -json", {
      timeout: EXEC_TIMEOUT_MS,
    });
    const parsed = JSON.parse(stdout) as { SPDisplaysDataType?: Array<Record<string, unknown>> };
    const arr = parsed.SPDisplaysDataType || [];
    const gpus: GpuInfo[] = [];
    for (const item of arr) {
      const name = String(item._name || item.sppci_model || "Apple GPU");
      // На M1/M2/M3 — unified memory; vram = total RAM (но это overestimate для inference).
      // Используем sppci_vram (если есть) или fallback на null.
      const vramRaw = String(item.sppci_vram || item.spdisplays_vram || "");
      const vramMatch = vramRaw.match(/(\d+)\s*GB/i);
      const vramGB = vramMatch ? Number(vramMatch[1]) : null;
      const isApple = /apple/i.test(name);
      gpus.push({
        name,
        vramGB: isApple ? round1(os.totalmem() / 1024 ** 3) : vramGB,
        backend: isApple ? "metal" : "unknown",
      });
    }
    return gpus;
  } catch {
    return [];
  }
}

function detectBackend(name: string): GpuInfo["backend"] {
  if (/nvidia|geforce|quadro|tesla|rtx|gtx/i.test(name)) return "cuda";
  if (/apple|m1|m2|m3|m4/i.test(name)) return "metal";
  if (/amd|radeon|instinct/i.test(name)) return "rocm";
  return "unknown";
}

function pickBestGpu(gpus: GpuInfo[]): GpuInfo | null {
  if (gpus.length === 0) return null;
  // Лучший = с наибольшим VRAM. Игнорируем iGPU (Intel HD, AMD Vega) если есть dGPU.
  const dedicated = gpus.filter((g) => g.backend === "cuda" || g.backend === "metal" || g.backend === "rocm");
  const pool = dedicated.length > 0 ? dedicated : gpus;
  return pool.reduce((best, cur) => {
    const bestV = best.vramGB ?? 0;
    const curV = cur.vramGB ?? 0;
    return curV > bestV ? cur : best;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function countPhysicalCores(cpus: os.CpuInfo[]): number {
  // os.cpus() возвращает logical threads. Для оценки физических ядер делим на 2 на x86 HT,
  // на ARM просто возвращаем total. Это лучшее приближение без нативных libs.
  if (process.arch === "arm" || process.arch === "arm64") return cpus.length;
  return Math.max(1, Math.round(cpus.length / 2));
}
