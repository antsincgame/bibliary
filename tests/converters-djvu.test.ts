/**
 * DjVu Converter — двухступенчатый.
 *
 * Используем фейковый DjVu (просто невалидный файл) — runDjvutxt бросает,
 * runDdjvuToPdf тоже бросает (DjVuLibre отвергает мусор). Тогда converter
 * должен вернуть text-extracted с пустым text + warnings, не throw.
 *
 * Реальная двухступенчатая работа покрывается e2e тестом (отдельный поход).
 */

import { describe, it } from "node:test";
import { expect } from "./helpers/expect-shim.ts";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { convertDjvu } from "../electron/lib/scanner/converters/djvu.js";

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
