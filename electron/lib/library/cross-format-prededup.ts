/**
 * Cross-Format Pre-Deduplication — Level 3 of the import filter pipeline.
 *
 * Rule: if two files share the EXACT same basename (case-insensitive, no ext)
 * AND the same parent directory, only the one with higher format priority is
 * imported. The other is silently skipped.
 *
 * Critical distinction from v1:
 *   "Book v1.pdf" vs "Book v2.pdf"  → different basenames → BOTH pass
 *   "Book.pdf"    vs "Book.djvu"    → same basename     → keep PDF (higher priority)
 *
 * This runs BEFORE parsing, so it costs nothing (just path string comparison).
 * It is stateful per import session and must be reset between sessions.
 */

import * as path from "path";

/**
 * Format priority: higher number = preferred when deduplicating.
 *
 * Must mirror `SUPPORTED_BOOK_EXTS` from `./types.ts` — formats not in the
 * supported set are never reached by the walker and entering them here only
 * confuses the dedup ledger (e.g. a `.mobi` next to a `.pdf` should not
 * influence the `.pdf` decision because `.mobi` cannot be imported anyway).
 */
const FORMAT_PRIORITY: Record<string, number> = {
  epub: 100,
  pdf:  80,
  djvu: 70,
  djv:  69,
  fb2:  60,
  docx: 50,
  doc:  40,
  rtf:  30,
  odt:  25,
  txt:  10,
  html: 5,
  htm:  5,
};

interface SeenEntry {
  ext: string;
  filePath: string;
  priority: number;
}

export interface PreDedupDecision {
  /** true = this file should be imported */
  include: boolean;
  /** When false: which file was already registered and will be kept instead */
  supersededBy?: string;
}

/**
 * Stateful pre-dedup registry for one import session.
 * Create one instance per `importFolderToLibrary` call.
 */
export class CrossFormatPreDedup {
  private readonly seen = new Map<string, SeenEntry>();
  /** Files that were registered but later superseded — caller may log them. */
  readonly superseded: Array<{ skipped: string; keptBy: string }> = [];

  /**
   * Register a candidate file.
   * Returns a decision: include=true means proceed with import.
   * If a lower-priority format was already registered, it is evicted and the
   * new (higher-priority) file is accepted instead.
   */
  check(filePath: string): PreDedupDecision {
    const dir = path.dirname(filePath);
    const ext = path.extname(filePath).slice(1).toLowerCase();
    const base = path.basename(filePath, path.extname(filePath)).toLowerCase();
    const key = `${dir.toLowerCase()}|${base}`;
    const priority = FORMAT_PRIORITY[ext] ?? -1;

    const existing = this.seen.get(key);

    if (!existing) {
      this.seen.set(key, { ext, filePath, priority });
      return { include: true };
    }

    if (priority > existing.priority) {
      // New file is better format — evict old, accept new
      this.superseded.push({ skipped: existing.filePath, keptBy: filePath });
      this.seen.set(key, { ext, filePath, priority });
      return { include: true };
    }

    // Existing is equal or better — skip new file
    this.superseded.push({ skipped: filePath, keptBy: existing.filePath });
    return { include: false, supersededBy: existing.filePath };
  }

  /**
   * Check if a file was superseded by a later higher-priority format.
   * Call this AFTER all files are discovered to emit accurate skip events.
   * For streaming use, prefer check() directly.
   */
  isSuperseded(filePath: string): boolean {
    return this.superseded.some((s) => s.skipped === filePath);
  }

  get size(): number {
    return this.seen.size;
  }
}
