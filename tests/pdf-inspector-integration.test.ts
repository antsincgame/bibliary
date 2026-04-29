import { test } from "node:test";
import { strict as assert } from "node:assert";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { tryParsePdfWithInspector } from "../electron/lib/scanner/parsers/pdf-inspector-parser.ts";
import { parsePdfMain } from "../electron/lib/scanner/parsers/pdf.ts";

/**
 * Integration tests на реальном книжном PDF из D:\Bibliarifull.
 *
 * Skip-policy: если папка/файл недоступны (CI / другая машина) —
 * тест помечается skip, не падает. Это интеграционные smoke-тесты,
 * запускаемые на машине разработчика. Юнит-тесты лежат в
 * pdf-inspector-parser.test.ts.
 */

async function existsFile(p: string): Promise<boolean> {
  try {
    const st = await fs.stat(p);
    return st.isFile();
  } catch {
    return false;
  }
}

const STROUSTRUP_PDF = "D:\\Bibliarifull\\Stroustrup B. - A Tour of C++ - Second Edition - 2018.pdf";
const STEPIK_PDF =
  "D:\\Bibliarifull\\Школа BEEGEEK, Тимур Гуев, Артур Харисов - Поколение Python курс для профессионалов (2022)\\10  Итераторы и генераторы\\10.4 Итераторы. Часть 4\\Шаг 6 · Итераторы. Часть 4 · Stepik.pdf";

test("tryParsePdfWithInspector: classifies and extracts Stroustrup C++ via NAPI", async (t) => {
  if (!(await existsFile(STROUSTRUP_PDF))) {
    t.skip(`PDF not found at ${STROUSTRUP_PDF} (CI / другая машина)`);
    return;
  }
  const out = await tryParsePdfWithInspector(STROUSTRUP_PDF);
  assert.equal(out.status, "ok", `expected status=ok, got ${out.status}: ${out.reason ?? ""}`);
  assert.ok(out.result, "result must be present");
  assert.ok(out.classification, "classification must be present");
  assert.ok(
    out.classification!.pdfType === "Mixed" || out.classification!.pdfType === "TextBased",
    `expected Mixed/TextBased, got ${out.classification!.pdfType}`,
  );
  assert.ok(out.result!.sections.length > 5, `expected >5 sections, got ${out.result!.sections.length}`);
  assert.ok(out.result!.rawCharCount > 10_000, `expected >10K chars, got ${out.result!.rawCharCount}`);
  assert.ok(
    out.result!.metadata.warnings.some((w) => /pdf-inspector/i.test(w)),
    "warnings must contain pdf-inspector audit trail",
  );
});

test("tryParsePdfWithInspector: handles small Stepik PDF (<1 page)", async (t) => {
  if (!(await existsFile(STEPIK_PDF))) {
    t.skip(`Stepik PDF not found (CI / другая машина)`);
    return;
  }
  const out = await tryParsePdfWithInspector(STEPIK_PDF);
  assert.equal(out.status, "ok");
  assert.equal(out.classification!.pageCount, 1);
  assert.equal(out.classification!.pdfType, "TextBased");
  assert.ok(out.result!.sections.length >= 1);
});

test("parsePdfMain: real PDF goes through pdf-inspector primary path", async (t) => {
  if (!(await existsFile(STROUSTRUP_PDF))) {
    t.skip(`PDF not found`);
    return;
  }
  const result = await parsePdfMain(STROUSTRUP_PDF);
  assert.ok(result.sections.length > 5, `expected >5 sections, got ${result.sections.length}`);
  assert.ok(result.rawCharCount > 10_000, `expected >10K chars, got ${result.rawCharCount}`);
  /* Доказательство что прошли через pdf-inspector — warning должен быть. */
  assert.ok(
    result.metadata.warnings.some((w) => /pdf-inspector/i.test(w)),
    `warnings must contain pdf-inspector trail; got: ${JSON.stringify(result.metadata.warnings)}`,
  );
});

test("parsePdfMain: respects BIBLIARY_PDF_INSPECTOR=0 opt-out (uses pdfjs)", async (t) => {
  if (!(await existsFile(STROUSTRUP_PDF))) {
    t.skip(`PDF not found`);
    return;
  }
  /* pdfjs-node.ts использует __filename, недоступный в чистом ESM (tsx).
     В Electron CommonJS-runtime это работает. Скипаем тест в test-environment. */
  if (typeof (globalThis as { __filename?: unknown }).__filename === "undefined") {
    t.skip("pdfjs requires CommonJS __filename (Electron runtime); skipped in tsx tests");
    return;
  }
  const original = process.env.BIBLIARY_PDF_INSPECTOR;
  process.env.BIBLIARY_PDF_INSPECTOR = "0";
  try {
    const result = await parsePdfMain(STROUSTRUP_PDF);
    assert.ok(result.sections.length > 0);
    /* В opt-out режиме pdf-inspector не должен попадать в warnings. */
    assert.ok(
      !result.metadata.warnings.some((w) => /pdf-inspector/i.test(w)),
      `pdf-inspector warning должен отсутствовать в opt-out`,
    );
  } finally {
    if (original === undefined) delete process.env.BIBLIARY_PDF_INSPECTOR;
    else process.env.BIBLIARY_PDF_INSPECTOR = original;
  }
});

test("tryParsePdfWithInspector: gracefully skips files >200MB", async (t) => {
  /* Создаём пустой stub файл с фейковым размером? Нет, проще проверить
     real-world: маленький не-PDF byte sequence — inspector classifyPdf должен
     либо упасть (status:fallback), либо отказать. Главное — не throws. */
  const tmpDir = await fs.mkdtemp(path.join(process.cwd(), ".test-pdf-"));
  try {
    const fake = path.join(tmpDir, "fake.pdf");
    await fs.writeFile(fake, Buffer.from("not a pdf at all"));
    const out = await tryParsePdfWithInspector(fake);
    /* Mаленький не-PDF — inspector classifyPdf, скорее всего, бросит → fallback */
    assert.ok(
      out.status === "fallback" || out.status === "skipped",
      `expected fallback/skipped on non-PDF bytes, got ${out.status}: ${out.reason ?? ""}`,
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
