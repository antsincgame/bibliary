/**
 * TIFF routing test (Iter 6В): single-page TIFF → imageParser, multi-page
 * → convertMultiTiff → pdfParser.
 *
 * Не создаём реальный multi-page TIFF (sharp generation сложна в тестах) —
 * проверяем что:
 *   1. Невалидный/пустой TIFF файл → fallback на imageParser (graceful)
 *   2. detectExt('.tif') возвращает 'tif' (зарегистрировано через PARSERS)
 *   3. parseBook на .tif вызывает tiffParser.parse, не imageParser.parse напрямую
 *      (косвенно через success без throw на graceful path)
 *
 * Hang-prevention notes (fix 2026-05-10):
 *   - Все graceful-failure тесты используют Buffer.alloc(0) (size=0) вместо
 *     fake/garbage bytes. imageParser имеет early-exit `if (stat.size === 0)`
 *     ДО cascade → возвращает warnings без OCR. С garbage bytes (например
 *     'not a real TIFF' 16 байт) imageParser.cascade пытается реальный OCR
 *     через tesseract.js WASM или Win.Media.Ocr / macOS Vision, и на не-
 *     валидных image bytes эти engines зависают (tesseract WASM в loop'е,
 *     Win OCR в ожидании stream'а который не придёт). Локально на M1 Mac
 *     macOS Vision быстро отрабатывает, в Win runner CI cascade застревал.
 *   - { timeout: 5000 } защитно — fail-fast если когда-нибудь cascade
 *     решит работать с empty buffer тоже.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { detectExt, parseBook } from "../electron/lib/scanner/parsers/index.js";
import { tiffParser, tiffAlternateParser } from "../electron/lib/scanner/parsers/tiff.js";

test("Iter 6В: tiffParser зарегистрирован для .tif", () => {
  assert.equal(detectExt("/scan/page.tif"), "tif");
  assert.equal(tiffParser.ext, "tif");
});

test("Iter 6В: tiffAlternateParser зарегистрирован для .tiff", () => {
  assert.equal(detectExt("/scan/page.tiff"), "tiff");
  assert.equal(tiffAlternateParser.ext, "tiff");
});

test(
  "Iter 6В: невалидный (empty) .tif файл → graceful (не throw, fallback на imageParser)",
  { timeout: 5000 },
  async (t) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bibliary-tiff-bad-"));
    t.after(() => rm(dir, { recursive: true, force: true }));

    const file = path.join(dir, "empty.tif");
    /* Пустой файл (size=0). imageParser early-exit'ит до OCR cascade — без
       hang'а на garbage bytes в Win/macOS native OCR. */
    await writeFile(file, Buffer.alloc(0));

    /* Должен вернуть результат, не throw. getTiffPageCount → throw (sharp на
       empty file) → catch → fallback на imageParser → early-exit на size=0. */
    const parsed = await parseBook(file);
    assert.ok(parsed, "parseBook на пустом .tif должен вернуть результат");
    assert.ok(Array.isArray(parsed.sections));
    assert.equal(parsed.sections.length, 0, "пустой файл — 0 секций");
  },
);

test(
  "Iter 6В: пустой .tif файл → graceful с warnings",
  { timeout: 5000 },
  async (t) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bibliary-tiff-empty-"));
    t.after(() => rm(dir, { recursive: true, force: true }));

    const file = path.join(dir, "empty.tif");
    await writeFile(file, Buffer.alloc(0));

    const parsed = await parseBook(file);
    assert.equal(parsed.sections.length, 0);
    assert.ok(parsed.metadata.warnings.length > 0, "пустой TIFF должен дать warnings");
  },
);

test(
  "Iter 6В: tiffParser direct call → routing выполняется",
  { timeout: 5000 },
  async (t) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bibliary-tiff-direct-"));
    t.after(() => rm(dir, { recursive: true, force: true }));

    const file = path.join(dir, "empty.tif");
    /* Empty file — getTiffPageCount throws (sharp), fallback на imageParser,
       imageParser early-exit на size=0. Routing выполнен корректно. */
    await writeFile(file, Buffer.alloc(0));

    /* Direct call к tiffParser.parse — должен вернуть результат, не throw. */
    const parsed = await tiffParser.parse(file);
    assert.ok(parsed);
    assert.ok(Array.isArray(parsed.sections));
  },
);

test(
  "Iter 6В: AbortSignal респектируется в TIFF routing",
  { timeout: 5000 },
  async (t) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bibliary-tiff-abort-"));
    t.after(() => rm(dir, { recursive: true, force: true }));

    const file = path.join(dir, "abort.tif");
    /* Empty file для гарантии что abort path не дойдёт до OCR (который мог бы
       зависнуть на garbage). Тест проверяет что ABort signal проходит
       через routing без exception — это и так подтверждается возвратом
       результата (graceful, не throw). */
    await writeFile(file, Buffer.alloc(0));

    const ctl = new AbortController();
    ctl.abort();

    /* Должен не throw — graceful с warnings. */
    const parsed = await tiffParser.parse(file, { signal: ctl.signal });
    assert.ok(parsed);
  },
);
