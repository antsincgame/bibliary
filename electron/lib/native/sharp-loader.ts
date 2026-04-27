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

let sharpLoaded = false;

export async function loadSharp(): Promise<SharpFactory> {
  ensureSharpDllPath();
  const mod = await import("sharp");
  const sharpCtor = mod.default as unknown as SharpFactory & { simd?: (v: boolean) => boolean; cache?: (v: boolean | object) => object };
  if (!sharpLoaded) {
    sharpLoaded = true;
    /* Disable ORC/Highway SIMD — prevents access violations in libvips
       on Windows portable builds (orc_code_chunk_merge / GStreamer liborc bug).
       Also disable file caching to avoid EBUSY/EPERM on Windows.
       simd/cache are static methods on the Sharp constructor (mod.default). */
    if (typeof sharpCtor.simd === "function") sharpCtor.simd(false);
    if (typeof sharpCtor.cache === "function") sharpCtor.cache(false);
  }
  return sharpCtor;
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function isPngBuffer(buf: Buffer): boolean {
  if (buf.length < 8) return false;
  for (let i = 0; i < 8; i++) {
    if (buf[i] !== PNG_MAGIC[i]) return false;
  }
  return true;
}

export async function imageBufferToPng(input: Buffer, width?: number): Promise<Buffer> {
  const sharp = await loadSharp();
  const pipeline = sharp(input, { failOn: "truncated" });
  let result: Buffer;
  if (typeof width === "number" && Number.isFinite(width) && width > 0) {
    result = await pipeline.resize({ width, withoutEnlargement: true }).png().toBuffer();
  } else {
    result = await pipeline.png().toBuffer();
  }
  if (!isPngBuffer(result)) {
    throw new Error(`imageBufferToPng: output is not a valid PNG (got ${result.length} bytes, magic mismatch)`);
  }
  return result;
}
