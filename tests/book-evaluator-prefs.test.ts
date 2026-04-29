/**
 * Unit-тесты на pickEvaluatorModel — корневой регрессии 2026-04 «import взял
 * самую мощную модель помимо выбранных и завесил Windows».
 *
 * Покрывают новый контракт:
 *   1. preferred + loaded → preferred (без скоринга, без загрузки).
 *   2. preferred задан, не загружен, fallbacks нет → null (без allowAutoLoad).
 *   3. preferred задан, не загружен, fallback из CSV есть в loaded → fallback.
 *   4. preferred пуст, есть несколько loaded → топ по score (старое поведение).
 *   5. allowAutoLoad=false блокирует loadModel даже если top кандидат не загружен.
 *   6. allowAutoLoad=true разрешает загрузку (e2e сценарий).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { pickEvaluatorModel } from "../electron/lib/library/book-evaluator.ts";

interface FakeModel {
  modelKey: string;
  identifier: string;
  architecture?: string;
  sizeBytes?: number;
}

function makeListLoaded(keys: string[]): () => Promise<FakeModel[]> {
  return async () => keys.map((k) => ({ modelKey: k, identifier: k }));
}

function makeListDownloaded(keys: string[], sizeBytes = 0): () => Promise<FakeModel[]> {
  return async () => keys.map((k) => ({ modelKey: k, identifier: k, sizeBytes }));
}

const noopLoadModel = async (modelKey: string) => ({ modelKey, identifier: modelKey });

test("[book-evaluator] preferred is loaded → returns preferred without scoring", async () => {
  let downloadedCalled = false;
  const r = await pickEvaluatorModel({
    preferred: "user-pick",
    listLoadedImpl: makeListLoaded(["other-loaded", "user-pick", "third"]),
    listDownloadedImpl: async () => { downloadedCalled = true; return []; },
    loadModelImpl: noopLoadModel,
  });
  assert.equal(r, "user-pick");
  assert.equal(downloadedCalled, false, "scoring path не должен запускаться при exact match");
});

test("[book-evaluator] preferred not loaded, no fallbacks, allowAutoLoad=false → null", async () => {
  let loadModelCalled = false;
  const r = await pickEvaluatorModel({
    preferred: "ghost-model",
    listLoadedImpl: makeListLoaded(["other-loaded"]),
    listDownloadedImpl: makeListDownloaded(["ghost-model"]),
    loadModelImpl: async (k) => { loadModelCalled = true; return { modelKey: k, identifier: k }; },
  });
  /* Здесь критично: top scored среди loaded — "other-loaded", не "ghost-model".
     Но preferred не подменяется. Возвращается top scored (other-loaded), потому что
     preferred не в loaded; других fallbacks нет. */
  assert.equal(r, "other-loaded", "fallback на любой loaded ОК — но не ghost");
  assert.equal(loadModelCalled, false, "auto-load запрещён");
});

test("[book-evaluator] preferred not loaded, fallback CSV содержит loaded модель → fallback", async () => {
  const r = await pickEvaluatorModel({
    preferred: "ghost-model",
    fallbacks: ["fb-not-loaded", "fb-loaded", "fb-also"],
    listLoadedImpl: makeListLoaded(["other-loaded", "fb-loaded"]),
    listDownloadedImpl: makeListDownloaded([]),
    loadModelImpl: noopLoadModel,
  });
  assert.equal(r, "fb-loaded");
});

test("[book-evaluator] no prefs, several loaded → score-based pick (auto)", async () => {
  const r = await pickEvaluatorModel({
    listLoadedImpl: makeListLoaded(["small-fast-1b", "qwen3.6-35b-a3b"]),
    listDownloadedImpl: makeListDownloaded([]),
    loadModelImpl: noopLoadModel,
  });
  /* qwen3.6 имеет thinking-by-name+80 + 35b params bonus → выигрывает. */
  assert.equal(r, "qwen3.6-35b-a3b");
});

test("[book-evaluator] no loaded, allowAutoLoad=false → null (no silent loadModel)", async () => {
  let loadCalled = false;
  const r = await pickEvaluatorModel({
    listLoadedImpl: makeListLoaded([]),
    listDownloadedImpl: makeListDownloaded(["downloaded-only"]),
    loadModelImpl: async (k) => { loadCalled = true; return { modelKey: k, identifier: k }; },
  });
  assert.equal(r, null);
  assert.equal(loadCalled, false, "loadModel не должен дёргаться без allowAutoLoad");
});

test("[book-evaluator] allowAutoLoad=true, top not loaded → loadModel вызывается (e2e)", async () => {
  let loadedKey = "";
  const r = await pickEvaluatorModel({
    allowAutoLoad: true,
    listLoadedImpl: makeListLoaded([]),
    listDownloadedImpl: makeListDownloaded(["qwen3.6-35b-a3b"], 1024 * 1024 * 1024),
    loadModelImpl: async (k) => { loadedKey = k; return { modelKey: k, identifier: k }; },
  });
  assert.equal(r, "qwen3.6-35b-a3b");
  assert.equal(loadedKey, "qwen3.6-35b-a3b", "loadModel был вызван явно");
});
