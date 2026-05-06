/**
 * Image preflight: magic-byte detection (fast, no native deps) + optional
 * sharp metadata validation (slow, requires sharp prebuild for the platform).
 *
 * `sharp` is loaded lazily so a missing prebuild (e.g. на чистом Linux dev
 * без `@img/sharp-linux-x64`) НЕ роняет main process на старте — модуль
 * импортируется через цепочку `library.ipc → illustration-worker → image-preflight`,
 * и top-level `import sharp from "sharp"` крашит весь Electron boot.
 *
 * При отсутствии sharp `validateImageBuffer` возвращает `{ok: false}` с
 * понятной причиной; magic-byte fast path (`detectImageMimeFromMagic`)
 * продолжает работать без него.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
/* sharp типизация при dynamic import зависит от esModuleInterop / module
 * setting; чтобы избежать вечной игры со сменой `m.default` vs `m`, держим
 * loader как `any`-фабрику. Использование далее (`sharp(buf, opts).metadata()`)
 * остаётся типобезопасным благодаря runtime API sharp. */
type SharpFn = (buf: Buffer, opts?: { failOnError?: boolean }) => {
  metadata: () => Promise<{ width?: number; height?: number }>;
};

let _sharpPromise: Promise<SharpFn | null> | null = null;
async function loadSharp(): Promise<SharpFn | null> {
  if (_sharpPromise === null) {
    _sharpPromise = import("sharp")
      .then((m: any) => (typeof m === "function" ? m : m?.default ?? null))
      .catch((err: unknown) => {
        console.warn(
          `[image-preflight] sharp unavailable (${err instanceof Error ? err.message : String(err)}); ` +
            "validateImageBuffer will skip metadata checks. " +
            "Magic-byte detection still works.",
        );
        return null;
      });
  }
  return _sharpPromise;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export type ImagePreflightVerdict =
  | { ok: true; mime: "image/png" | "image/jpeg" | "image/webp" | "image/gif"; width?: number; height?: number }
  | { ok: false; reason: string };

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIG = Buffer.from([0xff, 0xd8, 0xff]);
const WEBP_RIFF = Buffer.from([0x52, 0x49, 0x46, 0x46]);
const WEBP_TAG = Buffer.from([0x57, 0x45, 0x42, 0x50]);
const GIF_87A = Buffer.from("GIF87a", "ascii");
const GIF_89A = Buffer.from("GIF89a", "ascii");

const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const MIN_IMAGE_BYTES = 64;

function detectMimeFromMagic(
  buf: Buffer,
): "image/png" | "image/jpeg" | "image/webp" | "image/gif" | null {
  if (buf.length < 8) return null;
  if (buf.subarray(0, 8).equals(PNG_SIG)) return "image/png";
  if (buf.length >= 3 && buf.subarray(0, 3).equals(JPEG_SIG)) return "image/jpeg";
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).equals(WEBP_RIFF) &&
    buf.subarray(8, 12).equals(WEBP_TAG)
  ) return "image/webp";
  if (buf.length >= 6) {
    const head6 = buf.subarray(0, 6);
    if (head6.equals(GIF_87A) || head6.equals(GIF_89A)) return "image/gif";
  }
  return null;
}

export function detectImageMimeFromMagic(buf: Buffer): ImagePreflightVerdict {
  if (!buf || buf.length === 0) return { ok: false, reason: "empty buffer" };
  if (buf.length < MIN_IMAGE_BYTES) return { ok: false, reason: `too small (${buf.length}B)` };
  if (buf.length > MAX_IMAGE_BYTES) {
    return { ok: false, reason: `too large (${buf.length}B > ${MAX_IMAGE_BYTES}B cap)` };
  }
  const mime = detectMimeFromMagic(buf);
  if (mime === null) return { ok: false, reason: "unknown image format (magic mismatch)" };
  return { ok: true, mime };
}

export async function validateImageBuffer(buf: Buffer): Promise<ImagePreflightVerdict> {
  const fastVerdict = detectImageMimeFromMagic(buf);
  if (!fastVerdict.ok) return fastVerdict;

  const sharp = await loadSharp();
  if (sharp === null) {
    /* Sharp недоступен — отдаём результат magic-byte проверки без metadata.
     * Caller получит ok:true с подтверждённым MIME, но без width/height. */
    return { ok: true, mime: fastVerdict.mime };
  }

  try {
    const meta = await sharp(buf, { failOnError: false }).metadata();
    const width = meta.width ?? 0;
    const height = meta.height ?? 0;
    if (width < 8 || height < 8) {
      return { ok: false, reason: `dimensions too small (${width}x${height})` };
    }
    if (width > 16384 || height > 16384) {
      return { ok: false, reason: `dimensions too large (${width}x${height})` };
    }
    return { ok: true, mime: fastVerdict.mime, width, height };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `sharp decode failed: ${msg.slice(0, 200)}` };
  }
}
