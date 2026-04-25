import * as path from "path";
import { createRequire } from "module";
import { existsSync, readdirSync } from "fs";

type SharpFactory = (input: Buffer, options?: { failOn?: string }) => {
  resize: (options: { width?: number; withoutEnlargement?: boolean }) => {
    png: () => { toBuffer: () => Promise<Buffer> };
  };
  png: () => { toBuffer: () => Promise<Buffer> };
};

function collectSharpLibDirs(vendorBase: string): string[] {
  if (!existsSync(vendorBase)) return [];
  const dirs: string[] = [];
  for (const version of readdirSync(vendorBase, { withFileTypes: true })) {
    if (!version.isDirectory()) continue;
    const versionDir = path.join(vendorBase, version.name);
    for (const platform of readdirSync(versionDir, { withFileTypes: true })) {
      if (!platform.isDirectory()) continue;
      const libDir = path.join(versionDir, platform.name, "lib");
      if (existsSync(libDir)) dirs.push(libDir);
    }
  }
  return dirs;
}

export function ensureSharpDllPath(): void {
  if (process.platform !== "win32") return;
  const candidates: string[] = [];

  try {
    const req = createRequire(__filename);
    const sharpEntry = req.resolve("sharp");
    candidates.push(path.join(path.dirname(sharpEntry), "vendor"));
  } catch {
    /* sharp resolution failure will surface during import */
  }

  if (typeof process.resourcesPath === "string") {
    candidates.push(path.join(process.resourcesPath, "app.asar.unpacked", "node_modules", "sharp", "vendor"));
  }
  candidates.push(path.join(process.cwd(), "node_modules", "sharp", "vendor"));

  for (const vendorBase of candidates) {
    for (const libDir of collectSharpLibDirs(vendorBase)) {
      if (!process.env.PATH?.includes(libDir)) {
        process.env.PATH = libDir + path.delimiter + (process.env.PATH ?? "");
      }
      return;
    }
  }
}

export async function loadSharp(): Promise<SharpFactory> {
  ensureSharpDllPath();
  const mod = await import("sharp");
  return mod.default as unknown as SharpFactory;
}

export async function imageBufferToPng(input: Buffer, width?: number): Promise<Buffer> {
  const sharp = await loadSharp();
  const pipeline = sharp(input, { failOn: "none" });
  if (typeof width === "number" && Number.isFinite(width) && width > 0) {
    return pipeline.resize({ width, withoutEnlargement: true }).png().toBuffer();
  }
  return pipeline.png().toBuffer();
}
