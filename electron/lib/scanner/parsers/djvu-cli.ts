import { promises as fs } from "fs";
import * as path from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { execFile as _execFile } from "child_process";
import { promisify } from "util";

const execFile = promisify(_execFile);

export interface DjvuToolResolution {
  binary: string;
  bundledRoot?: string;
}

function candidateRoots(): string[] {
  const roots = new Set<string>();
  const cwd = process.cwd();
  roots.add(path.join(cwd, "vendor", "djvulibre", "win32-x64"));
  roots.add(path.join(cwd, "vendor", "djvulibre"));
  if (process.resourcesPath) {
    roots.add(path.join(process.resourcesPath, "vendor", "djvulibre", "win32-x64"));
    roots.add(path.join(process.resourcesPath, "vendor", "djvulibre"));
  }
  return [...roots];
}

function binaryCandidates(name: string): string[] {
  if (process.platform === "win32") return [`${name}.exe`, name];
  return [name];
}

async function locateBundledBinary(name: string): Promise<DjvuToolResolution | null> {
  for (const root of candidateRoots()) {
    for (const file of binaryCandidates(name)) {
      const full = path.join(root, file);
      try {
        await fs.access(full);
        return { binary: full, bundledRoot: root };
      } catch {
        // continue
      }
    }
  }
  return null;
}

async function resolveBinary(name: string): Promise<DjvuToolResolution> {
  const bundled = await locateBundledBinary(name);
  if (bundled) return bundled;
  return { binary: name };
}

function ensureNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("djvu operation aborted");
}

async function runBinary(binary: string, args: string[], signal?: AbortSignal): Promise<{ stdout: Buffer; stderr: Buffer }> {
  ensureNotAborted(signal);
  const { stdout, stderr } = await execFile(binary, args, {
    signal,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
    encoding: "buffer",
  });
  return { stdout, stderr };
}

export async function runDjvutxt(filePath: string, signal?: AbortSignal): Promise<string> {
  const tool = await resolveBinary("djvutxt");
  const { stdout } = await runBinary(tool.binary, [filePath], signal);
  return stdout.toString("utf8").trim();
}

export async function getDjvuPageCount(filePath: string, signal?: AbortSignal): Promise<number> {
  const tool = await resolveBinary("djvused");
  const { stdout } = await runBinary(tool.binary, [filePath, "-e", "n"], signal);
  const value = Number.parseInt(stdout.toString("utf8").trim(), 10);
  if (!Number.isFinite(value) || value <= 0) return 1;
  return value;
}

export async function runDdjvu(filePath: string, pageIndex: number, dpi: number, signal?: AbortSignal): Promise<Buffer> {
  const tool = await resolveBinary("ddjvu");
  const out = path.join(tmpdir(), `bibliary-djvu-${randomUUID()}.tif`);
  const page = Math.max(1, pageIndex + 1);
  try {
    await runBinary(tool.binary, ["-format=tiff", `-page=${page}`, `-dpi=${Math.max(72, dpi)}`, filePath, out], signal);
    return await fs.readFile(out);
  } finally {
    await fs.unlink(out).catch((err) => console.error("[djvu-cli/renderPage] unlink Error:", err));
  }
}

export function getDjvuInstallHint(): string {
  if (process.platform === "win32") {
    return "Install DjVuLibre or keep bundled binaries (djvutxt.exe/ddjvu.exe/djvused.exe) in vendor/djvulibre/win32-x64";
  }
  if (process.platform === "darwin") return "Install DjVuLibre: brew install djvulibre";
  return "Install DjVuLibre package (e.g. apt install djvulibre-bin)";
}
