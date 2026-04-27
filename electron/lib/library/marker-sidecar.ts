/**
 * Marker Sidecar — layout-aware PDF/DJVU extraction via WSL Python.
 *
 * Marker (github.com/VikParuchuri/marker, Apache 2.0) uses Surya OCR + Texify
 * for accurate layout detection, reading-order, table and equation extraction.
 *
 * Architecture:
 *   Windows Electron ──spawn──► wsl.exe marker_single <pdf> <outdir>
 *                                         │
 *                              output_dir/
 *                                ├── {stem}.md        ← structured Markdown
 *                                └── {stem}/          ← figures as PNG files
 *                                      ├── figure-0.png
 *                                      └── ...
 *
 * The sidecar is OPTIONAL: if WSL or marker is not available, callers fall
 * back to the existing pdfjs/ddjvu extractor. Controlled by:
 *   - ENV BIBLIARY_USE_MARKER=1
 *   - The WSL default distro must have marker_single on PATH
 *     (bootstrap via scripts/bootstrap-marker.ps1)
 */

import { promises as fs } from "fs";
import * as path from "path";
import * as os from "os";
import { execFile } from "child_process";
import { promisify } from "util";
import { toWslPath } from "../forge/wsl.js";
import type { ImageRef } from "./types.js";

const execFileAsync = promisify(execFile);

/** Maximum time (ms) to wait for Marker to convert a single document. */
const MARKER_TIMEOUT_MS = 5 * 60_000; // 5 minutes

/** Maximum figures to import per book (prevents OOM on massive docs). */
const MAX_FIGURES = 50;

export interface MarkerResult {
  markdown: string;
  images: ImageRef[];
  warnings: string[];
}

/**
 * Returns true if the Marker sidecar is enabled.
 *
 * Source of truth: process.env.BIBLIARY_USE_MARKER ("1"/"true" = enabled).
 * The preferences IPC handler syncs the `useMarkerExtractor` preference to
 * this ENV variable at startup and when the user changes the setting.
 */
export function isMarkerEnabled(): boolean {
  if (process.platform !== "win32") return false;
  const env = process.env.BIBLIARY_USE_MARKER?.trim();
  return env === "1" || env?.toLowerCase() === "true";
}

/**
 * Sync the `useMarkerExtractor` preference to the BIBLIARY_USE_MARKER ENV.
 * Call this at app bootstrap and after every preferences save.
 */
export function syncMarkerEnvFromPrefs(useMarker: boolean): void {
  process.env.BIBLIARY_USE_MARKER = useMarker ? "1" : "0";
  /* Reset availability cache so next isMarkerAvailable() re-probes WSL. */
  markerAvailableCache = null;
}

/**
 * Probe whether marker_single is actually installed in WSL.
 * Returns true/false. Caches the result for the process lifetime.
 */
let markerAvailableCache: boolean | null = null;

export async function isMarkerAvailable(): Promise<boolean> {
  if (!isMarkerEnabled()) return false;
  if (markerAvailableCache !== null) return markerAvailableCache;
  try {
    await execFileAsync("wsl.exe", ["--", "bash", "-c",
      "source ~/.bibliary-tools/marker-venv/bin/activate 2>/dev/null && marker_single --version"
    ], { timeout: 10_000 });
    markerAvailableCache = true;
  } catch {
    markerAvailableCache = false;
  }
  return markerAvailableCache;
}

/** Reset availability cache (for tests or after bootstrap). */
export function resetMarkerAvailabilityCache(): void {
  markerAvailableCache = null;
}

/**
 * Run Marker on a PDF file (Windows path) via WSL.
 * Returns structured markdown + extracted figure ImageRefs.
 *
 * @param pdfPath Absolute Windows path to the PDF file.
 * @param signal  AbortSignal to cancel the conversion.
 */
export async function runMarkerOnPdf(
  pdfPath: string,
  signal?: AbortSignal,
): Promise<MarkerResult> {
  const warnings: string[] = [];

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "bibliary-marker-"));
  try {
    const wslPdf = toWslPath(pdfPath);
    const wslOut = toWslPath(tmpDir);

    const activateCmd = "source ~/.bibliary-tools/marker-venv/bin/activate 2>/dev/null";
    /* marker_single <input> <output_dir> --langs <langs>
       Output: <output_dir>/<stem>/<stem>.md + <output_dir>/<stem>/images/*.png
       (No --output_format flag — Marker always outputs markdown) */
    const markerCmd = `marker_single "${wslPdf}" "${wslOut}" --languages en,ru`;

    const { stderr } = await execFileAsync(
      "wsl.exe",
      ["--", "bash", "-c", `${activateCmd} && ${markerCmd}`],
      {
        timeout: MARKER_TIMEOUT_MS,
        signal: signal as AbortSignal | undefined,
        maxBuffer: 50 * 1024 * 1024,
      }
    );

    if (stderr && stderr.length > 0) {
      const errLines = stderr.split(/\r?\n/).filter((l) => l.trim().length > 0);
      for (const l of errLines.slice(0, 5)) {
        warnings.push(`marker: ${l.trim()}`);
      }
    }

    /* Locate the output markdown file.
       marker_single outputs to: <output_dir>/<stem>/<stem>.md
       and images to: <output_dir>/<stem>/images/ (or <output_dir>/<stem>/ directly for older versions). */
    const stem = path.basename(pdfPath, path.extname(pdfPath));
    const stemDir = path.join(tmpDir, stem);
    const mdPath = path.join(stemDir, `${stem}.md`);
    let markdown = "";
    try {
      markdown = await fs.readFile(mdPath, "utf-8");
    } catch {
      /* Fallback: try flat layout <output_dir>/<stem>.md (older marker versions) */
      const flatMd = path.join(tmpDir, `${stem}.md`);
      try {
        markdown = await fs.readFile(flatMd, "utf-8");
      } catch {
        warnings.push(`marker: output MD not found at ${mdPath} or ${flatMd}`);
      }
    }

    /* Collect figure PNGs. Try <stemDir>/images/ first, then <stemDir>/ directly. */
    const images: ImageRef[] = [];
    const figCandidates = [path.join(stemDir, "images"), stemDir];

    for (const figDir of figCandidates) {
      try {
        const entries = await fs.readdir(figDir);
        const pngFiles = entries
          .filter((e) => /\.(png|jpg|jpeg)$/i.test(e))
          .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
          .slice(0, MAX_FIGURES - images.length);
        if (pngFiles.length === 0) continue;

        for (let i = 0; i < pngFiles.length; i++) {
          const figPath = path.join(figDir, pngFiles[i]);
          try {
            const buffer = await fs.readFile(figPath);
            const mimeType = pngFiles[i].toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
            const idx = images.length;
            const imgId = idx === 0 ? "img-cover" : `img-${String(idx).padStart(3, "0")}`;
            images.push({ id: imgId, mimeType, buffer, caption: `Figure ${idx + 1}` });
          } catch {
            warnings.push(`marker: could not read figure ${pngFiles[i]}`);
          }
        }
        break;
      } catch {
        /* directory doesn't exist — try next candidate */
      }
    }

    return { markdown, images, warnings };
  } finally {
    /* Clean up temp dir asynchronously — non-critical */
    fs.rm(tmpDir, { recursive: true, force: true }).catch(() => void 0);
  }
}

/**
 * Convert a DJVU file to PDF via ddjvu (available via djvulibre vendor),
 * then pass the PDF to Marker.
 *
 * @param djvuPath Absolute Windows path to the DJVU file.
 * @param signal   AbortSignal to cancel.
 */
export async function runMarkerOnDjvu(
  djvuPath: string,
  signal?: AbortSignal,
): Promise<MarkerResult> {
  const warnings: string[] = [];
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "bibliary-djvu-"));
  try {
    /* Locate ddjvu binary from vendor bundle */
    const ddjvuPath = resolveDdjvuBin();
    if (!ddjvuPath) {
      return { markdown: "", images: [], warnings: ["marker-djvu: ddjvu binary not found"] };
    }

    const pdfOut = path.join(tmpDir, "converted.pdf");

    /* ddjvu -format=pdf -quality=85 input.djvu output.pdf */
    await execFileAsync(
      ddjvuPath,
      ["-format=pdf", "-quality=85", "-verbose", djvuPath, pdfOut],
      { timeout: 3 * 60_000, signal: signal as AbortSignal | undefined }
    );

    /* Check output exists and has content */
    const stat = await fs.stat(pdfOut).catch(() => null);
    if (!stat || stat.size < 1024) {
      return { markdown: "", images: [], warnings: [`marker-djvu: ddjvu produced empty PDF (${stat?.size ?? 0} bytes)`] };
    }

    const result = await runMarkerOnPdf(pdfOut, signal);
    return { ...result, warnings: [...warnings, ...result.warnings] };
  } finally {
    fs.rm(tmpDir, { recursive: true, force: true }).catch(() => void 0);
  }
}

/**
 * Locate the ddjvu executable from the Electron vendor bundle or system PATH.
 */
function resolveDdjvuBin(): string | null {
  /* In packaged Electron: resources/vendor/djvulibre/win32-x64/ddjvu.exe */
  if (typeof process.resourcesPath === "string") {
    const vendorBin = path.join(
      process.resourcesPath, "vendor", "djvulibre", "win32-x64", "ddjvu.exe"
    );
    if (require("fs").existsSync(vendorBin)) return vendorBin;
  }
  /* Dev: project root vendor/ */
  const devBin = path.join(
    findProjectRoot(), "vendor", "djvulibre", "win32-x64", "ddjvu.exe"
  );
  if (require("fs").existsSync(devBin)) return devBin;
  return null;
}

function findProjectRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    if (require("fs").existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}
