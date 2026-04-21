export { detectExt, isSupportedBook, parseBook, probeBooks } from "./parsers/index.js";
export type { BookParser, ParseResult, BookSection, BookMetadata, SupportedExt, BookFileSummary } from "./parsers/index.js";
export { chunkBook } from "./chunker.js";
export type { BookChunk, ChunkerOptions } from "./chunker.js";
export { ScannerStateStore } from "./state.js";
export type { ScannerState, ScannerBookState } from "./state.js";
export { ingestBook } from "./ingest.js";
export type { IngestProgress, IngestOptions, IngestResult } from "./ingest.js";
