/**
 * Librarian — фильтр дубликатов в библиотеке.
 *
 * Задача: в папке часто лежат одни и те же книги в разных форматах
 * (PDF + EPUB + DJVU) и разных редакциях (1st, 2nd, 4th ed.). Импортировать
 * ВСЁ — это засорение RAG. Импортировать только лучшее — но что есть «лучшее»?
 *
 * Решение: трёхступенчатый pipeline.
 *
 *   ── СТУПЕНЬ 1: Signature ────────────────────────────────────────────
 *     Каждый файл получает «сигнатуру»: нормализованное имя
 *     (без расширения, ed., volume, pages, формата). Файлы с одинаковой
 *     сигнатурой попадают в один cluster — кандидаты на дубликаты.
 *
 *     normalize:
 *       - lowercase
 *       - убираем (1st ed.|2nd ed.|3-rd|4th edition|version 5|v.5|edition 5)
 *       - убираем (vol\.\s*\d+|volume \d+|часть \d+|том \d+)
 *       - убираем расширение
 *       - убираем размер/качество ([0-9]+p, ocr, scan, retail, true.pdf)
 *       - сжимаем пробелы и пунктуацию в одну пробел
 *
 *   ── СТУПЕНЬ 2: Revision-Pick ────────────────────────────────────────
 *     В каждом кластере выбираем «лучшую» редакцию.
 *
 *     Признаки качества (взвешенный score):
 *       + год издания позже (год ищем в имени или в metadata)        +30
 *       + 2nd/3rd/4th ed. позже 1st                                  +20
 *       + формат: PDF > EPUB > DJVU > FB2 > HTML > TXT               +10..+50
 *       + большего размера (книга подробнее)                         +10
 *       + есть OCR (для DJVU/PDF — meaningful text)                  +20
 *       - "scan" / "scanned" в имени (плохое качество текста)        −15
 *       - повреждённый/нечитаемый                                    −100
 *
 *   ── СТУПЕНЬ 3: Tie-Break (опциональный LLM) ────────────────────────
 *     Если score у нескольких кандидатов отличается <10 пунктов —
 *     задаём LLM (роль `crystallizer` или `evaluator`):
 *
 *       "Вот N кандидатов одной и той же книги. Какой лучше для
 *        технической библиотеки? Учти: год, редакцию, наличие индексов,
 *        формат для извлечения текста. Ответ: индекс [0..N-1] и причина."
 *
 *     Если LLM офлайн — берём лидера по score (deterministic fallback).
 *
 * Возвращает: для каждого cluster — {winner, runners-up, reason}.
 *
 * Не модифицирует файлы. Это аналитика; UI решает что делать с runners-up
 * (показать пользователю список, дать кнопку «удалить дубликаты», или
 * просто пропустить их в импорте).
 */

import * as path from "path";
import { promises as fs } from "fs";

export interface LibrarianFile {
  absPath: string;
  /** Размер в байтах. Если не передан — Librarian прочтёт сам. */
  sizeBytes?: number;
  /** Опциональная мета (если уже распарсена). */
  metadata?: { title?: string; author?: string; year?: number; language?: string };
}

export interface LibrarianCluster {
  signature: string;
  /** Победитель — лучшая редакция. */
  winner: LibrarianFile;
  /** Все остальные — кандидаты на пропуск/удаление. */
  runnersUp: LibrarianFile[];
  /** Чем победитель лучше («2nd ed., 2022, PDF > EPUB», или ответ LLM). */
  reason: string;
  /** score-разница между winner и 2-м местом; полезно для UI. */
  margin: number;
  /** true, если LLM был задействован для tie-break. */
  llmUsed: boolean;
}

export interface LibrarianOptions {
  /** Включить LLM tie-break когда margin < threshold. По умолчанию true. */
  enableLlmTieBreak?: boolean;
  /** При margin меньше этого числа очков — звать LLM. По умолчанию 10. */
  llmTieBreakThreshold?: number;
  /** Кастомный LLM tie-break callback (для тестов). */
  llmTieBreak?: (files: LibrarianFile[], signature: string) => Promise<{ winnerIndex: number; reason: string }>;
  /** Прогресс-каллбэк. */
  onProgress?: (e: LibrarianProgressEvent) => void;
  signal?: AbortSignal;
}

export type LibrarianProgressEvent =
  | { type: "librarian.start"; total: number }
  | { type: "librarian.cluster"; signature: string; size: number }
  | { type: "librarian.llm-tiebreak"; signature: string; candidates: number }
  | { type: "librarian.done"; clusters: number; duplicates: number };

/* ─── СТУПЕНЬ 1: Signature ────────────────────────────────────────── */

const FORMAT_RE = /\.(pdf|epub|djvu|fb2|docx?|rtf|odt|html?|txt)$/i;
const EDITION_RE = /\b(\d+)(?:st|nd|rd|th|-?[ое])?\s*(?:ed(?:\.|ition)?|edition|редакц[иия][ая]?|изд(?:ание|\.)?)/gi;
const VOLUME_RE = /\b(?:vol\.|volume|том|часть|part)\s*\d+/gi;
const QUALITY_RE = /\b(scan|scanned|ocr|retail|true|color|colour|hd|hq|low|hi|hires)\b/gi;
const PAGES_RE = /\b\d{2,4}\s*(?:p|pages|стр|с)\b/gi;
const YEAR_IN_NAME_RE = /\b(19|20)\d{2}\b/g;

export function normalizeSignature(filePath: string): string {
  const base = path.basename(filePath).replace(FORMAT_RE, "");
  return base
    .toLowerCase()
    /* punctuation/separators → spaces FIRST, чтобы regex'ы про "2nd_ed" срабатывали */
    .replace(/[_\-.,()[\]{}]+/g, " ")
    .replace(EDITION_RE, " ")
    .replace(VOLUME_RE, " ")
    .replace(QUALITY_RE, " ")
    .replace(PAGES_RE, " ")
    .replace(YEAR_IN_NAME_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/* ─── СТУПЕНЬ 2: Revision-Pick ────────────────────────────────────── */

const FORMAT_SCORES: Record<string, number> = {
  pdf:  50,
  epub: 45,
  fb2:  35,
  docx: 30,
  rtf:  20,
  odt:  20,
  djvu: 15,
  html: 10,
  htm:  10,
  txt:   5,
};

interface ScoredFile {
  file: LibrarianFile;
  score: number;
  parts: string[];
}

function getExt(p: string): string {
  return path.extname(p).toLowerCase().slice(1);
}

function extractYearFromName(name: string): number | null {
  const matches = name.match(/\b(19|20)\d{2}\b/g);
  if (!matches) return null;
  /* Берём максимальный год — это, как правило, год издания (а не дата
     рождения автора в имени файла). */
  const years = matches.map(Number).filter((y) => y >= 1950 && y <= 2030);
  return years.length > 0 ? Math.max(...years) : null;
}

function extractEditionFromName(name: string): number | null {
  const m = name.match(/\b(\d+)(?:st|nd|rd|th|-?[ое])?\s*(?:ed\.?|edition|изд|редакц)/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 && n < 30 ? n : null;
}

export function scoreFile(file: LibrarianFile): ScoredFile {
  const name = path.basename(file.absPath);
  const ext = getExt(file.absPath);
  const parts: string[] = [];
  let score = 0;

  /* Format. */
  const fmtScore = FORMAT_SCORES[ext] ?? 0;
  score += fmtScore;
  if (fmtScore > 0) parts.push(`format=${ext}(+${fmtScore})`);

  /* Year. */
  const year = file.metadata?.year ?? extractYearFromName(name);
  if (year !== null) {
    /* Каждый год после 2000 даёт +1 (2024 → +24, 1995 → +0). */
    const yearScore = Math.max(0, year - 2000);
    score += yearScore;
    if (yearScore > 0) parts.push(`year=${year}(+${yearScore})`);
  }

  /* Edition. */
  const edition = extractEditionFromName(name);
  if (edition !== null && edition > 1) {
    const edScore = Math.min(20, edition * 5);
    score += edScore;
    parts.push(`edition=${edition}(+${edScore})`);
  }

  /* Size: бонус за больший размер (как proxy для полноты). */
  if (file.sizeBytes && file.sizeBytes > 0) {
    /* Логарифмически: 1MB = +0, 10MB = +10, 100MB = +20. */
    const sizeMb = file.sizeBytes / (1024 * 1024);
    const sizeScore = Math.round(Math.log10(Math.max(1, sizeMb)) * 10);
    score += sizeScore;
    parts.push(`size=${sizeMb.toFixed(1)}MB(+${sizeScore})`);
  }

  /* Quality penalty. */
  if (/\b(scan|scanned)\b/i.test(name)) {
    score -= 15;
    parts.push("scan(-15)");
  }
  if (/\b(low|lowres|lowq)\b/i.test(name)) {
    score -= 10;
    parts.push("lowres(-10)");
  }

  return { file, score, parts };
}

/* ─── СТУПЕНЬ 3: Tie-Break ────────────────────────────────────────── */

async function defaultLlmTieBreak(
  files: LibrarianFile[],
  signature: string,
): Promise<{ winnerIndex: number; reason: string }> {
  try {
    const { modelRoleResolver } = await import("../llm/model-role-resolver.js");
    const { chatWithPolicy } = await import("../../lmstudio-client.js");
    const role = await modelRoleResolver.resolve("evaluator");
    if (!role) return { winnerIndex: 0, reason: "no LLM available, kept top-scored" };

    const list = files.map((f, i) => `${i}. ${path.basename(f.absPath)} (${(f.sizeBytes ?? 0)} bytes)`).join("\n");
    const resp = await chatWithPolicy({
      model: role.modelKey,
      messages: [
        {
          role: "system",
          content:
            "You pick the best edition of a book for a technical library. " +
            'Output ONLY JSON: {"index":number,"reason":string}. ' +
            "Prefer: latest edition, modern format (PDF/EPUB), no 'scan' label, larger size.",
        },
        {
          role: "user",
          content:
            `Book signature: "${signature}". Candidates:\n${list}\n\n` +
            "Which index is best?",
        },
      ],
      sampling: { temperature: 0.1, top_p: 0.9, top_k: 40, min_p: 0, presence_penalty: 0, max_tokens: 200 },
    }, {});
    const cleaned = (resp.content ?? "").replace(/^[^{]*/, "").replace(/[^}]*$/, "");
    const parsed = JSON.parse(cleaned) as { index?: number; reason?: string };
    if (typeof parsed.index === "number" && parsed.index >= 0 && parsed.index < files.length) {
      return { winnerIndex: parsed.index, reason: parsed.reason ?? "LLM choice" };
    }
  } catch {
    /* fallthrough */
  }
  return { winnerIndex: 0, reason: "LLM tie-break failed, kept top-scored" };
}

/* ─── Pipeline ────────────────────────────────────────────────────── */

export async function findDuplicates(
  files: LibrarianFile[],
  opts: LibrarianOptions = {},
): Promise<LibrarianCluster[]> {
  /* Дочитываем размеры если их не передали. */
  const filled: LibrarianFile[] = [];
  for (const f of files) {
    if (typeof f.sizeBytes === "number") {
      filled.push(f);
    } else {
      try {
        const s = await fs.stat(f.absPath);
        filled.push({ ...f, sizeBytes: s.size });
      } catch {
        filled.push({ ...f, sizeBytes: 0 });
      }
    }
  }

  /* Группировка по сигнатуре. */
  const buckets = new Map<string, LibrarianFile[]>();
  for (const f of filled) {
    const sig = normalizeSignature(f.absPath);
    if (sig.length === 0) continue;
    const arr = buckets.get(sig) ?? [];
    arr.push(f);
    buckets.set(sig, arr);
  }

  opts.onProgress?.({ type: "librarian.start", total: buckets.size });

  const clusters: LibrarianCluster[] = [];
  const llmThreshold = opts.llmTieBreakThreshold ?? 10;
  const llmEnabled = opts.enableLlmTieBreak !== false;
  const llmFn = opts.llmTieBreak ?? defaultLlmTieBreak;

  for (const [sig, group] of buckets) {
    if (opts.signal?.aborted) break;
    if (group.length < 2) continue;
    opts.onProgress?.({ type: "librarian.cluster", signature: sig, size: group.length });

    const scored = group.map(scoreFile).sort((a, b) => b.score - a.score);
    const top = scored[0]!;
    const second = scored[1]!;
    const margin = top.score - second.score;

    let winnerIdx = 0;
    let reason = top.parts.join(", ");
    let llmUsed = false;

    if (margin < llmThreshold && llmEnabled) {
      opts.onProgress?.({ type: "librarian.llm-tiebreak", signature: sig, candidates: scored.length });
      const tied = scored.slice(0, Math.min(4, scored.length)).map((s) => s.file);
      try {
        const r = await llmFn(tied, sig);
        winnerIdx = r.winnerIndex;
        reason = `${reason} • LLM: ${r.reason}`;
        llmUsed = true;
      } catch {
        /* fallback to top score */
      }
    }

    const winner = scored[winnerIdx]!.file;
    const runnersUp = scored.filter((_, i) => i !== winnerIdx).map((s) => s.file);
    clusters.push({ signature: sig, winner, runnersUp, reason, margin, llmUsed });
  }

  const duplicates = clusters.reduce((sum, c) => sum + c.runnersUp.length, 0);
  opts.onProgress?.({ type: "librarian.done", clusters: clusters.length, duplicates });
  return clusters;
}
