/**
 * DjVu Parser Cascade Integration tests (Итерация 4 Часть Б).
 *
 * Проверяем что parseDjvu для невалидных файлов:
 *   1. provider="auto" + ocrEnabled=false → пустой результат + warning (НЕ запускает convertDjvu→pdf)
 *   2. provider="system" + ocrEnabled=false → пустой результат + warning (НЕ запускает convertDjvu)
 *   3. provider="auto" + ocrEnabled=true → пытается convertDjvu→pdfParser cascade,
 *      при сбое всех Tier'ов возвращает пустой результат с детальными warnings
 *   4. Per-page routing helper существует и не throw на bad input
 *
 * Реальные DjVu файлы (с настоящим OCR-слоем) покрываются e2e тестами вне unit-suite.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { parseBook } from "../server/lib/scanner/parsers/index.js";
import { runDjvutxtPage } from "../server/lib/scanner/parsers/djvu-cli.js";

test("parseDjvu provider=auto, ocrEnabled=false → не запускает convertDjvu→pdf cascade", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "bibliary-djvu-cascade-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const file = path.join(dir, "fake.djvu");
  await writeFile(file, Buffer.from("not a real djvu"));

  const started = Date.now();
  const parsed = await parseBook(file, { ocrEnabled: false, djvuOcrProvider: "auto" });
  const elapsedMs = Date.now() - started;

  assert.equal(parsed.sections.length, 0);
  assert.ok(
    parsed.metadata.warnings.some((w) => w.includes("OCR is disabled")),
    `expected OCR-disabled warning, got: ${parsed.metadata.warnings.join(" | ")}`,
  );
  /* Никаких pdf-parser warnings — мы НЕ должны были туда заходить */
  assert.ok(
    !parsed.metadata.warnings.some((w) => /converted to.*PDF.*cascade/i.test(w)),
    `convertDjvu cascade should NOT run with ocrEnabled=false, got: ${parsed.metadata.warnings.join(" | ")}`,
  );
  /* Должно быть быстро (без ddjvu→pdf конвертации) */
  assert.ok(elapsedMs < 5_000, `disabled OCR path should be fast, took ${elapsedMs}ms`);
});

test("parseDjvu provider=auto, ocrEnabled=true → пытается convertDjvu→pdf cascade на невалидном файле", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "bibliary-djvu-cascade-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const file = path.join(dir, "fake.djvu");
  await writeFile(file, Buffer.from("not a real djvu file content"));

  const parsed = await parseBook(file, { ocrEnabled: true, djvuOcrProvider: "auto" });

  /* На фейковом файле convertDjvu → ddjvu тоже упадёт → fallback на ocrDjvuPages
     → тоже упадёт (нет страниц) → пустой результат с warnings. */
  assert.equal(parsed.sections.length, 0);
  /* Должны быть warnings о попытках. Минимум один warning либо от convertDjvu
     (ddjvu failed), либо от ocrDjvuPages (no text). */
  assert.ok(
    parsed.metadata.warnings.length > 0,
    `expected warnings about failed cascade, got: ${parsed.metadata.warnings.join(" | ")}`,
  );
});

test("parseDjvu provider=system, ocrEnabled=false → классическое поведение сохранено (backward compat)", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "bibliary-djvu-cascade-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const file = path.join(dir, "fake.djvu");
  await writeFile(file, Buffer.from("nope"));

  const parsed = await parseBook(file, { ocrEnabled: false, djvuOcrProvider: "system" });

  assert.equal(parsed.sections.length, 0);
  assert.ok(
    parsed.metadata.warnings.some((w) => w.includes("OCR is disabled")),
    `expected OCR-disabled warning, got: ${parsed.metadata.warnings.join(" | ")}`,
  );
  /* НЕ должны заходить в auto-cascade ветку */
  assert.ok(
    !parsed.metadata.warnings.some((w) => /converted to.*PDF.*cascade/i.test(w)),
    `convertDjvu cascade only runs with provider=auto, got: ${parsed.metadata.warnings.join(" | ")}`,
  );
});

test("runDjvutxtPage возвращает пустую строку на невалидном DjVu (graceful)", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "bibliary-djvu-cascade-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const file = path.join(dir, "fake.djvu");
  await writeFile(file, Buffer.from("not a djvu"));

  /* Не должно throw — возвращает "" при любой ошибке. */
  const text = await runDjvutxtPage(file, 0);
  assert.equal(text, "");
});

test("runDjvutxtPage с aborted signal → пустая строка без throw", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "bibliary-djvu-cascade-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const file = path.join(dir, "fake.djvu");
  await writeFile(file, Buffer.from("not a djvu"));

  const ctl = new AbortController();
  ctl.abort();

  const text = await runDjvutxtPage(file, 0, ctl.signal);
  assert.equal(text, "");
});
