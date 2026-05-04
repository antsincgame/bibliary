/**
 * Library IPC -- barrel + entry-point.
 *
 * Реальная реализация разнесена на 4 модуля по ответственности
 * (Phase 3.1 cross-platform roadmap, 2026-04-30):
 *
 *   - library-ipc-state.ts      — shared state + lifecycle helpers
 *   - library-import-ipc.ts     — pick / import / cancel-import / scan-folder
 *   - library-catalog-ipc.ts    — catalog / collections / get-book / delete /
 *                                 rebuild-cache
 *   - library-evaluator-ipc.ts  — evaluator-* / reparse-book / reevaluate-*
 *
 * Этот файл оставляет только `registerLibraryIpc` (вызов трёх регистраторов)
 * и re-exports lifecycle helpers для main.ts.
 *
 * Архитектура:
 *   - data/library/<language>/<domain>/<author>/<Book Title>.md -- источник истины.
 *     Sidecars рядом с тем же basename: .original.{ext}, .meta.json,
 *     .illustrations.json. Старые layout'ы продолжают читаться.
 *   - SQLite cache-db.ts -- индекс для UI, перестраиваемый из FS.
 *   - evaluator-queue.ts -- фоновый воркер LLM-оценки (slotCount параллельных
 *     LLM-call'ов, default 2; настраивается через UI evaluator-set-slots).
 */

import type { BrowserWindow } from "electron";
import { registerLibraryImportIpc } from "./library-import-ipc.js";
import { registerLibraryCatalogIpc } from "./library-catalog-ipc.js";
import { registerLibraryEvaluatorIpc } from "./library-evaluator-ipc.js";
import { registerLibraryLayoutAssistantIpc } from "./library-layout-assistant.ipc.js";
import { registerLibraryPreflightIpc } from "./library-preflight-ipc.js";

export {
  abortAllLibrary,
  activeLibraryImportCount,
  flushLibraryImports,
  bootstrapLibrarySubsystem,
} from "./library-ipc-state.js";

export function registerLibraryIpc(getMainWindow: () => BrowserWindow | null): void {
  registerLibraryImportIpc(getMainWindow);
  registerLibraryCatalogIpc();
  registerLibraryEvaluatorIpc();
  registerLibraryLayoutAssistantIpc();
  registerLibraryPreflightIpc();
}
