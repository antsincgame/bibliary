/**
 * OCR Cache — file-based кеш.
 *
 * Использует tmpdir для изоляции от продакшен app-data.
 */

import { describe, it, beforeEach } from "node:test";
import { expect } from "./helpers/expect-shim.ts";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  getCachedOcr,
  setCachedOcr,
  clearOcrCache,
  type OcrCacheEntry,
} from "../server/lib/scanner/extractors/ocr-cache.js";

let cacheDir: string;

beforeEach(async () => {
  cacheDir = await mkdtemp(path.join(os.tmpdir(), "bibliary-ocr-cache-"));
});

describe("ocr-cache — get/set roundtrip", () => {
  it("set затем get возвращает ту же запись", async () => {
    const entry: OcrCacheEntry = {
      engine: "system-ocr",
      quality: 0.85,
      text: "Hello world from page 5",
      createdAt: "2026-04-21T17:30:00.000Z",
    };
    await setCachedOcr("filehash123", 5, entry, { cacheDir });
    const got = await getCachedOcr("filehash123", 5, "system-ocr", { cacheDir });
    expect(got).toEqual(entry);
    await rm(cacheDir, { recursive: true, force: true });
  });

  it("разные engine для одной страницы — независимые записи", async () => {
    await setCachedOcr("file-a", 0, {
      engine: "system-ocr",
      quality: 0.7,
      text: "system result",
      createdAt: "2026-01-01T00:00:00.000Z",
    }, { cacheDir });
    await setCachedOcr("file-a", 0, {
      engine: "vision-llm",
      quality: 0.95,
      text: "vision result",
      createdAt: "2026-01-01T00:00:00.000Z",
    }, { cacheDir });

    const sys = await getCachedOcr("file-a", 0, "system-ocr", { cacheDir });
    const vis = await getCachedOcr("file-a", 0, "vision-llm", { cacheDir });
    expect(sys?.text).toBe("system result");
    expect(vis?.text).toBe("vision result");
    await rm(cacheDir, { recursive: true, force: true });
  });

  it("разные fileSha — независимые записи", async () => {
    await setCachedOcr("file-A", 0, {
      engine: "text-layer",
      quality: 1.0,
      text: "from A",
      createdAt: "2026-01-01T00:00:00.000Z",
    }, { cacheDir });
    await setCachedOcr("file-B", 0, {
      engine: "text-layer",
      quality: 1.0,
      text: "from B",
      createdAt: "2026-01-01T00:00:00.000Z",
    }, { cacheDir });

    const a = await getCachedOcr("file-A", 0, "text-layer", { cacheDir });
    const b = await getCachedOcr("file-B", 0, "text-layer", { cacheDir });
    expect(a?.text).toBe("from A");
    expect(b?.text).toBe("from B");
    await rm(cacheDir, { recursive: true, force: true });
  });
});

describe("ocr-cache — miss / invalid", () => {
  it("get несуществующей записи возвращает null", async () => {
    const got = await getCachedOcr("nothing", 0, "system-ocr", { cacheDir });
    expect(got).toBe(null);
  });

  it("get с пустым fileSha возвращает null без I/O", async () => {
    const got = await getCachedOcr("", 0, "system-ocr", { cacheDir });
    expect(got).toBe(null);
  });

  it("get с отрицательным pageIndex возвращает null", async () => {
    const got = await getCachedOcr("file-x", -1, "system-ocr", { cacheDir });
    expect(got).toBe(null);
  });

  it("set с пустым text — no-op (не сохраняет)", async () => {
    await setCachedOcr("file-x", 0, {
      engine: "system-ocr",
      quality: 0.5,
      text: "",
      createdAt: "2026-01-01T00:00:00.000Z",
    }, { cacheDir });
    const got = await getCachedOcr("file-x", 0, "system-ocr", { cacheDir });
    expect(got).toBe(null);
  });
});

describe("ocr-cache — clear", () => {
  it("clearOcrCache удаляет все записи и возвращает count", async () => {
    await setCachedOcr("f1", 0, { engine: "system-ocr", quality: 0.7, text: "a", createdAt: "x" }, { cacheDir });
    await setCachedOcr("f2", 0, { engine: "system-ocr", quality: 0.7, text: "b", createdAt: "x" }, { cacheDir });
    await setCachedOcr("f3", 1, { engine: "vision-llm", quality: 0.9, text: "c", createdAt: "x" }, { cacheDir });

    const removed = await clearOcrCache({ cacheDir });
    expect(removed).toBe(3);

    const a = await getCachedOcr("f1", 0, "system-ocr", { cacheDir });
    expect(a).toBe(null);
  });

  it("clear на пустой директории — 0 без ошибок", async () => {
    const removed = await clearOcrCache({ cacheDir });
    expect(removed).toBe(0);
  });
});
