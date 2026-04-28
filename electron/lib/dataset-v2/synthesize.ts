/**
 * synthesize.ts — In-process LLM-синтез датасета.
 *
 * Контракт: на каждый принятый концепт LLM генерирует N разнообразных
 * Q/A-пар. Вопросы — реалистичные, разные по углу (применение, edge case,
 * сравнение, troubleshooting). Ответы — 3-7 предложений, без переписывания
 * исходной цитаты.
 *
 * Почему in-process, а не child-process через `npx tsx`:
 *  - в собранном `.exe` после `npm prune` нет tsx → child падал;
 *  - прогресс шёл в `.log` файл, UI его не видел;
 *  - не было общего AbortController с export/extraction.
 *
 * Поток:
 *   iterAcceptedConcepts → buildSynthMessages → chat → parseSynthResponse
 *   → conceptToShareGPT → splitLines → write {train,val}.jsonl + meta + README
 *
 * События для UI идут через onProgress({phase, conceptsRead, paired, skipped}).
 */

import { promises as fs } from "fs";
import * as path from "path";
import { z } from "zod";
import { chatWithPolicy } from "../../lmstudio-client.js";
import { getModelProfile } from "./model-profile.js";
import { assertValidCollectionName } from "./types.js";
import { iterAcceptedConcepts, type AcceptedConcept } from "./concept-loader.js";
import {
  type ShareGPTLine,
  type DatasetFormat,
  shareGptToChatML,
  shareGptLinesToJsonl,
  chatMLLinesToJsonl,
  splitLines,
} from "./format.js";

const SYNTH_SYSTEM_PROMPT = `Ты — опытный методист, готовящий датасет для дообучения языковой модели.
По одному концепту-знанию (с обоснованием, формулой, областью применения) сформулируй {{N}} разных Q/A-пар, которые научат модель применять этот концепт на практике.

ПРАВИЛА:
1. Каждый вопрос — это реалистичный запрос, который мог бы задать практик в этой сфере (НЕ квиз).
2. Каждый ответ — 3–7 предложений, по существу, без воды и общих мотивирующих фраз.
3. Разнообразие вопросов: применение / краевой случай / сравнение / диагностика проблем.
4. НИКОГДА не переписывай исходную цитату дословно — перефразируй.
5. Ответы должны звучать естественно на русском языке (если концепт на русском) или на английском (если концепт на английском).
6. Строго JSON. Никакого текста до или после. Без markdown-обёрток.

OUTPUT SCHEMA:
{
  "pairs": [
    { "question": "...", "answer": "..." }
  ]
}`;

const SynthPairSchema = z.object({
  question: z.string().min(8).max(800),
  answer: z.string().min(40).max(4000),
});

const SynthResponseSchema = z.object({
  pairs: z.array(SynthPairSchema).min(1).max(5),
});

export type SynthPair = z.infer<typeof SynthPairSchema>;

function buildSynthUserMessage(c: AcceptedConcept, pairsN: number): string {
  const lines: string[] = [
    `Сгенерируй ${pairsN} Q/A-пары по следующему концепту.`,
    "",
    `СФЕРА: ${c.domain}`,
    `СУТЬ: ${c.essence}`,
  ];
  if (c.proof) lines.push(`ОБОСНОВАНИЕ: ${c.proof}`);
  if (c.cipher) lines.push(`ФОРМУЛА: ${c.cipher}`);
  if (c.applicability) lines.push(`ГДЕ ПРИМЕНЯТЬ: ${c.applicability}`);
  if (c.tags.length > 0) lines.push(`ТЕГИ: ${c.tags.join(", ")}`);
  if (c.chapterContext) lines.push(`КОНТЕКСТ ГЛАВЫ: ${c.chapterContext}`);
  return lines.join("\n");
}

function extractJsonObject(raw: string): unknown | null {
  if (!raw) return null;
  /* drop optional <think>...</think> trace */
  const cleaned = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) return null;
  try {
    return JSON.parse(cleaned.slice(first, last + 1));
  } catch {
    return null;
  }
}

function pairToShareGPT(
  concept: AcceptedConcept,
  pair: SynthPair,
  pairIndex: number,
): ShareGPTLine {
  const system = `Ты эксперт в области: ${concept.domain}. Отвечай по существу, без украшений.`;
  return {
    conversations: [
      { from: "system", value: system },
      { from: "human", value: pair.question.trim() },
      { from: "gpt", value: pair.answer.trim() },
    ],
    meta: {
      concept_id: concept.id,
      domain: concept.domain,
      tags: concept.tags,
      depth: pairIndex + 1,
      source_book: concept.bookSourcePath ?? null,
      synthesized: true,
    },
  };
}

export interface SynthOptions {
  collection: string;
  outputDir: string;
  format: DatasetFormat;
  pairsPerConcept: number;
  /** LLM-модель (modelKey из LM Studio). */
  model: string;
  /** Доля train (default 0.9). */
  trainRatio?: number;
  /** Hard-cap на концепты (для теста). */
  limit?: number;
  /** Seed для воспроизводимости. */
  seed?: number;
  /** Внешний AbortSignal. */
  signal?: AbortSignal;
  /** Callback прогресса — вызывается часто, агрегируется на стороне UI. */
  onProgress?: (info: SynthProgress) => void;
}

export interface SynthProgress {
  phase: "scan" | "generate" | "write" | "done";
  conceptsRead: number;
  conceptsTotal: number | null;
  paired: number;
  skippedEmpty: number;
  skippedLlmFail: number;
  skippedSchemaFail: number;
  currentDomain?: string;
  currentEssence?: string;
}

export interface SynthStats {
  concepts: number;
  byDomain: Record<string, number>;
  totalLines: number;
  trainLines: number;
  valLines: number;
  outputDir: string;
  format: DatasetFormat;
  files: string[];
  llmFailures: number;
  schemaFailures: number;
  emptyPayloadSkips: number;
  model: string;
  durationMs: number;
}

/**
 * Запустить in-process синтез. Не возвращает управление пока не завершит
 * запись JSONL и meta. Прогресс регулярно сыпется через onProgress.
 */
export async function synthesizeDataset(
  opts: SynthOptions,
): Promise<SynthStats> {
  assertValidCollectionName(opts.collection);
  const trainRatio = opts.trainRatio ?? 0.9;
  const seed = opts.seed ?? 42;
  const pairsN = Math.max(1, Math.min(5, opts.pairsPerConcept));
  const t0 = Date.now();

  await fs.mkdir(opts.outputDir, { recursive: true });

  const profile = await getModelProfile(opts.model);
  const allShareGpt: ShareGPTLine[] = [];
  const byDomain: Record<string, number> = {};
  let conceptsRead = 0;
  let llmFailures = 0;
  let schemaFailures = 0;
  let emptyPayloadSkips = 0;

  const systemFilled = SYNTH_SYSTEM_PROMPT.replace(/\{\{N\}\}/g, String(pairsN));

  const emit = (extra: Partial<SynthProgress>): void => {
    if (!opts.onProgress) return;
    opts.onProgress({
      phase: "generate",
      conceptsRead,
      conceptsTotal: null,
      paired: allShareGpt.length,
      skippedEmpty: emptyPayloadSkips,
      skippedLlmFail: llmFailures,
      skippedSchemaFail: schemaFailures,
      ...extra,
    });
  };

  emit({ phase: "scan" });

  for await (const concept of iterAcceptedConcepts(opts.collection, {
    limit: opts.limit,
    signal: opts.signal,
  })) {
    if (opts.signal?.aborted) break;

    conceptsRead++;
    emit({
      phase: "generate",
      currentDomain: concept.domain,
      currentEssence: concept.essence.slice(0, 120),
    });

    const userMsg = buildSynthUserMessage(concept, pairsN);

    let raw = "";
    try {
      const resp = await chatWithPolicy(
        {
          model: opts.model,
          messages: [
            { role: "system", content: systemFilled },
            { role: "user", content: userMsg },
          ],
          sampling: {
            temperature: 0.7,
            top_p: 0.9,
            top_k: 40,
            min_p: 0,
            presence_penalty: 0,
            max_tokens: Math.max(2048, profile.maxTokens),
          },
          stop: profile.stop,
          chatTemplateKwargs: profile.chatTemplateKwargs,
        },
        { externalSignal: opts.signal },
      );
      raw = resp.content ?? "";
    } catch (err) {
      llmFailures++;
      console.warn(
        `[synth] LLM error on concept ${concept.id}: ${err instanceof Error ? err.message : err}`,
      );
      emit({});
      continue;
    }

    const parsed = extractJsonObject(raw);
    const validated = SynthResponseSchema.safeParse(parsed);
    if (!validated.success) {
      schemaFailures++;
      console.warn(
        `[synth] schema fail on concept ${concept.id}: ${validated.error.issues
          .slice(0, 2)
          .map((i) => i.message)
          .join("; ")}`,
      );
      emit({});
      continue;
    }

    byDomain[concept.domain] = (byDomain[concept.domain] ?? 0) + 1;

    validated.data.pairs.slice(0, pairsN).forEach((pair, idx) => {
      allShareGpt.push(pairToShareGPT(concept, pair, idx));
    });

    emit({});
  }

  if (allShareGpt.length === 0) {
    throw new Error(
      `LLM-синтез не дал ни одной валидной Q/A пары для коллекции "${opts.collection}". ` +
        `Возможные причины: коллекция пуста, LM Studio недоступен, выбрана модель без поддержки JSON, либо все ответы не прошли schema-валидацию.`,
    );
  }

  emit({ phase: "write" });

  const split = splitLines(allShareGpt, { trainRatio, evalRatio: 0, seed });
  const files: string[] = [];

  if (opts.format === "sharegpt") {
    await fs.writeFile(
      path.join(opts.outputDir, "train.jsonl"),
      shareGptLinesToJsonl(split.train),
      "utf-8",
    );
    files.push("train.jsonl");
    if (split.val.length > 0) {
      await fs.writeFile(
        path.join(opts.outputDir, "val.jsonl"),
        shareGptLinesToJsonl(split.val),
        "utf-8",
      );
      files.push("val.jsonl");
    }
  } else {
    const trainCm = split.train.map(shareGptToChatML);
    const valCm = split.val.map(shareGptToChatML);
    await fs.writeFile(
      path.join(opts.outputDir, "train.jsonl"),
      chatMLLinesToJsonl(trainCm),
      "utf-8",
    );
    files.push("train.jsonl");
    if (valCm.length > 0) {
      await fs.writeFile(
        path.join(opts.outputDir, "val.jsonl"),
        chatMLLinesToJsonl(valCm),
        "utf-8",
      );
      files.push("val.jsonl");
    }
  }

  const meta = {
    generatedAt: new Date().toISOString(),
    sourceCollection: opts.collection,
    format: opts.format,
    method: "llm-synth" as const,
    model: opts.model,
    pairsPerConcept: pairsN,
    seed,
    trainRatio,
    concepts: conceptsRead,
    totalLines: allShareGpt.length,
    trainLines: split.train.length,
    valLines: split.val.length,
    byDomain,
    llmFailures,
    schemaFailures,
    emptyPayloadSkips,
    durationMs: Date.now() - t0,
  };
  await fs.writeFile(
    path.join(opts.outputDir, "meta.json"),
    JSON.stringify(meta, null, 2),
    "utf-8",
  );
  files.push("meta.json");

  await fs.writeFile(
    path.join(opts.outputDir, "README.md"),
    buildSynthReadme(meta),
    "utf-8",
  );
  files.push("README.md");

  emit({ phase: "done" });

  return {
    concepts: conceptsRead,
    byDomain,
    totalLines: allShareGpt.length,
    trainLines: split.train.length,
    valLines: split.val.length,
    outputDir: opts.outputDir,
    format: opts.format,
    files,
    llmFailures,
    schemaFailures,
    emptyPayloadSkips,
    model: opts.model,
    durationMs: Date.now() - t0,
  };
}

function buildSynthReadme(meta: {
  format: DatasetFormat;
  totalLines: number;
  trainLines: number;
  valLines: number;
  concepts: number;
  sourceCollection: string;
  generatedAt: string;
  byDomain: Record<string, number>;
  model: string;
  llmFailures: number;
  schemaFailures: number;
  durationMs: number;
}): string {
  const fmt = meta.format === "sharegpt" ? "ShareGPT" : "ChatML";
  const domains = Object.entries(meta.byDomain)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([d, n]) => `- ${d}: ${n}`)
    .join("\n");
  const minutes = (meta.durationMs / 60_000).toFixed(1);

  return `# Датасет для fine-tuning (LLM-синтез)

Сгенерирован: ${meta.generatedAt}
Коллекция-источник: \`${meta.sourceCollection}\`
Формат: ${fmt}
Способ: LLM-синтез (модель: \`${meta.model}\`)

## Статистика

- Концептов прочитано: ${meta.concepts}
- Q/A примеров: ${meta.totalLines}
- Train: ${meta.trainLines}
- Val: ${meta.valLines}
- Время генерации: ${minutes} мин
- LLM-сбои: ${meta.llmFailures}
- Schema-сбои: ${meta.schemaFailures}

## Топ-доменов

${domains || "—"}

## Что это

Каждый принятый концепт из коллекции прошёл через языковую модель,
которая сформулировала несколько разных вопросов с разнообразными углами
(применение, edge case, сравнение, диагностика) и развёрнутые ответы.
Это даёт более естественный и разнообразный датасет, чем шаблонный экспорт.

## Файлы

- \`train.jsonl\` — обучающая выборка
- \`val.jsonl\` — валидационная (если есть)
- \`meta.json\` — все метаданные прогона
- \`README.md\` — этот файл

## Заливка в облако

Тот же путь, что и для шаблонного экспорта. Этот датасет совместим с
Together AI / OpenAI / Fireworks / HuggingFace / Axolotl.
`;
}
