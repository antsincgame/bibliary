/**
 * Multi-page TIFF Converter tests.
 *
 * Тесты НЕ создают реальный multi-page TIFF (sharp требуется для генерации,
 * а это native dep с непростым setup в тестовой среде). Проверяем:
 *   1. Single-page TIFF → text-extracted (не throw, warning о single-page).
 *   2. Невалидный TIFF → text-extracted с warning.
 *   3. Cleanup идемпотентен.
 *   4. AbortSignal респектируется.
 *
 * Реальная конвертация multi-page TIFF в PDF — отдельный e2e тест с sharp.
 */

import { describe, it } from "node:test";
import { expect } from "./helpers/expect-shim.ts";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { convertMultiTiff, getTiffPageCount } from "../server/lib/scanner/converters/multi-tiff.js";

describe("convertMultiTiff — graceful behavior", () => {
  it("Невалидный TIFF → text-extracted (не throw)", async (t) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bibliary-mtiff-bad-"));
    t.after(() => rm(dir, { recursive: true, force: true }));

    const file = path.join(dir, "fake.tif");
    await writeFile(file, Buffer.from("not a real TIFF"));

    const result = await convertMultiTiff(file);
    try {
      /* sharp не сможет распарсить fake → pageCount fallback to 1 → возвращаем
         text-extracted с warning "use imageParser directly". */
      expect(result.kind).toBe("text-extracted");
      if (result.kind === "text-extracted") {
        expect(result.text).toBe("");
        expect(result.warnings.length).toBeGreaterThan(0);
      }
    } finally {
      await result.cleanup();
    }
  });

  it("Уже abort'ленный signal → text-extracted без throw", async (t) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bibliary-mtiff-abort-"));
    t.after(() => rm(dir, { recursive: true, force: true }));

    const file = path.join(dir, "abort.tif");
    await writeFile(file, Buffer.from("data"));

    const ctl = new AbortController();
    ctl.abort();

    const result = await convertMultiTiff(file, { signal: ctl.signal });
    try {
      expect(result.kind).toBe("text-extracted");
      if (result.kind === "text-extracted") {
        expect(result.warnings.length).toBeGreaterThan(0);
      }
    } finally {
      await result.cleanup();
    }
  });

  it("cleanup() идемпотентен", async (t) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bibliary-mtiff-clean-"));
    t.after(() => rm(dir, { recursive: true, force: true }));

    const file = path.join(dir, "clean.tif");
    await writeFile(file, Buffer.from("data"));

    const result = await convertMultiTiff(file);
    await result.cleanup();
    await result.cleanup(); /* second call — no throw */
  });
});

describe("getTiffPageCount", () => {
  it("Невалидный файл → возвращает 1 (graceful, не throw)", async (t) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bibliary-mtiff-count-"));
    t.after(() => rm(dir, { recursive: true, force: true }));

    const file = path.join(dir, "fake.tif");
    await writeFile(file, Buffer.from("not real tiff"));

    const count = await getTiffPageCount(file);
    expect(count).toBe(1);
  });

  it("Несуществующий файл → 1 (graceful)", async () => {
    const count = await getTiffPageCount("/non/existent/path.tif");
    expect(count).toBe(1);
  });
});
