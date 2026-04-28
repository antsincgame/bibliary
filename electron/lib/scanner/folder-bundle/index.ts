/**
 * Folder-Bundle pipeline — публичный API.
 *
 * См. `classifier.ts` (обход папки, классификация файлов) и
 * `markdown-builder.ts` (склейка единого md).
 *
 * Высокоуровневая интеграция (parse main book + LLM-описание sidecars +
 * запись готового md + ingest) живёт в IPC-слое; этот пакет даёт чистые
 * pure-функции, легко тестируемые без Electron.
 */

export {
  discoverBundle,
  type BookBundle,
  type ClassifiedFile,
  type FileKind,
} from "./classifier.js";

export {
  buildBundleMarkdown,
  type BundleMarkdownInput,
  type SidecarDescription,
} from "./markdown-builder.js";
