/**
 * Calibre Converter — graceful degradation tests.
 *
 * Используем фейковый MOBI (просто invalid binary) — runEbookConvert либо
 * упадёт (Calibre не установлен / не валидный input), либо graceful return
 * text-extracted с warnings. Реальная конвертация покрывается e2e тестом
 * (отдельная задача, требует Calibre на CI).
 */

import { describe, it, beforeEach } from "node:test";
import { expect } from "./helpers/expect-shim.ts";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { convertViaCalibre } from "../electron/lib/scanner/converters/calibre.js";
import {
  resolveCalibreBinary,
  getCalibreInstallHint,
  _resetCalibreResolutionForTests,
} from "../electron/lib/scanner/converters/calibre-cli.js";

beforeEach(() => {
  _resetCalibreResolutionForTests();
});

describe("calibre-cli — resolveCalibreBinary", () => {
  it("возвращает CalibreToolResolution или null без throw", async () => {
    /* На CI без Calibre — null. На разработческой машине с установленным
       Calibre — объект с binary path. Главное — не throw. */
    const result = await resolveCalibreBinary();
    if (result !== null) {
      expect(typeof result.binary).toBe("string");
    }
  });

  it("кеширует результат — повторный вызов не делает повторного I/O", async () => {
    const r1 = await resolveCalibreBinary();
    const r2 = await resolveCalibreBinary();
    /* Если первый вернул null — второй тоже null (кеш работает). */
    /* Если объект — тот же объект (по ссылке через cache). */
    if (r1 === null) {
      expect(r2).toBe(null);
    } else {
      expect(r2).toBe(r1);
    }
  });

  it("getCalibreInstallHint возвращает осмысленную подсказку для платформы", () => {
    const hint = getCalibreInstallHint();
    expect(typeof hint).toBe("string");
    expect(hint.length).toBeGreaterThan(20);
    /* Должен содержать упоминание calibre и команды установки. */
    expect(hint.toLowerCase()).toContain("calibre");
  });

  it("_resetCalibreResolutionForTests сбрасывает кеш", async () => {
    /* Делаем resolve, затем сброс, затем повторный resolve — должен пере-найти. */
    await resolveCalibreBinary();
    _resetCalibreResolutionForTests();
    /* Повторный вызов не должен throw (даже если Calibre не установлен — null). */
    const r = await resolveCalibreBinary();
    expect(r === null || typeof r.binary === "string").toBe(true);
  });
});

describe("convertViaCalibre — graceful behavior на невалидных файлах", () => {
  it("невалидный .mobi → text-extracted с warnings (graceful)", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bibliary-calibre-"));
    const file = path.join(dir, "fake.mobi");
    await writeFile(file, Buffer.from("not a real mobi file content"));

    const result = await convertViaCalibre(file);
    /* Либо Calibre не найден (text-extracted с install hint), либо ebook-convert
       упал на fake input. В обоих случаях — text-extracted с warnings, не throw. */
    if (result.kind === "text-extracted") {
      expect(result.text).toBe("");
      expect(result.warnings.length).toBeGreaterThan(0);
    } else {
      /* Маловероятно: Calibre успешно создал EPUB из мусора (некоторые
         версии могут пытаться). Тогда delegate path — тоже валидный исход. */
      expect(result.ext).toBe("epub");
    }
    await result.cleanup();
    await rm(dir, { recursive: true, force: true });
  });

  it("cleanup всегда callable и идемпотентен", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bibliary-calibre-"));
    const file = path.join(dir, "fake.azw");
    await writeFile(file, Buffer.from("nope"));

    const result = await convertViaCalibre(file);
    /* Двойной cleanup не должен throw. */
    await result.cleanup();
    await result.cleanup();
    await rm(dir, { recursive: true, force: true });
  });

  it("AbortSignal обрабатывается без throw — возвращает text-extracted", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bibliary-calibre-"));
    const file = path.join(dir, "fake.chm");
    await writeFile(file, Buffer.from("data"));

    const ctl = new AbortController();
    ctl.abort();
    const result = await convertViaCalibre(file, { signal: ctl.signal });

    /* Aborted signal — runEbookConvert бросит, обёртка ловит → text-extracted с warning. */
    expect(result.kind).toBe("text-extracted");
    if (result.kind === "text-extracted") {
      expect(result.text).toBe("");
      expect(result.warnings.length).toBeGreaterThan(0);
    }
    await result.cleanup();
    await rm(dir, { recursive: true, force: true });
  });
});

describe("CalibreConvertResult — type discriminator", () => {
  it("kind discriminator корректно сужает тип в обоих ветках", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bibliary-calibre-"));
    const file = path.join(dir, "fake.pdb");
    await writeFile(file, Buffer.from("data"));

    const result = await convertViaCalibre(file);
    if (result.kind === "text-extracted") {
      expect(typeof result.text).toBe("string");
      expect(Array.isArray(result.warnings)).toBe(true);
    } else {
      expect(result.ext).toBe("epub");
      expect(typeof result.path).toBe("string");
    }
    await result.cleanup();
    await rm(dir, { recursive: true, force: true });
  });
});
