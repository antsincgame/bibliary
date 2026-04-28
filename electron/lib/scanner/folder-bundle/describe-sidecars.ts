/**
 * Folder-Bundle — LLM-стадия описания sidecars.
 *
 * Принимает результат `discoverBundle` и создаёт `Map<absPath, SidecarDescription>`,
 * который потом скармливается `buildBundleMarkdown`.
 *
 * Стратегия:
 *  - image      → vision-модель (extractMetadataFromCover-light: «опиши в 1-2 предл.»)
 *  - code       → читаем первые ~2 КБ, прогоняем через crystallizer-роль
 *                 («summarise this code in one sentence»). Без LLM — fallback по имени файла.
 *  - html-site  → читаем index.html (или первый html), извлекаем заголовок + первые
 *                 ~1 KB текста, прогоняем через crystallizer.
 *  - прочее     → fallback (имя+размер).
 *
 * Если LLM-роль не настроена / LM Studio офлайн — модуль **не падает**: возвращает
 * fallback-описания. Это критично: импорт папок должен работать всегда, LLM —
 * это украшение, а не зависимость.
 */

import { promises as fs } from "fs";
import * as path from "path";
import type { ClassifiedFile, BookBundle } from "./classifier.js";
import type { SidecarDescription } from "./markdown-builder.js";

export interface DescribeSidecarsOptions {
  /** Параллельный поток описаний. Default 2 (LM Studio плохо переносит >2 параллели). */
  concurrency?: number;
  /** Прогресс-каллбэк. */
  onProgress?: (e: DescribeProgressEvent) => void;
  /** Опционально — кастомные функции для тестов. */
  describeImage?: (filePath: string) => Promise<string>;
  describeText?: (text: string, kind: "code" | "html-site") => Promise<string>;
  signal?: AbortSignal;
  /** Cap по символам для чтения текстовых sidecar (защита от 10MB html). */
  maxTextChars?: number;
}

export type DescribeProgressEvent =
  | { type: "describe.start"; total: number }
  | { type: "describe.file.start"; absPath: string; kind: ClassifiedFile["kind"]; index: number; total: number }
  | { type: "describe.file.done"; absPath: string; ok: boolean; reason?: string; durationMs: number }
  | { type: "describe.done"; described: number; failed: number };

const DEFAULT_MAX_TEXT_CHARS = 4_000;

export async function describeSidecars(
  bundle: BookBundle,
  opts: DescribeSidecarsOptions = {},
): Promise<{ descriptions: Map<string, SidecarDescription>; warnings: string[] }> {
  const targets = bundle.sidecars.filter((s) =>
    s.kind === "image" || s.kind === "code" || s.kind === "html-site",
  );
  const descriptions = new Map<string, SidecarDescription>();
  const warnings: string[] = [];
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? 2, 4));
  const maxTextChars = opts.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS;

  opts.onProgress?.({ type: "describe.start", total: targets.length });

  let described = 0;
  let failed = 0;
  let cursor = 0;

  const worker = async (workerId: number): Promise<void> => {
    void workerId;
    while (cursor < targets.length) {
      if (opts.signal?.aborted) return;
      const idx = cursor++;
      const file = targets[idx]!;
      const t0 = Date.now();
      opts.onProgress?.({ type: "describe.file.start", absPath: file.absPath, kind: file.kind, index: idx, total: targets.length });

      try {
        const desc = await describeOne(file, opts, maxTextChars);
        if (desc) {
          descriptions.set(file.absPath, desc);
          described++;
          opts.onProgress?.({ type: "describe.file.done", absPath: file.absPath, ok: true, durationMs: Date.now() - t0 });
        } else {
          failed++;
          opts.onProgress?.({ type: "describe.file.done", absPath: file.absPath, ok: false, reason: "skip", durationMs: Date.now() - t0 });
        }
      } catch (e) {
        failed++;
        const reason = e instanceof Error ? e.message : String(e);
        warnings.push(`describe ${file.relPath}: ${reason}`);
        opts.onProgress?.({ type: "describe.file.done", absPath: file.absPath, ok: false, reason, durationMs: Date.now() - t0 });
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, (_, i) => worker(i)));
  opts.onProgress?.({ type: "describe.done", described, failed });
  return { descriptions, warnings };
}

async function describeOne(
  file: ClassifiedFile,
  opts: DescribeSidecarsOptions,
  maxTextChars: number,
): Promise<SidecarDescription | null> {
  if (file.kind === "image") {
    if (opts.describeImage) {
      const desc = await opts.describeImage(file.absPath);
      return { absPath: file.absPath, title: file.baseName, description: desc };
    }
    /* default: используем vision-meta extraction в light режиме. */
    const desc = await defaultDescribeImage(file.absPath);
    return desc ? { absPath: file.absPath, title: file.baseName, description: desc } : null;
  }

  if (file.kind === "code" || file.kind === "html-site") {
    let text = "";
    try {
      text = await fs.readFile(file.absPath, "utf8");
    } catch (e) {
      return null;
    }
    const trimmed = text.slice(0, maxTextChars);
    if (trimmed.trim().length === 0) return null;

    const desc = opts.describeText
      ? await opts.describeText(trimmed, file.kind)
      : await defaultDescribeText(trimmed, file.kind);
    if (!desc) return null;

    return {
      absPath: file.absPath,
      title: file.baseName,
      description: desc,
      fullText: file.kind === "code" ? trimmed : undefined,
    };
  }

  return null;
}

/* ─── Default LLM hooks ──────────────────────────────────────────────── */

async function defaultDescribeImage(absPath: string): Promise<string | null> {
  try {
    const { extractMetadataFromCover } = await import("../../llm/vision-meta.js");
    const buf = await fs.readFile(absPath);
    const result = await extractMetadataFromCover(buf, {});
    if (!result.ok || !result.meta) return null;
    /* extractMetadataFromCover возвращает structured meta — соберём
       одно-предложенческое описание из неё. */
    const m = result.meta as { title?: string; subtitle?: string; description?: string };
    const parts = [m.title, m.subtitle, m.description].filter((s): s is string => typeof s === "string" && s.trim().length > 0);
    if (parts.length === 0) return `Illustration: ${path.basename(absPath)}`;
    return parts.join(". ").slice(0, 240);
  } catch {
    return null;
  }
}

async function defaultDescribeText(text: string, kind: "code" | "html-site"): Promise<string | null> {
  try {
    const { modelRoleResolver } = await import("../../llm/model-role-resolver.js");
    const { chatWithPolicy } = await import("../../../lmstudio-client.js");
    const role = await modelRoleResolver.resolve("crystallizer");
    if (!role) return null;

    const system = kind === "code"
      ? "You are a concise code summariser. Describe the purpose of the code in ONE short sentence (≤180 chars). No code blocks, no quotes."
      : "You are a concise web-page summariser. Describe what this HTML page is about in ONE short sentence (≤180 chars). No HTML, no quotes.";

    const resp = await chatWithPolicy({
      model: role.modelKey,
      messages: [
        { role: "system", content: system },
        { role: "user", content: text },
      ],
      sampling: { temperature: 0.2, top_p: 0.9, top_k: 40, min_p: 0, presence_penalty: 0, max_tokens: 120 },
    }, {});
    const out = (resp.content ?? "").trim();
    return out.length > 0 ? out.slice(0, 240) : null;
  } catch {
    return null;
  }
}
