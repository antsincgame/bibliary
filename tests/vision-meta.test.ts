/**
 * Unit tests для electron/lib/llm/vision-meta.ts.
 *
 * Покрытие:
 *   1. pickVisionModel: автодетект vision-модели среди loaded по маркерам.
 *   2. pickVisionModel: respect preferred override.
 *   3. extractMetadataFromCover: graceful fail если vision-модели нет.
 *   4. extractMetadataFromCover: успешный путь с замоканным fetcher (никакой сети).
 *   5. extractMetadataFromCover: парсит JSON в code-block, нормализует "Unknown" → null.
 *   6. extractMetadataFromCover: zod-валидация отлавливает мусор.
 *   7. extractMetadataFromCover: empty buffer — graceful error.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { pickVisionModel, pickVisionModels, extractMetadataFromCover, VisionMetaSchema } from "../electron/lib/llm/vision-meta.ts";

const FAKE_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

function makeListLoaded(modelKeys: string[]) {
  return async () => modelKeys.map((modelKey) => ({ identifier: modelKey, modelKey }));
}

test("[vision-meta] pickVisionModel finds model by 'vl' marker", async () => {
  const picker = makeListLoaded(["meta-llama/llama-3.1-8b", "qwen/qwen3-vl-8b"]);
  const r = await pickVisionModel({ listLoadedImpl: picker });
  assert.ok(r);
  assert.equal(r!.modelKey, "qwen/qwen3-vl-8b");
});

test("[vision-meta] pickVisionModel finds llava variant", async () => {
  const picker = makeListLoaded(["llava-1.6-mistral-7b"]);
  const r = await pickVisionModel({ listLoadedImpl: picker });
  assert.ok(r);
  assert.equal(r!.modelKey, "llava-1.6-mistral-7b");
});

test("[vision-meta] pickVisionModel returns null when no vision model loaded", async () => {
  const picker = makeListLoaded(["qwen/qwen3-4b-2507", "meta-llama/llama-3.1-8b"]);
  const r = await pickVisionModel({ listLoadedImpl: picker });
  assert.equal(r, null);
});

test("[vision-meta] pickVisionModel respects preferredModelKey override (exact)", async () => {
  const picker = makeListLoaded(["qwen/qwen3-vl-8b", "llava-1.6-mistral-7b"]);
  const r = await pickVisionModel({ preferredModelKey: "llava-1.6-mistral-7b", listLoadedImpl: picker });
  assert.ok(r);
  assert.equal(r!.modelKey, "llava-1.6-mistral-7b");
});

test("[vision-meta] pickVisionModel rejects partial preferredModelKey (no silent substitution)", async () => {
  /* Если юзер указал «llava», но в loaded только полное имя «llava-1.6-mistral-7b»
     или ничего похожего — мы НЕ подменяем выбор молча. До 2026-04 здесь шёл
     substring-fallback, что приводило к запуску чужой модели вместо выбранной
     юзером в Settings → Models. */
  const picker = makeListLoaded(["qwen/qwen3-vl-8b", "llava-1.6-mistral-7b"]);
  const r = await pickVisionModel({ preferredModelKey: "llava", listLoadedImpl: picker });
  assert.equal(r, null, "partial substring must NOT match; pref must be exact");
});

test("[vision-meta] pickVisionModels with exact preferred returns ONLY that model (no fallback chain)", async () => {
  /* Когда пользователь явно выбрал модель и она загружена — список содержит
     только её. Никаких «дополнительных vision семейств следом» — это
     раньше позволяло перебирать чужие модели после фейла предпочитаемой. */
  const picker = makeListLoaded(["qwen/qwen3-vl-8b", "llava-1.6-mistral-7b", "pixtral-12b", "text-only"]);
  const r = await pickVisionModels({ preferredModelKey: "llava-1.6-mistral-7b", listLoadedImpl: picker });
  assert.deepEqual(r.map((m) => m.modelKey), ["llava-1.6-mistral-7b"]);
});

test("[vision-meta] pickVisionModels with preferred-not-loaded returns empty (no silent substitution)", async () => {
  const picker = makeListLoaded(["qwen/qwen3-vl-8b", "pixtral-12b"]);
  const r = await pickVisionModels({ preferredModelKey: "missing-vision-model", listLoadedImpl: picker });
  assert.deepEqual(r, []);
});

test("[vision-meta] pickVisionModels without preferred returns full vision auto-list", async () => {
  const picker = makeListLoaded(["qwen/qwen3-vl-8b", "llava-1.6-mistral-7b", "pixtral-12b", "text-only"]);
  const r = await pickVisionModels({ listLoadedImpl: picker });
  /* Все vision-модели в порядке VISION_FAMILY_PRIORITY (qwen3-vl выше). */
  assert.deepEqual(r.map((m) => m.modelKey).sort(), ["llava-1.6-mistral-7b", "pixtral-12b", "qwen/qwen3-vl-8b"]);
});

test("[vision-meta] extractMetadataFromCover graceful skip when no vision model loaded", async () => {
  const picker = makeListLoaded(["meta-llama/llama-3.1-8b"]);
  const r = await extractMetadataFromCover(FAKE_PNG, { listLoadedImpl: picker });
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /no vision-capable model/i);
  assert.equal(r.meta, undefined);
});

test("[vision-meta] extractMetadataFromCover empty buffer → graceful error", async () => {
  const r = await extractMetadataFromCover(Buffer.alloc(0));
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /empty image buffer/i);
});

test("[vision-meta] extractMetadataFromCover happy path via mocked fetcher", async () => {
  const picker = makeListLoaded(["qwen/qwen3-vl-8b"]);
  const fetcher = async () => ({
    content: JSON.stringify({
      title: "Don't Make Me Think",
      author: "Steve Krug",
      authors: ["Steve Krug"],
      year: 2014,
      language: "en",
      publisher: "New Riders",
      confidence: 0.92,
    }),
  });

  const r = await extractMetadataFromCover(FAKE_PNG, {
    listLoadedImpl: picker,
    fetcherImpl: fetcher,
  });

  assert.equal(r.ok, true, `error: ${r.error}`);
  assert.ok(r.meta);
  assert.equal(r.meta!.title, "Don't Make Me Think");
  assert.equal(r.meta!.author, "Steve Krug");
  assert.equal(r.meta!.year, 2014);
  assert.equal(r.meta!.language, "en");
  assert.equal(r.model, "qwen/qwen3-vl-8b");
});

test("[vision-meta] extractMetadataFromCover falls back when first vision model misses core metadata", async () => {
  const picker = makeListLoaded(["qwen/qwen3-vl-8b", "llava-1.6-mistral-7b"]);
  const calls: string[] = [];
  const fetcher = async ({ modelKey }: { modelKey: string }) => {
    calls.push(modelKey);
    if (modelKey.includes("qwen")) {
      return {
        content: JSON.stringify({
          title: null,
          author: null,
          authors: [],
          year: null,
          language: null,
          publisher: null,
          confidence: 0.2,
        }),
      };
    }
    return {
      content: JSON.stringify({
        title: "Кібернетика",
        author: "Віктор Глушков",
        authors: ["Віктор Глушков"],
        year: 1964,
        language: "uk",
        publisher: "Наукова думка",
        confidence: 0.91,
      }),
    };
  };

  const r = await extractMetadataFromCover(FAKE_PNG, {
    listLoadedImpl: picker,
    fetcherImpl: fetcher,
  });

  assert.equal(r.ok, true, `error: ${r.error}`);
  assert.deepEqual(calls, ["qwen/qwen3-vl-8b", "llava-1.6-mistral-7b"]);
  assert.equal(r.meta!.author, "Віктор Глушков");
  assert.equal(r.meta!.language, "uk");
  assert.match(r.warnings?.join("\n") ?? "", /missing title, author, year, language/);
});

test("[vision-meta] extractMetadataFromCover unwraps JSON in code-block", async () => {
  const picker = makeListLoaded(["llava-1.6"]);
  const fetcher = async () => ({
    content: '```json\n{"title":"Test Book","author":"A. Author","authors":["A. Author"],"year":2020,"language":"en","publisher":null,"confidence":0.7}\n```',
  });
  const r = await extractMetadataFromCover(FAKE_PNG, { listLoadedImpl: picker, fetcherImpl: fetcher });
  assert.equal(r.ok, true);
  assert.equal(r.meta!.title, "Test Book");
});

test("[vision-meta] nullifies 'Unknown'/'N/A' before zod parse", async () => {
  const picker = makeListLoaded(["llava-1.6"]);
  const fetcher = async () => ({
    content: JSON.stringify({
      title: "Real Title",
      author: "Unknown",
      authors: [],
      year: null,
      language: "n/a",
      publisher: "None",
      confidence: 0.4,
    }),
  });
  const r = await extractMetadataFromCover(FAKE_PNG, { listLoadedImpl: picker, fetcherImpl: fetcher });
  assert.equal(r.ok, true);
  assert.equal(r.meta!.title, "Real Title");
  assert.equal(r.meta!.author, null, "'Unknown' must be nullified");
  assert.equal(r.meta!.language, null, "'n/a' must be nullified");
  assert.equal(r.meta!.publisher, null, "'None' must be nullified");
});

test("[vision-meta] schema mismatch returns ok:false with detailed error", async () => {
  const picker = makeListLoaded(["qwen-vl"]);
  const fetcher = async () => ({
    /* year out of range — must fail zod */
    content: JSON.stringify({ title: "X", author: "Y", authors: [], year: 1066, language: "en", publisher: null, confidence: 0.5 }),
  });
  const r = await extractMetadataFromCover(FAKE_PNG, { listLoadedImpl: picker, fetcherImpl: fetcher });
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /schema mismatch|year/i);
});

test("[vision-meta] fetcher exception → ok:false, no throw", async () => {
  const picker = makeListLoaded(["qwen-vl"]);
  const fetcher = async () => { throw new Error("LM Studio HTTP 500: server overloaded"); };
  const r = await extractMetadataFromCover(FAKE_PNG, { listLoadedImpl: picker, fetcherImpl: fetcher });
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /500|overloaded/);
});

test("[vision-meta] aborted signal short-circuits before fetch", async () => {
  const picker = makeListLoaded(["llava"]);
  const ctl = new AbortController();
  ctl.abort();
  let fetcherCalled = false;
  const fetcher = async () => { fetcherCalled = true; return { content: "{}" }; };
  const r = await extractMetadataFromCover(FAKE_PNG, {
    listLoadedImpl: picker,
    fetcherImpl: fetcher,
    signal: ctl.signal,
  });
  assert.equal(r.ok, false);
  assert.equal(fetcherCalled, false, "fetcher must not be called when signal already aborted");
});

test("[vision-meta] zod schema rejects out-of-range confidence", () => {
  const r = VisionMetaSchema.safeParse({
    title: "X", author: "Y", authors: [], year: 2020, language: "en", publisher: null, confidence: 1.5,
  });
  assert.equal(r.success, false);
});
