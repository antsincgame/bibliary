/**
 * Persist + metadata-hint helpers для Book Evaluator.
 *
 * Извлечено из `evaluator-queue.ts` (Phase 3.3 cross-platform roadmap,
 * 2026-04-30). Консервативное разбиение: только pure функции, без mutable
 * state и без EventEmitter — сама очередь и worker-loop остаются в
 * `evaluator-queue.ts` (риск split этого state-machine был оценён как 🔴).
 *
 *   - `extractMetadataHints`  — pure: meta + md → строки подсказок для LLM
 *   - `persistFrontmatter`    — async: writes through caller-provided writer
 *
 * `persistFrontmatter` принимает writer extra-параметром, чтобы evaluator-queue
 * мог продолжать использовать DI hook `deps.writeFile` без изменения контракта.
 */

import {
  replaceFrontmatter,
  upsertEvaluatorReasoning,
} from "./md-converter.js";
import type { BookCatalogMeta } from "./types.js";

/** Атомарно перезаписывает frontmatter в book.md и (опционально) Evaluator Reasoning секцию. */
export async function persistFrontmatter(
  meta: BookCatalogMeta,
  mdPath: string,
  md: string,
  reasoning: string | null | undefined,
  writer: (path: string, content: string) => Promise<void>,
): Promise<void> {
  let next = replaceFrontmatter(md, meta);
  if (reasoning !== undefined) next = upsertEvaluatorReasoning(next, reasoning);
  await writer(mdPath, next);
}

/**
 * Pre-scan book.md and catalog meta for bibliographic hints (author, year,
 * publisher, ISBN) using regex. Results are prepended to the surrogate so
 * the LLM has strong clues even when the surrogate text itself is vague.
 */
export function extractMetadataHints(
  md: string,
  meta: BookCatalogMeta & { mdPath: string },
): string[] {
  const hints: string[] = [];

  if (meta.author && meta.author.length > 0) {
    hints.push(`- Filename/parser author: ${meta.author}`);
  }
  if (meta.year != null && meta.year > 0) {
    hints.push(`- Filename/parser year: ${meta.year}`);
  }
  if (meta.isbn) {
    hints.push(`- ISBN: ${meta.isbn}`);
  }
  if (meta.publisher) {
    hints.push(`- Publisher: ${meta.publisher}`);
  }

  const filename = meta.originalFile ?? "";
  if (filename.length > 0) {
    hints.push(`- Original filename: ${filename}`);
    const fnYear = filename.match(/(?:^|[\s_\-.(])(\d{4})(?:[\s_\-.)$])/);
    if (fnYear && +fnYear[1] >= 1800 && +fnYear[1] <= 2030 && meta.year == null) {
      hints.push(`- Year from filename: ${fnYear[1]}`);
    }
  }

  const textSample = md.slice(0, 20000);
  const copyrightMatch = textSample.match(/(?:copyright|©)\s*(\d{4})\s+(.{2,60})/i);
  if (copyrightMatch) {
    hints.push(`- Copyright line: © ${copyrightMatch[1]} ${copyrightMatch[2].trim()}`);
  }
  const isbnMatch = textSample.match(/isbn[\s:\-]*([\dxX\-]{10,17})/i);
  if (isbnMatch && !meta.isbn) {
    hints.push(`- ISBN from text: ${isbnMatch[1]}`);
  }
  const authorLineRu = textSample.match(/(?:автор|author|by)\s*[:：]\s*(.{2,60})/i);
  if (authorLineRu && !meta.author) {
    hints.push(`- Author line from text: ${authorLineRu[1].trim()}`);
  }
  /* Украинская специфика: ловим "видавництво", "рік видання", "друкарня". */
  const ukPublisher = textSample.match(/(?:видавництво|видавець|друкарня)\s*[:：]?\s*([^\n]{2,80})/i);
  if (ukPublisher && !meta.publisher) {
    hints.push(`- Publisher (uk) from text: ${ukPublisher[1].trim()}`);
  }
  const ukYear = textSample.match(/\b(?:рік\s*видання|видання)\s*[:：]?\s*((?:19|20)\d{2})/i);
  if (ukYear && meta.year == null) {
    hints.push(`- Year (uk) from text: ${ukYear[1]}`);
  }
  /* Ukrainian-specific letter signal — даём подсказку модели о языке. */
  if (/[іїєґІЇЄҐ]/.test(textSample)) {
    hints.push(`- Likely Ukrainian (i/ї/є/ґ detected)`);
  }

  return hints;
}
