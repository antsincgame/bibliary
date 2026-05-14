/**
 * Converter Cache tests (Iter 6В).
 *
 * Проверяем:
 *   1. Hit — повторный get с тем же mtime → возвращает cached path
 *   2. Miss — без предыдущего set → null
 *   3. Invalidation — после изменения mtime → miss (даже с тем же path)
 *   4. Set + Get round-trip — записал, получил
 *   5. Atomic write — при ошибке не остаётся .tmp файла
 *   6. clearConverterCache — удаляет всё
 *   7. getCacheStats — корректное counting
 */

import { describe, it } from "node:test";
import { expect } from "./helpers/expect-shim.ts";
import { mkdtemp, writeFile, rm, utimes, readFile, readdir } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  getCachedConvert,
  setCachedConvert,
  clearConverterCache,
  getCacheStats,
} from "../server/lib/scanner/converters/cache.js";

describe("converters/cache — basic round-trip", () => {
  it("set + get → hit с тем же контентом", async (t) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bibliary-cache-rt-"));
    const cacheDir = path.join(dir, "cache");
    t.after(() => rm(dir, { recursive: true, force: true }));

    /* Source file (имитирует .mobi). */
    const srcPath = path.join(dir, "book.mobi");
    await writeFile(srcPath, Buffer.from("fake mobi content"));

    /* Converted file (имитирует output EPUB после Calibre). */
    const convertedPath = path.join(dir, "book.epub");
    await writeFile(convertedPath, Buffer.from("fake epub data"));

    await setCachedConvert(srcPath, "mobi", convertedPath, "epub", { cacheDir });

    const cached = await getCachedConvert(srcPath, "mobi", "epub", { cacheDir });
    expect(cached !== null).toBe(true);
    if (!cached) return;
    expect(cached.kind).toBe("delegate");
    expect(cached.ext).toBe("epub");

    const cachedContent = await readFile(cached.path);
    expect(cachedContent.equals(Buffer.from("fake epub data"))).toBe(true);

    await cached.cleanup(); /* должно быть no-op */
  });

  it("get без предварительного set → null (miss)", async (t) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bibliary-cache-miss-"));
    const cacheDir = path.join(dir, "cache");
    t.after(() => rm(dir, { recursive: true, force: true }));

    const srcPath = path.join(dir, "book.mobi");
    await writeFile(srcPath, Buffer.from("data"));

    const cached = await getCachedConvert(srcPath, "mobi", "epub", { cacheDir });
    expect(cached).toBe(null);
  });

  it("get на несуществующем srcPath → null (без throw)", async (t) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bibliary-cache-noent-"));
    const cacheDir = path.join(dir, "cache");
    t.after(() => rm(dir, { recursive: true, force: true }));

    const cached = await getCachedConvert("/no/such/file.mobi", "mobi", "epub", { cacheDir });
    expect(cached).toBe(null);
  });
});

describe("converters/cache — invalidation by mtime", () => {
  it("изменение mtime источника → cache miss (новый ключ)", async (t) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bibliary-cache-inv-"));
    const cacheDir = path.join(dir, "cache");
    t.after(() => rm(dir, { recursive: true, force: true }));

    const srcPath = path.join(dir, "book.mobi");
    await writeFile(srcPath, Buffer.from("v1"));

    const convertedPath = path.join(dir, "v1.epub");
    await writeFile(convertedPath, Buffer.from("epub v1"));
    await setCachedConvert(srcPath, "mobi", convertedPath, "epub", { cacheDir });

    /* Hit на v1. */
    const hit1 = await getCachedConvert(srcPath, "mobi", "epub", { cacheDir });
    expect(hit1 !== null).toBe(true);

    /* Изменим mtime (имитирует пересохранение файла). */
    const futureMtime = new Date(Date.now() + 60_000);
    await utimes(srcPath, futureMtime, futureMtime);

    /* Теперь — miss, потому что mtime изменилось → новый sha256 ключ. */
    const miss = await getCachedConvert(srcPath, "mobi", "epub", { cacheDir });
    expect(miss).toBe(null);
  });

  it("изменение size источника → cache miss", async (t) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bibliary-cache-size-"));
    const cacheDir = path.join(dir, "cache");
    t.after(() => rm(dir, { recursive: true, force: true }));

    const srcPath = path.join(dir, "book.mobi");
    await writeFile(srcPath, Buffer.from("short"));

    const conv1 = path.join(dir, "v1.epub");
    await writeFile(conv1, Buffer.from("epub data"));
    await setCachedConvert(srcPath, "mobi", conv1, "epub", { cacheDir });

    /* Перезапишем src с другим size. */
    await writeFile(srcPath, Buffer.from("much longer content here"));

    /* Force same mtime (mtime может не измениться при rapid write на FAT/NTFS). */
    const newMiss = await getCachedConvert(srcPath, "mobi", "epub", { cacheDir });
    expect(newMiss).toBe(null);
  });
});

describe("converters/cache — set идемпотентен", () => {
  it("повторный set → no-op (не throw, не пересоздаёт)", async (t) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bibliary-cache-idem-"));
    const cacheDir = path.join(dir, "cache");
    t.after(() => rm(dir, { recursive: true, force: true }));

    const srcPath = path.join(dir, "book.mobi");
    await writeFile(srcPath, Buffer.from("data"));

    const conv = path.join(dir, "out.epub");
    await writeFile(conv, Buffer.from("epub"));

    await setCachedConvert(srcPath, "mobi", conv, "epub", { cacheDir });
    await setCachedConvert(srcPath, "mobi", conv, "epub", { cacheDir }); /* second time */

    const stats = await getCacheStats({ cacheDir });
    expect(stats.files).toBe(1);
  });
});

describe("converters/cache — clear and stats", () => {
  it("clearConverterCache удаляет всё", async (t) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bibliary-cache-clear-"));
    const cacheDir = path.join(dir, "cache");
    t.after(() => rm(dir, { recursive: true, force: true }));

    const srcPath = path.join(dir, "a.mobi");
    await writeFile(srcPath, Buffer.from("data"));
    const conv = path.join(dir, "out.epub");
    await writeFile(conv, Buffer.from("epub"));
    await setCachedConvert(srcPath, "mobi", conv, "epub", { cacheDir });

    let stats = await getCacheStats({ cacheDir });
    expect(stats.files).toBe(1);

    await clearConverterCache({ cacheDir });

    stats = await getCacheStats({ cacheDir });
    expect(stats.files).toBe(0);
  });

  it("getCacheStats на несуществующем dir → {files:0, bytes:0}", async (t) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bibliary-cache-empty-"));
    t.after(() => rm(dir, { recursive: true, force: true }));

    const stats = await getCacheStats({ cacheDir: path.join(dir, "noexist") });
    expect(stats.files).toBe(0);
    expect(stats.bytes).toBe(0);
  });

  it("getCacheStats считает реальные bytes", async (t) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bibliary-cache-bytes-"));
    const cacheDir = path.join(dir, "cache");
    t.after(() => rm(dir, { recursive: true, force: true }));

    const srcPath = path.join(dir, "a.mobi");
    await writeFile(srcPath, Buffer.from("data"));
    const conv = path.join(dir, "out.epub");
    const epubData = Buffer.alloc(1024, 0xff);
    await writeFile(conv, epubData);
    await setCachedConvert(srcPath, "mobi", conv, "epub", { cacheDir });

    const stats = await getCacheStats({ cacheDir });
    expect(stats.files).toBe(1);
    expect(stats.bytes).toBe(1024);
  });
});

describe("converters/cache — atomic writes", () => {
  it("после set нет .tmp файлов", async (t) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bibliary-cache-tmp-"));
    const cacheDir = path.join(dir, "cache");
    t.after(() => rm(dir, { recursive: true, force: true }));

    const srcPath = path.join(dir, "a.mobi");
    await writeFile(srcPath, Buffer.from("data"));
    const conv = path.join(dir, "out.epub");
    await writeFile(conv, Buffer.from("epub"));
    await setCachedConvert(srcPath, "mobi", conv, "epub", { cacheDir });

    const entries = await readdir(cacheDir);
    const tmpFiles = entries.filter((e) => e.includes(".tmp-"));
    expect(tmpFiles.length).toBe(0);
  });
});
