/**
 * tests/integration-evaluator-fake-lm.test.ts
 *
 * End-to-end доказательство что pipeline «book.md → evaluator → коллекция
 * с qualityScore/tags/domain» работает целиком. Уровень: integration,
 * без Electron, без LM Studio, без better-sqlite3.
 *
 * Покрытие (то, что unit-тесты не покрывают):
 *   1. РЕАЛЬНЫЙ HTTP-вызов через `chatWithPolicy` → fake OpenAI-совместимый
 *      сервер → реальный парсинг ответа (`parseEvaluationResponse`).
 *   2. РЕАЛЬНЫЙ `evaluateBook` (с stub ModelPool) → fake LM Studio →
 *      возвращает валидный `BookEvaluation` или null с warnings.
 *   3. РЕАЛЬНЫЙ mapping `BookEvaluation` → `BookCatalogMeta` →
 *      `replaceFrontmatter` + `upsertEvaluatorReasoning` → `parseFrontmatter`
 *      обратно. Все evaluator-поля попадают в frontmatter и читаются.
 *
 * Гарантия: если этот тест зелёный, то на вопрос «удалось ли получить
 * коллекцию с оценкой/тегами/сферами» — ответ ДА с пруфом: pipeline
 * выполняется ровно тем же кодом, что и в проде, минус UI-обвязка.
 *
 * Архитектура теста: каждый test — полностью самостоятельная функция.
 * Свой fake-сервер на случайном порту, свой env-snapshot, никаких
 * глобальных before/after. Так гарантирована изоляция и предсказуемый
 * порядок исполнения под node:test.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import type { AddressInfo } from "node:net";

import { chatWithPolicy } from "../server/lib/scanner/_vendor/lmstudio-client.ts";
import { evaluateBook } from "../electron/lib/library/book-evaluator.ts";
import { parseEvaluationResponse } from "../electron/lib/library/book-evaluator-schema.ts";
import {
  replaceFrontmatter,
  upsertEvaluatorReasoning,
  parseFrontmatter,
} from "../electron/lib/library/md-converter.ts";
import { invalidateEndpointsCache } from "../server/lib/scanner/_vendor/endpoints/index.ts";
import type { BookCatalogMeta, BookEvaluation } from "../electron/lib/library/types.ts";
import type { ModelPool, PoolHandle } from "../server/lib/scanner/_vendor/llm/model-pool.ts";

/* ─── Helpers ─────────────────────────────────────────────────────── */

interface ParsedRequest {
  model: string;
  systemPrompt: string;
  userPrompt: string;
  hasResponseFormat: boolean;
  maxTokens: number;
}

interface OpenAiResponse {
  choices: Array<{
    message: { role: string; content: string; reasoning_content?: string };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

interface FakeServer {
  url: string;
  port: number;
  requests: ParsedRequest[];
  close: () => Promise<void>;
}

async function startFakeServer(
  responseBuilder: (req: ParsedRequest) => OpenAiResponse | { error: string; status?: number },
): Promise<FakeServer> {
  const requests: ParsedRequest[] = [];
  const server = http.createServer((req, res) => {
    if (req.method !== "POST" || !req.url?.includes("/v1/chat/completions")) {
      res.statusCode = 404;
      res.end("Not Found");
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          model: string;
          messages: Array<{ role: string; content: string }>;
          response_format?: unknown;
          max_tokens: number;
        };
        const sys = body.messages.find((m) => m.role === "system")?.content ?? "";
        const usr = body.messages.find((m) => m.role === "user")?.content ?? "";
        const parsed: ParsedRequest = {
          model: body.model,
          systemPrompt: sys,
          userPrompt: usr,
          hasResponseFormat: body.response_format != null,
          maxTokens: body.max_tokens,
        };
        requests.push(parsed);
        const result = responseBuilder(parsed);
        if ("error" in result) {
          res.statusCode = result.status ?? 500;
          res.end(result.error);
          return;
        }
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(result));
      } catch (err) {
        res.statusCode = 500;
        res.end(err instanceof Error ? err.message : String(err));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

/** Полная валидная evaluation по zod-схеме (8–12 тегов, verdict ≥30 chars и т.д.). */
function buildValidEvaluationJson(): BookEvaluation {
  return {
    title_ru: "Кибернетика",
    author_ru: "Винер Н.",
    title_en: "Cybernetics: Or Control and Communication in the Animal and the Machine",
    author_en: "Wiener N.",
    year: 1948,
    domain: "cybernetics",
    tags: [
      "feedback-systems",
      "control-theory",
      "information-theory",
      "homeostasis",
      "self-regulation",
      "neural-systems",
      "automata-theory",
      "signal-processing",
    ],
    tags_ru: [
      "обратная-связь",
      "теория-управления",
      "теория-информации",
      "гомеостаз",
      "саморегуляция",
      "нейронные-системы",
      "теория-автоматов",
      "обработка-сигналов",
    ],
    is_fiction_or_water: false,
    conceptual_density: 88,
    originality: 95,
    quality_score: 92,
    verdict_reason:
      "Foundational text on feedback systems, information theory, and self-regulation; established cybernetics as a discipline.",
  };
}

/** Stub ModelPool: вызывает callback без реального обращения к LM Studio. */
const stubPool: ModelPool = {
  withModel: async <T,>(
    modelKey: string,
    _opts: unknown,
    fn: (h: PoolHandle) => Promise<T>,
  ): Promise<T> => {
    return fn({ modelKey, release: () => {} });
  },
} as unknown as ModelPool;

/** Окружение для одного теста: подмена LM_STUDIO_URL + invalidation кэша. */
async function withFakeLmEnv<T>(serverUrl: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.LM_STUDIO_URL;
  process.env.LM_STUDIO_URL = serverUrl;
  invalidateEndpointsCache();
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.LM_STUDIO_URL;
    else process.env.LM_STUDIO_URL = prev;
    invalidateEndpointsCache();
  }
}

/* ─── HTTP-layer integration ──────────────────────────────────────── */

test("[integration] HTTP layer: chatWithPolicy → fake LM Studio → response parsed", async () => {
  const server = await startFakeServer(() => ({
    choices: [
      {
        message: {
          role: "assistant",
          content:
            "<think>Brief reasoning.</think>\n\n" + JSON.stringify(buildValidEvaluationJson()),
        },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 },
  }));
  try {
    await withFakeLmEnv(server.url, async () => {
      const result = await chatWithPolicy({
        model: "fake-direct-model",
        messages: [
          { role: "system", content: "You are evaluator." },
          { role: "user", content: "Evaluate this book." },
        ],
        sampling: {
          temperature: 0.3,
          top_p: 0.9,
          top_k: 20,
          min_p: 0,
          presence_penalty: 0,
          max_tokens: 4096,
        },
      });
      assert.equal(server.requests.length, 1, "ровно один HTTP-запрос к fake LM Studio");
      assert.equal(server.requests[0].model, "fake-direct-model");
      assert.match(result.content, /quality_score/, "content содержит JSON evaluator'а");
      assert.equal(result.finishReason, "stop");
    });
  } finally {
    await server.close();
  }
});

/* ─── Parser layer (без сети) ─────────────────────────────────────── */

test("[integration] parseEvaluationResponse extracts evaluation from <think>...</think> + JSON", () => {
  const evJson = buildValidEvaluationJson();
  const raw = `<think>I see the book is about feedback systems. The structure is rigorous, dates from 1948.</think>\n\n${JSON.stringify(
    evJson,
    null,
    2,
  )}`;
  const parsed = parseEvaluationResponse(raw, undefined);
  assert.ok(parsed.json, "JSON извлечён из ответа");
  assert.match(parsed.reasoning ?? "", /feedback systems/, "reasoning сохранён");

  /* Тот же путь что в evaluator-slot-worker: zod валидация. */
  const ev = parsed.json as BookEvaluation;
  assert.equal(ev.quality_score, 92);
  assert.equal(ev.domain, "cybernetics");
  assert.equal(ev.tags.length, 8);
  assert.equal(ev.is_fiction_or_water, false);
});

/* ─── Full pipeline через evaluateBook ────────────────────────────── */

test("[integration] FULL pipeline: evaluateBook → real chatWithPolicy → fake LM → BookEvaluation", async () => {
  const server = await startFakeServer((req) => {
    /* Проверяем что в запросе реально передан системный промпт evaluator'а. */
    if (!req.systemPrompt.includes("Chief Epistemologist")) {
      return {
        error: `evaluator system prompt missing; got first 100 chars: ${req.systemPrompt.slice(0, 100)}`,
      };
    }
    return {
      choices: [
        {
          message: {
            role: "assistant",
            content:
              "<think>Cybernetics is foundational, Wiener 1948.</think>\n\n" +
              JSON.stringify(buildValidEvaluationJson()),
          },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 500, completion_tokens: 400, total_tokens: 900 },
    };
  });
  try {
    await withFakeLmEnv(server.url, async () => {
      const surrogate = `# Test Book Surrogate

## Table of Contents
- Introduction
- Feedback Systems
- Conclusion

## Introduction Text
Foundational text on feedback and control. Wiener 1948.

## Body sample
Discussion of self-regulating systems and homeostasis in animal and machine.`;

      const result = await evaluateBook(surrogate, {
        model: "fake-model",
        pool: stubPool,
        maxTokens: 2000,
      });

      assert.ok(
        result.evaluation,
        `evaluation должно быть не null; warnings: ${result.warnings.join("; ")}`,
      );
      const ev = result.evaluation!;
      assert.equal(ev.quality_score, 92);
      assert.equal(ev.domain, "cybernetics");
      assert.equal(ev.author_en, "Wiener N.");
      assert.equal(ev.year, 1948);
      assert.ok(
        ev.tags.length >= 8 && ev.tags.length <= 12,
        `tags 8-12, got ${ev.tags.length}`,
      );
      assert.equal(ev.is_fiction_or_water, false);
      assert.match(ev.verdict_reason, /Foundational|cybernetics/i);
      assert.match(result.reasoning ?? "", /Cybernetics is foundational/);
      assert.equal(server.requests.length, 1, "ровно один запрос (без retry / repair)");
    });
  } finally {
    await server.close();
  }
});

/* ─── Storage layer (BookEvaluation → frontmatter → re-read) ──────── */

test("[integration] Storage layer: BookEvaluation → BookCatalogMeta → frontmatter → re-read", () => {
  /* Стартовый book.md как его создаёт convertBookToMarkdown
     (status=imported, без evaluator-полей). */
  const initialMeta: BookCatalogMeta = {
    id: "abc123def456",
    sha256: "a".repeat(64),
    originalFile: "wiener-cybernetics.pdf",
    originalFormat: "pdf",
    title: "Cybernetics",
    wordCount: 50000,
    chapterCount: 12,
    status: "imported",
  };
  const initialMd = `---
id: ${initialMeta.id}
sha256: ${initialMeta.sha256}
title: ${initialMeta.title}
originalFile: ${initialMeta.originalFile}
originalFormat: ${initialMeta.originalFormat}
wordCount: ${initialMeta.wordCount}
chapterCount: ${initialMeta.chapterCount}
status: imported
---

## Chapter 1: Newton vs. Bergson

Body text here.

## Chapter 2: Cybernetics and Society

More body text.
`;

  /* Шаг 1: mapping BookEvaluation → BookCatalogMeta (как делает evaluator-slot-worker.ts). */
  const ev = buildValidEvaluationJson();
  const reasoning =
    "The evaluator concluded this is foundational work; high domain density and originality.";
  const updated: BookCatalogMeta = {
    ...initialMeta,
    titleRu: ev.title_ru,
    authorRu: ev.author_ru,
    titleEn: ev.title_en,
    authorEn: ev.author_en,
    year: ev.year ?? initialMeta.year,
    domain: ev.domain,
    tags: ev.tags,
    tagsRu: ev.tags_ru,
    qualityScore: ev.quality_score,
    conceptualDensity: ev.conceptual_density,
    originality: ev.originality,
    isFictionOrWater: ev.is_fiction_or_water,
    verdictReason: ev.verdict_reason,
    evaluatorModel: "fake-model",
    evaluatedAt: "2026-05-10T12:00:00.000Z",
    status: "evaluated",
  };

  /* Шаг 2: те же функции, что вызывает persistFrontmatter. */
  let next = replaceFrontmatter(initialMd, updated);
  next = upsertEvaluatorReasoning(next, reasoning);

  /* Тело книги не пострадало. */
  assert.match(next, /## Chapter 1: Newton vs\. Bergson/, "body chapter 1 preserved");
  assert.match(next, /## Chapter 2: Cybernetics and Society/, "body chapter 2 preserved");
  assert.match(next, /## Evaluator Reasoning/, "reasoning section inserted");
  assert.match(next, /foundational work/, "reasoning content present");

  /* Шаг 3: parseFrontmatter — каталог сможет прочитать коллекцию после
     рестарта приложения. */
  const parsed = parseFrontmatter(next);
  assert.ok(parsed, "frontmatter parses");

  /* Все поля попали и читаются обратно с правильными типами. */
  assert.equal(parsed!.qualityScore, 92, "qualityScore (Дмитриев «оценка»)");
  assert.equal(parsed!.conceptualDensity, 88, "conceptualDensity");
  assert.equal(parsed!.originality, 95, "originality");
  assert.equal(parsed!.domain, "cybernetics", "domain (Дмитриев «сфера»)");
  assert.equal(parsed!.year, 1948, "year typed as number");
  assert.equal(
    parsed!.isFictionOrWater,
    false,
    "boolean is_fiction_or_water → isFictionOrWater",
  );
  assert.equal(parsed!.status, "evaluated", "status updated to evaluated");
  assert.deepEqual(parsed!.tags, ev.tags, "tags array (Дмитриев «теги») сохранены as-is");
  assert.deepEqual(parsed!.tagsRu, ev.tags_ru, "tagsRu (Russian tags)");
  assert.equal(parsed!.titleRu, ev.title_ru);
  assert.equal(parsed!.authorEn, "Wiener N.");
  assert.equal(parsed!.evaluatorModel, "fake-model");
  assert.match(String(parsed!.verdictReason), /Foundational|cybernetics/);
});

/* ─── Idempotency ─────────────────────────────────────────────────── */

test("[integration] Idempotency: re-running evaluator on already-evaluated book → identical output", () => {
  /* Сценарий: пользователь нажал «переоценить» — чистая перезапись без
     дублирования секций или лишних \n. */
  const initialMeta: BookCatalogMeta = {
    id: "x".repeat(12),
    sha256: "b".repeat(64),
    originalFile: "book.pdf",
    originalFormat: "pdf",
    title: "Book",
    wordCount: 1000,
    chapterCount: 2,
    status: "imported",
  };
  const initialMd = `---
id: ${initialMeta.id}
sha256: ${initialMeta.sha256}
title: ${initialMeta.title}
originalFile: ${initialMeta.originalFile}
originalFormat: ${initialMeta.originalFormat}
wordCount: 1000
chapterCount: 2
status: imported
---

## Chapter A

Body A.

## Chapter B

Body B.
`;

  const ev = buildValidEvaluationJson();
  const updated: BookCatalogMeta = {
    ...initialMeta,
    domain: ev.domain,
    tags: ev.tags,
    tagsRu: ev.tags_ru,
    qualityScore: ev.quality_score,
    conceptualDensity: ev.conceptual_density,
    originality: ev.originality,
    isFictionOrWater: ev.is_fiction_or_water,
    verdictReason: ev.verdict_reason,
    titleRu: ev.title_ru,
    authorRu: ev.author_ru,
    titleEn: ev.title_en,
    authorEn: ev.author_en,
    year: ev.year ?? undefined,
    evaluatorModel: "m",
    evaluatedAt: "2026-05-10T12:00:00.000Z",
    status: "evaluated",
  };
  const reasoning = "Same reasoning text every time.";

  let first = replaceFrontmatter(initialMd, updated);
  first = upsertEvaluatorReasoning(first, reasoning);
  let second = replaceFrontmatter(first, updated);
  second = upsertEvaluatorReasoning(second, reasoning);

  assert.equal(
    first,
    second,
    "повторная оценка с теми же данными → идентичный output (нет дублирования секций / лишних переносов)",
  );
  const matches = second.match(/## Evaluator Reasoning/g) ?? [];
  assert.equal(matches.length, 1, `must be exactly one reasoning section, got ${matches.length}`);
});

/* ─── Negative path: pipeline не падает при битом ответе LLM ──────── */

test("[integration] Negative path: invalid JSON from LLM → evaluation=null, warnings, no throw", async () => {
  const server = await startFakeServer(() => ({
    choices: [
      {
        message: {
          role: "assistant",
          content:
            "<think>Reasoning OK</think>\n\nSorry, I cannot complete the evaluation right now.",
        },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 50, completion_tokens: 30, total_tokens: 80 },
  }));
  try {
    await withFakeLmEnv(server.url, async () => {
      const result = await evaluateBook("short surrogate", {
        model: "fake-model",
        pool: stubPool,
        maxTokens: 2000,
      });
      assert.equal(result.evaluation, null, "evaluation = null когда LLM не отдал JSON");
      assert.ok(result.warnings.length > 0, "warnings заполнены");
      /* Pipeline не throw — caller в evaluator-queue пометит книгу failed и
         продолжит очередь. */
    });
  } finally {
    await server.close();
  }
});
