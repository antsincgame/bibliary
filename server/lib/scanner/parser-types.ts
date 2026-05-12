/**
 * Local mirror of the parser types from
 * `electron/lib/scanner/parsers/types.ts`. We do NOT static-import from
 * there because the electron tree compiles with CommonJS rules and uses
 * extensionless `./constants` imports — both incompatible with this
 * server tsconfig (NodeNext + strict). Until Phase 12 unifies the two
 * trees under `server/lib/scanner/`, this duplicate gives us type
 * fidelity while `parsers-bridge.ts` loads the real implementation at
 * runtime via tsx.
 */

export interface BookSection {
  level: 1 | 2 | 3;
  title: string;
  paragraphs: string[];
}

export interface BookMetadata {
  title: string;
  author?: string;
  language?: string;
  identifier?: string;
  year?: number;
  publisher?: string;
  warnings: string[];
}

export interface ParseResult {
  metadata: BookMetadata;
  sections: BookSection[];
  rawCharCount: number;
}

export type SupportedExt =
  | "pdf"
  | "epub"
  | "fb2"
  | "docx"
  | "doc"
  | "rtf"
  | "odt"
  | "html"
  | "htm"
  | "txt"
  | "djvu"
  | "djv"
  | "mobi"
  | "azw"
  | "azw3"
  | "pdb"
  | "prc"
  | "chm"
  | "cbz"
  | "cbr"
  | "png"
  | "jpg"
  | "jpeg"
  | "bmp"
  | "tif"
  | "tiff"
  | "webp";

export interface ParseOptions {
  ocrEnabled?: boolean;
  ocrLanguages?: string[];
  ocrAccuracy?: "fast" | "accurate";
  ocrPdfDpi?: number;
  djvuOcrProvider?: "auto" | "tesseract" | "system" | "vision-llm" | "none";
  djvuRenderDpi?: number;
  visionOcrModel?: string;
  djvuMaxBytes?: number;
  signal?: AbortSignal;
}

const SUPPORTED_EXTS: ReadonlySet<SupportedExt> = new Set<SupportedExt>([
  "pdf",
  "epub",
  "fb2",
  "docx",
  "doc",
  "rtf",
  "odt",
  "html",
  "htm",
  "txt",
  "djvu",
  "djv",
  "mobi",
  "azw",
  "azw3",
  "pdb",
  "prc",
  "chm",
  "cbz",
  "cbr",
  "png",
  "jpg",
  "jpeg",
  "bmp",
  "tif",
  "tiff",
  "webp",
]);

export function detectExt(filePath: string): SupportedExt | null {
  const dot = filePath.lastIndexOf(".");
  if (dot < 0 || dot === filePath.length - 1) return null;
  const ext = filePath.slice(dot + 1).toLowerCase() as SupportedExt;
  return SUPPORTED_EXTS.has(ext) ? ext : null;
}

export function isSupportedBook(filePath: string): boolean {
  return detectExt(filePath) !== null;
}
