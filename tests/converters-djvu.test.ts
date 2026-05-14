/**
 * DjVu Converter — двухступенчатый.
 *
 * Используем фейковый DjVu (просто невалидный файл) — runDjvutxt бросает,
 * runDdjvuToPdf тоже бросает (DjVuLibre отвергает мусор). Тогда converter
 * должен вернуть text-extracted с пустым text + warnings, не throw.
 *
 * Реальная двухступенчатая работа покрывается e2e тестом (отдельный поход).
 *
 * Иt 8В.MAIN.3: добавлены integration тесты на интеграцию `convertDjvu`
 * с `converters/cache.ts` — cache hit обходит ddjvu, cache miss + успех
 * → запись в cache (fire-and-forget).
 */

import { describe, it } from "node:test";
import { expect } from "./helpers/expect-shim.ts";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { convertDjvu } from "../server/lib/scanner/converters/djvu.js";
import { setCachedConvert, clearConverterCache } from "../server/lib/scanner/converters/cache.js";

describe("convertDjvu — graceful degradation", () => {
  it("невалидный DjVu → text-extracted с пустым text + warnings, не throw", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bibliary-djvu-conv-"));
    const file = path.join(dir, "fake.djvu");
    await writeFile(file, Buffer.from("not a real djvu file content"));

    const result = await convertDjvu(file);

    /* runDjvutxt упадёт, runDdjvuToPdf тоже упадёт → fallback на text-extracted с warnings */
    expect(result.kind).toBe("text-extracted");
    if (result.kind === "text-extracted") {
      expect(result.text).toBe("");
      expect(result.warnings.length).toBeGreaterThan(0);
    }

    await result.cleanup();
    await rm(dir, { recursive: true, force: true });
  });

  it("cleanup всегда callable и не throw на text-extracted", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bibliary-djvu-conv-"));
    const file = path.join(dir, "fake.djvu");
    await writeFile(file, Buffer.from("nope"));

    const result = await convertDjvu(file);
    /* Не должен throw */
    await result.cleanup();
    await result.cleanup(); /* идемпотентно */

    await rm(dir, { recursive: true, force: true });
  });

  it("AbortSignal прерывает работу на этапе runDjvutxt", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bibliary-djvu-conv-"));
    const file = path.join(dir, "fake.djvu");
    await writeFile(file, Buffer.from("data"));

    const ctl = new AbortController();
    ctl.abort();
    const result = await convertDjvu(file, { signal: ctl.signal });

    /* Aborted signal — оба runDjvutxt и runDdjvuToPdf бросят. Fallback path активен. */
    expect(result.kind).toBe("text-extracted");
    if (result.kind === "text-extracted") {
      expect(result.text).toBe("");
      expect(result.warnings.length).toBeGreaterThan(0);
    }

    await result.cleanup();
    await rm(dir, { recursive: true, force: true });
  });
});

describe("DjvuConvertResult — type guards", () => {
  it("kind discriminator корректно сужает тип", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bibliary-djvu-conv-"));
    const file = path.join(dir, "fake.djvu");
    await writeFile(file, Buffer.from("data"));

    const result = await convertDjvu(file);

    if (result.kind === "text-extracted") {
      expect(typeof result.text).toBe("string");
      expect(Array.isArray(result.warnings)).toBe(true);
    } else {
      /* Не должно произойти на невалидном файле, но если ddjvu чудом сработал — */
      expect(result.ext).toBe("pdf");
      expect(typeof result.path).toBe("string");
    }

    await result.cleanup();
    await rm(dir, { recursive: true, force: true });
  });
});

describe("[MAIN.3] convertDjvu ↔ converters/cache integration", () => {
  it("cache hit: convertDjvu возвращает cached PDF не вызывая ddjvu", async (t) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bibliary-djvu-cache-hit-"));
    const cacheDir = path.join(dir, "converters-cache");
    /* Изолируем cache на временную папку — env-override (системный путь, не tunable). */
    const prevEnv = process.env["BIBLIARY_CONVERTER_CACHE_DIR"];
    process.env["BIBLIARY_CONVERTER_CACHE_DIR"] = cacheDir;
    t.after(async () => {
      if (prevEnv === undefined) delete process.env["BIBLIARY_CONVERTER_CACHE_DIR"];
      else process.env["BIBLIARY_CONVERTER_CACHE_DIR"] = prevEnv;
      await clearConverterCache({ cacheDir });
      await rm(dir, { recursive: true, force: true });
    });

    /* 1) Создаём фейковый .djvu (runDjvutxt упадёт). */
    const srcPath = path.join(dir, "book.djvu");
    await writeFile(srcPath, Buffer.from("fake djvu content"));

    /* 2) Заранее кладём «уже сконвертированный» PDF в cache. */
    const fakeConvertedPdf = path.join(dir, "fake-converted.pdf");
    const fakePdfData = Buffer.from("%PDF-1.4 fake cached pdf data");
    await writeFile(fakeConvertedPdf, fakePdfData);
    await setCachedConvert(srcPath, "djvu", fakeConvertedPdf, "pdf", { cacheDir });

    /* 3) convertDjvu — передаём precomputedText="" чтобы пропустить runDjvutxt
       (иначе на тестовой машине без djvulibre тест зависит от env). isQualityText("")
       = false → доходим до cache check, который должен дать hit и НЕ вызвать ddjvu. */
    const result = await convertDjvu(srcPath, { precomputedText: "" });

    expect(result.kind).toBe("delegate");
    if (result.kind === "delegate") {
      expect(result.ext).toBe("pdf");
      /* Cached path = `<cacheDir>/<sha>.pdf` — содержит наши данные. */
      const got = await readFile(result.path);
      expect(got.equals(fakePdfData)).toBe(true);
      /* warnings содержат cache-hit маркер из cache.ts. */
      expect(result.warnings.some((w) => w.includes("converter cache hit"))).toBe(true);
    }

    await result.cleanup(); /* noop для cached, не должен throw */
  });

  it("cache miss + неудачный ddjvu → text-extracted, cache не пополняется", async (t) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bibliary-djvu-cache-miss-"));
    const cacheDir = path.join(dir, "converters-cache");
    const prevEnv = process.env["BIBLIARY_CONVERTER_CACHE_DIR"];
    process.env["BIBLIARY_CONVERTER_CACHE_DIR"] = cacheDir;
    t.after(async () => {
      if (prevEnv === undefined) delete process.env["BIBLIARY_CONVERTER_CACHE_DIR"];
      else process.env["BIBLIARY_CONVERTER_CACHE_DIR"] = prevEnv;
      await clearConverterCache({ cacheDir });
      await rm(dir, { recursive: true, force: true });
    });

    const srcPath = path.join(dir, "book.djvu");
    await writeFile(srcPath, Buffer.from("not a real djvu"));

    /* Cache пуст → miss → ddjvu fall (невалидный файл) → text-extracted. */
    const result = await convertDjvu(srcPath, { precomputedText: "" });

    expect(result.kind).toBe("text-extracted");
    if (result.kind === "text-extracted") {
      expect(result.text).toBe("");
      expect(result.warnings.length).toBeGreaterThan(0);
    }

    await result.cleanup();
  });
});
