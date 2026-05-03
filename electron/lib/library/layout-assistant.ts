/**
 * Layout Assistant — LLM-верстальщик для post-import обработки book.md.
 *
 * Контракт annotation-only: модель НЕ переписывает текст, она только
 * аннотирует проблемы (заголовки, dot-leader ToC, OCR junk). Постпроцессор
 * применяет патчи детерминированно через `applyLayoutAnnotations` (bottom-up).
 *
 * Три критических риска (см. план, секция CRITICAL RISKS):
 *   1. Line drift — `applyLayoutAnnotations` сортирует ВСЕ мутации
 *      по убыванию line перед splice/replace.
 *   2. Naive chunking — `chunkMarkdown` режет ТОЛЬКО по `\n\n`,
 *      добавляет overlap, шифтит line numbers через mergeAnnotations.
 *   3. Fragile JSON — `safeParseAnnotations` (см. layout-assistant-schema.ts)
 *      использует jsonrepair + regex fallback.
 *
 * Контракт: никогда не throw наружу. На любой ошибке (нет модели, broken JSON
 * во всех чанках, IO error) возвращает result.applied = false с warnings.
 * Backup `.md.bak` создаётся ДО модификации, удаляется после успеха.
 */

import * as fs from "fs/promises";
import * as path from "path";
import { chatWithPolicy } from "../../lmstudio-client.js";
import { modelRoleResolver } from "../llm/model-role-resolver.js";
import { getModelPool } from "../llm/model-pool.js";
import { getRoleInferenceDefaults } from "../llm/role-load-config.js";
import { withBookMdLock } from "./book-md-mutex.js";
import {
  safeParseAnnotations,
  LAYOUT_ASSISTANT_MARKER,
  type LayoutAnnotations,
  type HeadingAnnotation,
} from "./layout-assistant-schema.js";

/* ───────── Константы ──────────────────────────────────────────────────── */

const LAYOUT_ASSISTANT_CONFIG = {
  /** Целевой максимум символов на чанк. Не жёсткий — режем только по `\n\n`. */
  chunkMaxChars: 7000,
  /** Overlap (хвост предыдущего чанка) для защиты заголовков на границах. */
  chunkOverlapChars: 500,
  /** Hard timeout на один LLM-вызов (ms). */
  perChunkTimeoutMs: 120_000,
  /** Минимальная длина книги в символах, ниже — пропускаем (нечего обрабатывать). */
  minBookChars: 200,
} as const;

/* ───────── Промпт ─────────────────────────────────────────────────────── */

let promptCache: string | null = null;

function bundledPromptCandidates(): string[] {
  const candidates: string[] = [];
  if (process.env.BIBLIARY_PROMPTS_DEFAULT_DIR) {
    candidates.push(path.join(process.env.BIBLIARY_PROMPTS_DEFAULT_DIR, "layout-assistant.md"));
  }
  if (typeof __dirname !== "undefined") {
    candidates.push(path.resolve(__dirname, "..", "..", "defaults", "prompts", "layout-assistant.md"));
  }
  candidates.push(path.resolve(process.cwd(), "electron", "defaults", "prompts", "layout-assistant.md"));
  return candidates;
}

async function loadLayoutPrompt(): Promise<string> {
  if (promptCache) return promptCache;
  for (const c of bundledPromptCandidates()) {
    try {
      const text = await fs.readFile(c, "utf8");
      if (text.trim().length > 100) {
        promptCache = text;
        return text;
      }
    } catch { /* try next */ }
  }
  throw new Error("layout-assistant.md prompt not found in any bundled location");
}

/** Сбрасывает кэш промпта (используется в тестах). */
export function clearLayoutPromptCache(): void {
  promptCache = null;
}

/* ───────── Чанкинг (Risk 2 fix) ───────────────────────────────────────── */

export interface MarkdownChunk {
  /** Содержимое чанка (включая overlap-prefix, если есть). */
  text: string;
  /** На сколько строк ниже находится chunk.text[0] относительно начала документа.
   *  Используется при mergeAnnotations: `documentLine = chunk.lineOffset + chunkLine`. */
  lineOffset: number;
}

/**
 * Режет markdown на чанки по двойному переносу (paragraph boundary), без
 * жёсткого character-cut в середине параграфа. Каждый чанк (кроме первого)
 * получает overlap-tail предыдущего чанка для защиты заголовков на границах.
 *
 * @param md — исходный markdown
 * @param maxChars — целевой максимум символов на чанк (мягкий лимит)
 * @param overlapChars — сколько последних символов прошлого чанка добавлять
 *                      в начало следующего (0 = без overlap)
 */
export function chunkMarkdown(
  md: string,
  maxChars: number = LAYOUT_ASSISTANT_CONFIG.chunkMaxChars,
  overlapChars: number = LAYOUT_ASSISTANT_CONFIG.chunkOverlapChars,
): MarkdownChunk[] {
  if (typeof md !== "string" || md.length === 0) return [];

  /* split по \n\n+ сохраняет параграфы целиком; склеиваем обратно через "\n\n". */
  const paragraphs = md.split(/\n\n+/);
  if (paragraphs.length === 0) return [];

  const chunks: MarkdownChunk[] = [];
  let currentParas: string[] = [];
  let currentChars = 0;
  let lineOffset = 0;
  let consumedLineCount = 0;

  const flush = () => {
    if (currentParas.length === 0) return;
    chunks.push({
      text: currentParas.join("\n\n"),
      lineOffset,
    });
  };

  /**
   * Bug 12 fix: если один параграф > maxChars, разбиваем по строкам (\n).
   * Если и строка > maxChars — разбиваем по символам с жёстким лимитом.
   * Это гарантирует, что ни один чанк не превышает контекст-окно модели.
   */
  const splitHugeParagraph = (hugePara: string): string[] => {
    if (hugePara.length <= maxChars) return [hugePara];
    const lines = hugePara.split("\n");
    const subParas: string[] = [];
    let current = "";
    for (const line of lines) {
      const candidate = current ? `${current}\n${line}` : line;
      if (candidate.length > maxChars && current.length > 0) {
        subParas.push(current);
        current = line;
      } else if (line.length > maxChars) {
        /* Одиночная строка > maxChars — режем по символам. */
        if (current) { subParas.push(current); current = ""; }
        for (let i = 0; i < line.length; i += maxChars) {
          subParas.push(line.slice(i, i + maxChars));
        }
      } else {
        current = candidate;
      }
    }
    if (current) subParas.push(current);
    return subParas;
  };

  for (const rawPara of paragraphs) {
    /* Bug 12: разбиваем огромные параграфы перед добавлением в буфер. */
    const subParagraphs = rawPara.length > maxChars ? splitHugeParagraph(rawPara) : [rawPara];

    for (const para of subParagraphs) {
    const paraChars = para.length;
    /* +2 за \n\n separator (первый параграф без separator, поэтому проверяем). */
    const wouldBeChars = currentChars === 0 ? paraChars : currentChars + 2 + paraChars;

    if (wouldBeChars > maxChars && currentParas.length > 0) {
      /* Закрываем текущий чанк, открываем новый с overlap tail. */
      flush();
      const finishedText = currentParas.join("\n\n");
      const finishedLineCount = finishedText.split("\n").length;

      /* Overlap: берём последние `overlapChars` символов старого чанка. */
      let overlapPrefix = "";
      let overlapLineCount = 0;
      if (overlapChars > 0 && finishedText.length > overlapChars) {
        overlapPrefix = finishedText.slice(-overlapChars);
        overlapLineCount = overlapPrefix.split("\n").length - 1;
      }

      consumedLineCount += finishedLineCount + 1; /* +1 за пустую строку между чанками */
      /* Новый chunk начинается на: (consumed) - (overlap lines) — overlap-prefix
         как бы возвращает нас на overlapLineCount строк назад. */
      lineOffset = consumedLineCount - overlapLineCount;
      if (lineOffset < 0) lineOffset = 0;

      if (overlapPrefix) {
        currentParas = [overlapPrefix, para];
        currentChars = overlapPrefix.length + 2 + paraChars;
      } else {
        currentParas = [para];
        currentChars = paraChars;
      }
    } else {
      currentParas.push(para);
      currentChars = wouldBeChars;
    }
    } /* end for subParagraphs */
  }

  flush();
  return chunks;
}

/* ───────── Merge (chunk-level → document-level) ───────────────────────── */

/**
 * Сливает аннотации со всех чанков в документ-level, шифтя `line` на
 * `chunk.lineOffset` и удаляя дубликаты (overlap-зона).
 */
export function mergeAnnotations(
  chunks: Array<{ lineOffset: number; ann: LayoutAnnotations }>,
): LayoutAnnotations {
  const headingsByLine = new Map<number, HeadingAnnotation>();
  const junkSet = new Set<number>();

  for (const { lineOffset, ann } of chunks) {
    for (const h of ann.headings) {
      const docLine = h.line + lineOffset;
      /* Dedup: первый матч выигрывает (overlap-зона). */
      if (!headingsByLine.has(docLine)) {
        headingsByLine.set(docLine, { ...h, line: docLine });
      }
    }
    for (const j of ann.junk_lines) {
      junkSet.add(j + lineOffset);
    }
    /* Bug 11 fix: toc_block удалён из схемы и mergeAnnotations.
       Dot-leader ToC структурируется в reader.js `structureLeaderToc`. */
  }

  const headings = Array.from(headingsByLine.values()).sort((a, b) => a.line - b.line);
  const junk_lines = Array.from(junkSet).sort((a, b) => a - b);
  return { headings, junk_lines };
}

/* ───────── applyLayoutAnnotations (Risk 1 fix) ────────────────────────── */

type Mutation =
  | { kind: "delete"; line: number }
  | { kind: "replace"; line: number; newText: string };

/**
 * Применяет аннотации к markdown. Pure function. Идемпотентна — если в md уже
 * есть `LAYOUT_ASSISTANT_MARKER`, возвращает md без изменений.
 *
 * Risk 1 fix: ВСЕ мутации сортируются по УБЫВАНИЮ номера строки перед
 * применением. Иначе удаление junk_lines сдвигает индексы заголовков и
 * heading.line указывает на чужую строку.
 */
export function applyLayoutAnnotations(md: string, ann: LayoutAnnotations): string {
  if (typeof md !== "string") return md;
  /* Idempotency: marker → no-op. */
  if (md.includes(LAYOUT_ASSISTANT_MARKER)) return md;

  const lines = md.split("\n");
  const mutations: Mutation[] = [];

  /* Headings: replace target line with `## title` (level 1..3). */
  for (const h of ann.headings) {
    const idx = h.line - 1; /* 1-indexed → 0-indexed */
    if (idx < 0 || idx >= lines.length) continue; /* skip out-of-range */
    const prefix = "#".repeat(h.level);
    const headingText = h.text.trim();
    const existing = lines[idx];
    /* Если строка уже размечена как заголовок этого же уровня — пропускаем. */
    if (new RegExp(`^${prefix}\\s+`).test(existing)) continue;
    /* Bug 9 fix: защита от галлюцинаций. Нормализуем оба текста
       (strip markdown prefix, trim, lowercase) и проверяем совпадение.
       Если модель вернула text не соответствующий реальной строке — пропускаем:
       лучше оставить незаголовком, чем вставить выдуманный текст в книгу. */
    const normalizeForCompare = (s: string): string =>
      s.replace(/^#+\s*/, "").toLowerCase().replace(/\s+/g, " ").trim();
    const existingNorm = normalizeForCompare(existing);
    const headingNorm = normalizeForCompare(headingText);
    /* Разрешаем частичное совпадение: headingText — префикс existingNorm или наоборот
       (модель может усекать длинный заголовок). */
    const isMatch =
      existingNorm === headingNorm ||
      existingNorm.startsWith(headingNorm) ||
      headingNorm.startsWith(existingNorm);
    if (!isMatch) continue;
    mutations.push({ kind: "replace", line: idx, newText: `${prefix} ${existingNorm.length > 0 ? existing.replace(/^#+\s*/, "").trim() : headingText}` });
  }

  /* Junk lines: delete. */
  for (const j of ann.junk_lines) {
    const idx = j - 1;
    if (idx < 0 || idx >= lines.length) continue;
    mutations.push({ kind: "delete", line: idx });
  }

  /* CRITICAL: bottom-up. Иначе delete сдвигает массив и replace попадает в
     чужую строку (Risk 1 — line drift). */
  mutations.sort((a, b) => b.line - a.line);

  for (const mut of mutations) {
    if (mut.kind === "delete") {
      lines.splice(mut.line, 1);
    } else {
      lines[mut.line] = mut.newText;
    }
  }

  /* ToC: dot-leader блоки структурирует renderer/library/reader.js
     `structureLeaderToc` на этапе рендера — здесь не вмешиваемся (Bug 11 fix). */

  /* Append marker. Если уже есть YAML frontmatter — пишем после него,
     иначе — в самом начале. */
  let result = lines.join("\n");
  if (result.startsWith("---\n")) {
    const fmEnd = result.indexOf("\n---\n", 4);
    if (fmEnd > 0) {
      const before = result.slice(0, fmEnd + 5);
      const after = result.slice(fmEnd + 5);
      result = `${before}${LAYOUT_ASSISTANT_MARKER}\n${after}`;
    } else {
      result = `${LAYOUT_ASSISTANT_MARKER}\n${result}`;
    }
  } else {
    result = `${LAYOUT_ASSISTANT_MARKER}\n${result}`;
  }
  return result;
}

/* ───────── Главный entry-point: runLayoutAssistant ────────────────────── */

export interface LayoutAssistantOptions {
  /** Принудительный override модели. Иначе через role resolver. */
  modelKey?: string;
  /** Принудительный re-run даже если marker уже есть. */
  force?: boolean;
  /** Прерывание (используется в очереди / IPC cancel). */
  signal?: AbortSignal;
  /** DI: подменяемый LLM caller для unit-тестов без LM Studio. */
  llmCall?: (args: {
    modelKey: string;
    systemPrompt: string;
    userText: string;
    signal: AbortSignal;
  }) => Promise<string>;
}

export interface LayoutAssistantResult {
  applied: boolean;
  /** Какая модель использовалась (при applied=true или partial). */
  model?: string;
  /** Сколько чанков успешно распарсилось. */
  chunksOk?: number;
  /** Сколько чанков вернули broken JSON (после всех попыток recovery). */
  chunksFailed?: number;
  warnings: string[];
  error?: string;
}

/**
 * Прогоняет book.md через layout-assistant. Никогда не throw.
 *
 * Возвращает `applied: true` если хотя бы один чанк дал валидную аннотацию
 * И постпроцессор внёс изменения. `applied: false` если книга осталась как
 * есть (нет модели, marker уже стоял, все чанки сломали JSON, IO failed).
 */
export async function runLayoutAssistant(
  bookMdPath: string,
  opts: LayoutAssistantOptions = {},
): Promise<LayoutAssistantResult> {
  const warnings: string[] = [];

  /* ── 1. Read source ── */
  let originalMd: string;
  try {
    originalMd = await fs.readFile(bookMdPath, "utf8");
  } catch (e) {
    return { applied: false, warnings, error: `read failed: ${(e as Error).message}` };
  }
  if (originalMd.length < LAYOUT_ASSISTANT_CONFIG.minBookChars) {
    return { applied: false, warnings: ["book too short, skipped"] };
  }
  if (!opts.force && originalMd.includes(LAYOUT_ASSISTANT_MARKER)) {
    return { applied: false, warnings: ["already processed (marker present)"] };
  }
  /* Bug 26 fix: при force=true — убираем старый marker ПЕРЕД chunking/LLM,
     иначе applyLayoutAnnotations увидит marker и вернёт md без изменений
     (тратим весь LLM run впустую). */
  const mdForProcessing = opts.force
    ? originalMd.replace(`${LAYOUT_ASSISTANT_MARKER}\n`, "")
    : originalMd;

  /* ── 2. Resolve model ── */
  let modelKey: string | undefined = opts.modelKey;
  if (!modelKey) {
    try {
      const resolved = await modelRoleResolver.resolve("layout_assistant");
      modelKey = resolved?.modelKey;
    } catch (e) {
      warnings.push(`role resolver failed: ${(e as Error).message}`);
    }
  }
  if (!modelKey) {
    return { applied: false, warnings: [...warnings, "no layout_assistant model resolved"] };
  }

  /* ── 3. Load prompt ── */
  let systemPrompt: string;
  try {
    systemPrompt = await loadLayoutPrompt();
  } catch (e) {
    return { applied: false, warnings, error: `prompt load failed: ${(e as Error).message}` };
  }

  /* ── 4. Chunk ── */
  const chunks = chunkMarkdown(mdForProcessing);
  if (chunks.length === 0) {
    return { applied: false, warnings: ["chunking produced 0 chunks"] };
  }

  /* ── 5. Per-chunk LLM call + parse ── */
  const inferenceDefaults = getRoleInferenceDefaults("layout_assistant");
  const chunkAnnotations: Array<{ lineOffset: number; ann: LayoutAnnotations }> = [];
  let chunksFailed = 0;

  /* Per-chunk LLM call. В test/DI режиме (opts.llmCall) НЕ дёргаем
     ModelPool — он требует реальный LM Studio для acquire. */
  const callOneChunk = async (chunk: { text: string; lineOffset: number }): Promise<void> => {
    if (opts.signal?.aborted) {
      warnings.push("aborted by signal");
      return;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort("timeout"), LAYOUT_ASSISTANT_CONFIG.perChunkTimeoutMs);
    const externalSignal = opts.signal;
    if (externalSignal) {
      if (externalSignal.aborted) ctrl.abort("external");
      else externalSignal.addEventListener("abort", () => ctrl.abort("external"), { once: true });
    }
    try {
      const userText = chunk.text;
      let raw: string;
      if (opts.llmCall) {
        raw = await opts.llmCall({
          modelKey: modelKey!,
          systemPrompt,
          userText,
          signal: ctrl.signal,
        });
      } else {
        const resp = await chatWithPolicy(
          {
            model: modelKey!,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: userText },
            ],
            sampling: {
              temperature: inferenceDefaults.temperature,
              top_p: inferenceDefaults.topP,
              max_tokens: inferenceDefaults.maxTokens,
            },
            signal: ctrl.signal,
          },
          { externalSignal: ctrl.signal },
        );
        raw = resp.content ?? "";
      }
      const ann = safeParseAnnotations(raw);
      if (ann) {
        chunkAnnotations.push({ lineOffset: chunk.lineOffset, ann });
      } else {
        chunksFailed++;
      }
    } catch (e) {
      chunksFailed++;
      warnings.push(`chunk @line ${chunk.lineOffset}: ${(e as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
  };

  if (opts.llmCall) {
    /* Test/DI mode — нет ModelPool, чанки идут sequentially. */
    for (const chunk of chunks) await callOneChunk(chunk);
  } else {
    /* Production: pool.withModel удерживает refCount для всех чанков,
       чтобы LRU не evict'нул модель посреди обработки. */
    const pool = getModelPool();
    await pool.withModel(
      modelKey,
      { role: "layout_assistant", ttlSec: 1800, gpuOffload: "max" },
      async () => {
        for (const chunk of chunks) await callOneChunk(chunk);
      },
    );
  }

  if (chunkAnnotations.length === 0) {
    return {
      applied: false,
      model: modelKey,
      chunksOk: 0,
      chunksFailed,
      warnings: [...warnings, "all chunks failed to parse — book unchanged"],
    };
  }

  /* ── 6. Merge annotations (outside lock — pure CPU, fast) ── */
  const merged = mergeAnnotations(chunkAnnotations);

  /* ── 7. Atomic write (WITH lock — fast IO only) ──
   *
   * Bug 4 fix: lock is now held ONLY for the write phase, not during LLM
   * inference. The inference above (pool.withModel + per-chunk calls) ran
   * without any mutex — evaluator / reparse / IPC could freely modify book.md
   * during that time.
   *
   * Inside the lock we re-read book.md and compare it to `originalMd` (read
   * at step 1). If they differ, a concurrent writer (evaluator, reparse, another
   * layout-assistant run) has modified the file while we were inferring. The
   * annotations are now based on stale line numbers, so we abort and ask the
   * user to re-run rather than corrupt the book. */
  interface WritePhaseResult {
    applied: boolean;
    writeError?: string;
    writeWarning?: string;
  }

  const writePhaseResult = await withBookMdLock(bookMdPath, async (): Promise<WritePhaseResult> => {
    /* Re-read to detect concurrent modification. */
    let currentMd: string;
    try {
      currentMd = await fs.readFile(bookMdPath, "utf8");
    } catch (e) {
      return { applied: false, writeError: `re-read failed: ${(e as Error).message}` };
    }

    if (currentMd !== originalMd) {
      return {
        applied: false,
        writeWarning:
          "book.md was modified concurrently during inference, skipping " +
          "(trigger re-run from reader to apply layout)",
      };
    }

    /* Bug 26: используем mdForProcessing (marker уже удалён при force=true). */
    const newMd = applyLayoutAnnotations(mdForProcessing, merged);

    /* Backup + write (Bug 5 pattern preserved). */
    const backupPath = `${bookMdPath}.bak`;
    try {
      let bakExists = false;
      try {
        const bakStat = await fs.stat(backupPath);
        const curStat = await fs.stat(bookMdPath);
        bakExists = bakStat.mtimeMs < curStat.mtimeMs;
      } catch { /* .bak не существует */ }
      if (!bakExists) {
        await fs.writeFile(backupPath, originalMd, "utf8");
      }
      await fs.writeFile(bookMdPath, newMd, "utf8");
      await fs.unlink(backupPath).catch(() => undefined);
      return { applied: true };
    } catch (e) {
      /* Попытка отката из backup. */
      try {
        const bak = await fs.readFile(backupPath, "utf8");
        await fs.writeFile(bookMdPath, bak, "utf8");
        await fs.unlink(backupPath).catch(() => undefined);
      } catch { /* best-effort rollback */ }
      return { applied: false, writeError: `write failed: ${(e as Error).message}` };
    }
  });

  const extraWarnings: string[] = [];
  if (writePhaseResult.writeWarning) extraWarnings.push(writePhaseResult.writeWarning);

  return {
    applied: writePhaseResult.applied,
    model: modelKey,
    chunksOk: chunkAnnotations.length,
    chunksFailed,
    warnings: [...warnings, ...extraWarnings],
    error: writePhaseResult.writeError,
  };
}
