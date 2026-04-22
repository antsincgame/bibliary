/**
 * Phase 4.0 — Tool Registry для агента.
 *
 * Каждый tool — Zod-схема + execute (с typed args).
 * Read-only tools: policy="auto" (без approval).
 * Destructive tools: policy="approval-required" — agent loop ждёт UI-апрува
 *   перед запуском.
 *
 * Tools интегрируются с уже существующими модулями:
 *   - aggregateSearch (BookHunter)
 *   - probeBooks, parseBook, ingestBook (scanner)
 *   - extractChapterConcepts → judgeAndAccept (dataset-v2)
 *   - getCollections, qdrant search
 *   - getPromptStore (read/write roles)
 */

import { z } from "zod";
import { promises as fs } from "fs";
import { aggregateSearch } from "../bookhunter/index.js";
import { probeBooks, isSupportedBook } from "../scanner/parsers/index.js";
import { ingestBook, ScannerStateStore } from "../scanner/index.js";
import { fetchQdrantJson, QDRANT_URL, QDRANT_API_KEY } from "../qdrant/http-client.js";
import { searchRelevantChunks, getRagConfig } from "../rag/index.js";
import { getPromptStore, DatasetRolesSchema } from "../prompts/store.js";
import type { ToolDefinition, OpenAiToolDefinition } from "./types.js";

/* ───────────────── helpers ───────────────── */

function zodToOpenAiSchema(schema: z.ZodType): Record<string, unknown> {
  /** Минимальный converter Zod → JSON Schema (только типы, нужные нашим tools). */
  if (schema instanceof z.ZodObject) {
    const shape = (schema as z.ZodObject<z.ZodRawShape>).shape;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [key, child] of Object.entries(shape)) {
      properties[key] = zodToOpenAiSchema(child as z.ZodType);
      if (!(child instanceof z.ZodOptional) && !(child instanceof z.ZodDefault)) required.push(key);
    }
    return { type: "object", properties, required, additionalProperties: false };
  }
  if (schema instanceof z.ZodOptional) return zodToOpenAiSchema((schema as z.ZodOptional<z.ZodType>).unwrap());
  if (schema instanceof z.ZodDefault) return zodToOpenAiSchema((schema as z.ZodDefault<z.ZodType>)._def.innerType);
  if (schema instanceof z.ZodString) return { type: "string" };
  if (schema instanceof z.ZodNumber) return { type: "number" };
  if (schema instanceof z.ZodBoolean) return { type: "boolean" };
  if (schema instanceof z.ZodArray) {
    return { type: "array", items: zodToOpenAiSchema((schema as z.ZodArray<z.ZodType>).element) };
  }
  if (schema instanceof z.ZodEnum) {
    return { type: "string", enum: (schema as z.ZodEnum<[string, ...string[]]>).options };
  }
  if (schema instanceof z.ZodLiteral) {
    return { type: "string", const: String((schema as z.ZodLiteral<unknown>).value) };
  }
  if (schema instanceof z.ZodUnion) {
    return { anyOf: (schema as z.ZodUnion<readonly [z.ZodType, ...z.ZodType[]]>).options.map(zodToOpenAiSchema) };
  }
  return {};
}

function previewObject(v: unknown, max = 200): string {
  try {
    const s = JSON.stringify(v);
    return s.length > max ? s.slice(0, max) + "…" : s;
  } catch {
    return String(v).slice(0, max);
  }
}

/* ───────────────── tools ───────────────── */

const listCollectionsTool: ToolDefinition<Record<string, never>, string[]> = {
  name: "list_collections",
  description: "Список Qdrant-коллекций. Возвращает массив имён.",
  policy: "auto",
  argsSchema: z.object({}).strict() as unknown as z.ZodType<Record<string, never>>,
  execute: async () => {
    const data = await fetchQdrantJson<{ result: { collections: Array<{ name: string }> } }>(
      `${QDRANT_URL}/collections`
    );
    return data.result.collections.map((c) => c.name);
  },
};

const searchCollectionTool: ToolDefinition<{ query: string; collection: string; k?: number }, unknown> = {
  name: "search_collection",
  description:
    "Семантический поиск в Qdrant-коллекции по тексту запроса. Возвращает топ-k концептов с principle/explanation/score.",
  policy: "auto",
  argsSchema: z.object({
    query: z.string().min(1).describe("естественный язык, что искать"),
    collection: z.string().min(1).describe("имя коллекции Qdrant"),
    k: z.number().int().min(1).max(20).optional().describe("сколько результатов вернуть (default 5)"),
  }),
  execute: async ({ query, collection, k }) => {
    const ragCfg = await getRagConfig();
    const results = await searchRelevantChunks(collection, query, k ?? 5, ragCfg.scoreThreshold);
    return results.map((r) => ({
      score: r.score,
      principle: String(r.payload.principle ?? ""),
      explanation: String(r.payload.explanation ?? "").slice(0, 300),
      domain: String(r.payload.domain ?? ""),
    }));
  },
};

const listBooksTool: ToolDefinition<{ folder: string }, Array<{ fileName: string; ext: string; sizeMB: number }>> = {
  name: "list_books",
  description:
    "Просканировать локальную папку рекурсивно (depth=2) и вернуть список поддерживаемых книг (PDF/EPUB/FB2/DOCX/TXT).",
  policy: "auto",
  argsSchema: z.object({
    folder: z.string().min(1).describe("абсолютный путь к папке"),
  }),
  execute: async ({ folder }) => {
    const probed = await probeBooks(folder, 2);
    return probed.map((p) => ({
      fileName: p.fileName,
      ext: p.ext,
      sizeMB: +(p.sizeBytes / 1024 / 1024).toFixed(2),
    }));
  },
};

const bookhunterSearchTool: ToolDefinition<
  { query: string; sources?: Array<"gutendex" | "archive" | "openlibrary" | "arxiv">; language?: string },
  unknown
> = {
  name: "bookhunter_search",
  description:
    "Поиск книг через legal API: Project Gutenberg, Internet Archive, Open Library, arXiv. Возвращает кандидатов с license, formats, downloadUrl.",
  policy: "auto",
  argsSchema: z.object({
    query: z.string().min(1),
    sources: z.array(z.enum(["gutendex", "archive", "openlibrary", "arxiv"])).optional(),
    language: z.string().optional().describe("ISO 639-1 (en, ru, ...)"),
  }),
  execute: async ({ query, sources, language }) => {
    const results = await aggregateSearch({ query, sources, language, perSourceLimit: 5 });
    return results.slice(0, 10).map((r) => ({
      id: r.id,
      sourceTag: r.sourceTag,
      title: r.title,
      authors: r.authors,
      license: r.license,
      formats: r.formats.map((f) => f.format),
      year: r.year,
      webPageUrl: r.webPageUrl,
    }));
  },
};

/* ───────── Destructive tools (approval-required) ───────── */

const ingestBookTool: ToolDefinition<{ filePath: string; collection: string }, unknown> = {
  name: "ingest_book",
  description:
    "Распарсить локальную книгу (PDF/EPUB/FB2/DOCX/TXT), сделать chunks, embed и upsert в Qdrant-коллекцию.",
  policy: "approval-required",
  describeCall: ({ filePath, collection }) => `Ingest «${filePath}» в коллекцию «${collection}»`,
  argsSchema: z.object({
    filePath: z.string().min(1).describe("абсолютный путь к файлу книги"),
    collection: z.string().min(1).describe("имя Qdrant-коллекции"),
  }),
  execute: async ({ filePath, collection }, ctx) => {
    if (!isSupportedBook(filePath)) throw new Error(`unsupported file: ${filePath}`);
    const stateStore = new ScannerStateStore(`${process.env.USERPROFILE || "/tmp"}/scanner-progress.json`);
    return ingestBook(filePath, {
      collection,
      qdrantUrl: QDRANT_URL,
      qdrantApiKey: QDRANT_API_KEY,
      state: stateStore,
      signal: ctx.signal,
    });
  },
};

const deleteFromCollectionTool: ToolDefinition<{ collection: string; bookSourcePath: string }, { ok: true }> = {
  name: "delete_from_collection",
  description:
    "Удалить ВСЕ точки книги из Qdrant-коллекции (filter по bookSourcePath). Безвозвратно.",
  policy: "approval-required",
  describeCall: ({ collection, bookSourcePath }) => `Удалить «${bookSourcePath}» из «${collection}»`,
  argsSchema: z.object({
    collection: z.string().min(1),
    bookSourcePath: z.string().min(1),
  }),
  execute: async ({ collection, bookSourcePath }) => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (QDRANT_API_KEY) headers["api-key"] = QDRANT_API_KEY;
    const resp = await fetch(`${QDRANT_URL}/collections/${encodeURIComponent(collection)}/points/delete?wait=true`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        filter: { must: [{ key: "bookSourcePath", match: { value: bookSourcePath } }] },
      }),
    });
    if (!resp.ok) throw new Error(`qdrant delete ${resp.status}`);
    return { ok: true as const };
  },
};

const writeRoleTool: ToolDefinition<
  { roleName: "T1" | "T2" | "T3"; field: "system" | "voice" | "format" | "exemplar"; value: string },
  unknown
> = {
  name: "write_role",
  description:
    "Изменить одно поле dataset-роли (T1/T2/T3) — system/voice/format/exemplar. Используется когда пользователь хочет тюнить промпты через чат.",
  policy: "approval-required",
  describeCall: ({ roleName, field, value }) =>
    `Перезаписать ${roleName}.${field} = «${value.slice(0, 60)}…»`,
  argsSchema: z.object({
    roleName: z.enum(["T1", "T2", "T3"]),
    field: z.enum(["system", "voice", "format", "exemplar"]),
    value: z.string().min(5),
  }),
  execute: async ({ roleName, field, value }) => {
    const store = getPromptStore();
    const roles = await store.readDatasetRoles();
    const updated = { ...roles, [roleName]: { ...roles[roleName], [field]: value } };
    const validated = DatasetRolesSchema.parse(updated);
    await store.writeDatasetRoles(validated);
    return { ok: true as const, roleName, field };
  },
};

/* ───────── Registry ───────── */

const ALL_TOOLS: ToolDefinition<never, unknown>[] = [
  listCollectionsTool as unknown as ToolDefinition<never, unknown>,
  searchCollectionTool as unknown as ToolDefinition<never, unknown>,
  listBooksTool as unknown as ToolDefinition<never, unknown>,
  bookhunterSearchTool as unknown as ToolDefinition<never, unknown>,
  ingestBookTool as unknown as ToolDefinition<never, unknown>,
  deleteFromCollectionTool as unknown as ToolDefinition<never, unknown>,
  writeRoleTool as unknown as ToolDefinition<never, unknown>,
];

const REGISTRY = new Map<string, ToolDefinition<unknown, unknown>>(
  ALL_TOOLS.map((t) => [t.name, t as unknown as ToolDefinition<unknown, unknown>])
);

export function getTool(name: string): ToolDefinition<unknown, unknown> | undefined {
  return REGISTRY.get(name);
}

export function listToolDefinitions(): OpenAiToolDefinition[] {
  return Array.from(REGISTRY.values()).map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: zodToOpenAiSchema(t.argsSchema),
    },
  }));
}

export function listToolNames(): string[] {
  return Array.from(REGISTRY.keys());
}

export function isPolicyAuto(toolName: string): boolean {
  const t = REGISTRY.get(toolName);
  return t?.policy === "auto";
}

export function describeToolCall(toolName: string, args: unknown): string {
  const t = REGISTRY.get(toolName);
  if (!t) return `unknown tool ${toolName}`;
  if (t.describeCall) {
    try {
      return t.describeCall(args);
    } catch {
      /* fall through */
    }
  }
  return `${toolName}(${previewObject(args, 80)})`;
}

export const __testing__ = { previewObject, zodToOpenAiSchema };
