import * as os from "node:os";

export interface OcrSupportInfo {
  supported: boolean;
  platform: string;
  reason?: string;
}

/**
 * OS-native OCR (Windows.Media.Ocr via @napi-rs/system-ocr) is available
 * only on Windows. On the Linux backend container we always return false —
 * the import pipeline falls back to Tesseract.js (Tier 1a) and the vision
 * LLM cascade (Tier 2).
 */
export function probeOcrSupport(): OcrSupportInfo {
  const platform = os.platform();
  if (platform === "win32") {
    return { supported: true, platform };
  }
  return {
    supported: false,
    platform,
    reason: "OS-native OCR is available only on Windows (Windows.Media.Ocr)",
  };
}
