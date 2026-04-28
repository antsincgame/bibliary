/**
 * Dataset Export — Qdrant концепты → JSONL для облачного fine-tuning.
 *
 * Прагматичный шаблонный экспорт без LLM-синтеза:
 *   каждый принятый концепт превращается в N диалоговых примеров,
 *   варьируя формулировку user-запроса и глубину assistant-ответа.
 *
 * Поддерживаются форматы для основных облачных провайдеров:
 *   - ShareGPT JSONL  → Together AI, Fireworks, HuggingFace AutoTrain, Axolotl
 *   - ChatML JSONL    → OpenAI fine-tune, Mistral La Plateforme
 *
 * Выход — папка с {train,val}.jsonl + README.md + meta.json.
 */

import { promises as fs } from "fs";
import * as path from "path";
import { fetchQdrantJson, QDRANT_URL, SCROLL_PAGE_SIZE } from "../qdrant/http-client.js";
import { assertValidCollectionName } from "./types.js";
import {
  type ShareGPTLine,
  type ChatMLLine,
  type DatasetFormat,
  shareGptToChatML,
  shareGptLinesToJsonl,
  chatMLLinesToJsonl,
  splitLines,
} from "./format.js";

interface RawConcept {
  id: string;
  domain: string;
  essence: string;
  cipher?: string;
  proof?: string;
  applicability?: string;
  chapterContext?: string;
  tags: string[];
  bookSourcePath?: string;
}

interface QdrantPoint {
  id: string | number;
  payload?: Record<string, unknown>;
}

interface QdrantScrollResp {
  result: {
    points: QdrantPoint[];
    next_page_offset?: string | number | null;
  };
}

async function* iterConcepts(collection: string, limit?: number): AsyncGenerator<RawConcept> {
  let offset: string | number | null = null;
  let yielded = 0;
  for (;;) {
    const body: Record<string, unknown> = {
      limit: SCROLL_PAGE_SIZE,
      with_payload: true,
      with_vector: false,
    };
    if (offset !== null) body.offset = offset;

    const resp = await fetchQdrantJson<QdrantScrollResp>(
      `${QDRANT_URL}/collections/${collection}/points/scroll`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        timeoutMs: 60_000,
      },
    );
    for (const point of resp.result.points) {
      const c = parsePoint(point);
      if (!c) continue;
      yield c;
      yielded++;
      if (limit && yielded >= limit) return;
    }
    offset = resp.result.next_page_offset ?? null;
    if (!offset) return;
  }
}

function parsePoint(point: QdrantPoint): RawConcept | null {
  const p = (point.payload ?? {}) as Record<string, unknown>;
  const essence = String(p.essence ?? p.principle ?? "").trim();
  const domain = String(p.domain ?? "").trim();
  if (!essence || !domain) return null;
  const tags = Array.isArray(p.tags) ? (p.tags as unknown[]).map(String).filter(Boolean) : [];
  return {
    id: String(point.id),
    essence,
    domain,
    cipher: p.cipher ? String(p.cipher) : undefined,
    proof: p.proof ? String(p.proof) : undefined,
    applicability: p.applicability ? String(p.applicability) : undefined,
    chapterContext: p.chapterContext ? String(p.chapterContext) : undefined,
    bookSourcePath: p.bookSourcePath ? String(p.bookSourcePath) : undefined,
    tags,
  };
}

const QUESTION_VARIANTS = [
  "Сформулируй ключевой принцип одним-двумя предложениями.",
  "В чём суть? Дай конкретно, без воды.",
  "Объясни главную идею профессионалу в этой области.",
  "Назови основной принцип и кратко его обоснуй.",
  "Дай рабочую формулировку, которую можно применять.",
];

const SYSTEM_PROMPT_TEMPLATE = "Ты эксперт в области: {domain}. Отвечай по существу, без украшений.";

/**
 * Превратить концепт в N ShareGPT-диалогов с растущей детализацией.
 *  - 1: только essence
 *  - 2: + proof / cipher
 *  - 3+: + applicability
 */
export function conceptToShareGPT(concept: RawConcept, pairs: number): ShareGPTLine[] {
  const n = Math.max(1, Math.min(QUESTION_VARIANTS.length, pairs));
  const out: ShareGPTLine[] = [];
  const system = SYSTEM_PROMPT_TEMPLATE.replace("{domain}", concept.domain);

  for (let i = 0; i < n; i++) {
    const userQ = QUESTION_VARIANTS[i] ?? QUESTION_VARIANTS[0]!;
    const answer = buildAnswer(concept, i);
    if (!answer) continue;

    out.push({
      conversations: [
        { from: "system", value: system },
        { from: "human", value: userQ },
        { from: "gpt", value: answer },
      ],
      meta: {
        concept_id: concept.id,
        domain: concept.domain,
        tags: concept.tags,
        depth: i + 1,
        source_book: concept.bookSourcePath ?? null,
      },
    });
  }
  return out;
}

function buildAnswer(c: RawConcept, depth: number): string {
  const parts: string[] = [c.essence];
  if (depth >= 1 && c.proof) parts.push(`Обоснование: ${c.proof}`);
  if (depth >= 1 && !c.proof && c.cipher) parts.push(`Формула: ${c.cipher}`);
  if (depth >= 2 && c.applicability) parts.push(`Применение: ${c.applicability}`);
  return parts.filter(Boolean).join("\n\n").trim();
}

export interface ExportOptions {
  /** Qdrant-коллекция с принятыми концептами. */
  collection: string;
  /** Выходная папка. Будет создана. */
  outputDir: string;
  /** ShareGPT (Together/HF) или ChatML (OpenAI/Fireworks). */
  format: DatasetFormat;
  /** 1..5 примеров на концепт. */
  pairsPerConcept: number;
  /** Доля train (0.5..0.99). Default 0.9. */
  trainRatio?: number;
  /** Hard-cap на количество концептов (для отладки). */
  limit?: number;
  /** Seed для воспроизводимого split. Default 42. */
  seed?: number;
  /** Вызывается с каждой обработанной строкой — для прогресса. */
  onProgress?: (info: { conceptsRead: number; linesEmitted: number }) => void;
}

export interface ExportStats {
  concepts: number;
  byDomain: Record<string, number>;
  totalLines: number;
  trainLines: number;
  valLines: number;
  outputDir: string;
  format: DatasetFormat;
  files: string[];
}

export async function exportDataset(opts: ExportOptions): Promise<ExportStats> {
  assertValidCollectionName(opts.collection);
  const trainRatio = opts.trainRatio ?? 0.9;
  const seed = opts.seed ?? 42;
  const pairs = Math.max(1, Math.min(5, opts.pairsPerConcept));

  await fs.mkdir(opts.outputDir, { recursive: true });

  const allShareGpt: ShareGPTLine[] = [];
  const byDomain: Record<string, number> = {};
  let conceptsRead = 0;

  for await (const concept of iterConcepts(opts.collection, opts.limit)) {
    conceptsRead++;
    byDomain[concept.domain] = (byDomain[concept.domain] ?? 0) + 1;
    const lines = conceptToShareGPT(concept, pairs);
    for (const line of lines) allShareGpt.push(line);

    if (opts.onProgress && conceptsRead % 25 === 0) {
      opts.onProgress({ conceptsRead, linesEmitted: allShareGpt.length });
    }
  }

  if (allShareGpt.length === 0) {
    throw new Error(
      `В коллекции "${opts.collection}" нет принятых концептов. Сначала запусти извлечение знаний для книги.`,
    );
  }

  const split = splitLines(allShareGpt, { trainRatio, evalRatio: 0, seed });

  const files: string[] = [];

  if (opts.format === "sharegpt") {
    await fs.writeFile(path.join(opts.outputDir, "train.jsonl"), shareGptLinesToJsonl(split.train), "utf-8");
    files.push("train.jsonl");
    if (split.val.length > 0) {
      await fs.writeFile(path.join(opts.outputDir, "val.jsonl"), shareGptLinesToJsonl(split.val), "utf-8");
      files.push("val.jsonl");
    }
  } else {
    const trainCm = split.train.map(shareGptToChatML);
    const valCm = split.val.map(shareGptToChatML);
    await fs.writeFile(path.join(opts.outputDir, "train.jsonl"), chatMLLinesToJsonl(trainCm), "utf-8");
    files.push("train.jsonl");
    if (valCm.length > 0) {
      await fs.writeFile(path.join(opts.outputDir, "val.jsonl"), chatMLLinesToJsonl(valCm), "utf-8");
      files.push("val.jsonl");
    }
  }

  const meta = {
    generatedAt: new Date().toISOString(),
    sourceCollection: opts.collection,
    format: opts.format,
    pairsPerConcept: pairs,
    seed,
    trainRatio,
    concepts: conceptsRead,
    totalLines: allShareGpt.length,
    trainLines: split.train.length,
    valLines: split.val.length,
    byDomain,
  };
  await fs.writeFile(path.join(opts.outputDir, "meta.json"), JSON.stringify(meta, null, 2), "utf-8");
  files.push("meta.json");

  await fs.writeFile(path.join(opts.outputDir, "README.md"), buildReadme(meta), "utf-8");
  files.push("README.md");

  return {
    concepts: conceptsRead,
    byDomain,
    totalLines: allShareGpt.length,
    trainLines: split.train.length,
    valLines: split.val.length,
    outputDir: opts.outputDir,
    format: opts.format,
    files,
  };
}

function buildReadme(meta: {
  format: DatasetFormat;
  totalLines: number;
  trainLines: number;
  valLines: number;
  concepts: number;
  sourceCollection: string;
  generatedAt: string;
  byDomain: Record<string, number>;
}): string {
  const fmt = meta.format === "sharegpt" ? "ShareGPT" : "ChatML";
  const domains = Object.entries(meta.byDomain)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([d, n]) => `- ${d}: ${n}`)
    .join("\n");

  const cloudInstructions = meta.format === "sharegpt"
    ? CLOUD_SHAREGPT
    : CLOUD_CHATML;

  return `# Датасет для fine-tuning

Создано: ${meta.generatedAt}
Источник: коллекция \`${meta.sourceCollection}\`
Формат: **${fmt}** (${meta.format === "sharegpt" ? "Together AI / HuggingFace / Axolotl" : "OpenAI / Fireworks / Mistral"})

## Что внутри

| Файл | Назначение | Примеров |
|------|------------|----------|
| \`train.jsonl\` | обучающая выборка | ${meta.trainLines} |
| \`val.jsonl\` | проверка качества во время обучения | ${meta.valLines} |
| \`meta.json\` | метаданные (для воспроизводимости) | — |

Всего диалогов: **${meta.totalLines}** из **${meta.concepts}** концептов.

## Топ доменов

${domains || "—"}

## Как залить в облако

${cloudInstructions}

## Как обновить датасет

1. Добавь новые книги в библиотеку и запусти извлечение знаний
2. Открой раздел «Создание датасета» и нажми «Создать датасет» заново
3. Старые файлы будут перезаписаны

> Сгенерировано Bibliary. На благо всех живых существ. ॐ
`;
}

const CLOUD_SHAREGPT = `### Together AI
\`\`\`bash
together files upload train.jsonl --purpose fine-tune
together files upload val.jsonl --purpose fine-tune
together fine-tuning create \\
  --training-file <train_file_id> \\
  --validation-file <val_file_id> \\
  --model meta-llama/Meta-Llama-3.1-8B-Instruct-Reference \\
  --n-epochs 3
\`\`\`
Документация: https://docs.together.ai/docs/fine-tuning-quickstart

### HuggingFace AutoTrain
1. Создай Space → AutoTrain Advanced
2. Загрузи папку с \`train.jsonl\` и \`val.jsonl\`
3. Task = \`text-generation\` · Format = \`sharegpt\`
4. Запусти

### Axolotl (self-hosted, опционально)
\`\`\`yaml
datasets:
  - path: ./train.jsonl
    type: sharegpt
    conversation: chatml
val_set_size: 0.05
\`\`\`
`;

const CLOUD_CHATML = `### OpenAI fine-tuning
\`\`\`bash
openai api files.create -f train.jsonl --purpose fine-tune
openai api files.create -f val.jsonl --purpose fine-tune
openai api fine_tuning.jobs.create \\
  --training-file <train_file_id> \\
  --validation-file <val_file_id> \\
  --model gpt-4o-mini-2024-07-18
\`\`\`
Документация: https://platform.openai.com/docs/guides/fine-tuning

### Fireworks AI
\`\`\`bash
firectl create dataset bibliary-train --upload train.jsonl
firectl create dataset bibliary-val --upload val.jsonl
firectl create sftj \\
  --base-model accounts/fireworks/models/llama-v3p1-8b-instruct \\
  --dataset bibliary-train \\
  --evaluation-dataset bibliary-val \\
  --epochs 3
\`\`\`

### Mistral La Plateforme
1. Загрузи \`train.jsonl\` и \`val.jsonl\` в \`/v1/files\` (purpose=fine-tune)
2. POST \`/v1/fine_tuning/jobs\` с полями training_files и validation_files
3. Документация: https://docs.mistral.ai/capabilities/finetuning/
`;
