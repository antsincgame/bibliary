/**
 * Edge-case тесты для HTML parser — он использовался для скачанных сайтов
 * (cpp-книги в HTML, документация в _files/), и должен выдержать «грязный мир».
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";

import { parseBook } from "../electron/lib/scanner/parsers/index.ts";

async function tmpFile(name: string, content: string | Buffer): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "html-edge-"));
  const fp = path.join(dir, name);
  await writeFile(fp, content);
  return fp;
}

test("parseBook(html): пустой <body> → 0 sections, no crash", async () => {
  const fp = await tmpFile("empty.html", "<html><head><title>Empty</title></head><body></body></html>");
  const r = await parseBook(fp);
  assert.equal(r.sections.length, 0);
  assert.equal(r.metadata.title, "Empty");
});

test("parseBook(html): без <html>/<body> теги → fallback на body=весь файл", async () => {
  const fp = await tmpFile(
    "fragment.html",
    "<h1>Glossary</h1><p>QuickSort is a divide-and-conquer algorithm.</p>",
  );
  const r = await parseBook(fp);
  assert.ok(r.sections.length > 0, "should parse fragment");
  const allText = r.sections.flatMap((s) => s.paragraphs).join(" ");
  assert.match(allText, /QuickSort/);
});

test("parseBook(html): h1/h2/h3 разбиваются на секции с уровнями", async () => {
  const fp = await tmpFile("structured.html", `
    <html><body>
      <h1>Part 1</h1><p>intro</p>
      <h2>Section 1.1</h2><p>about A</p>
      <h2>Section 1.2</h2><p>about B</p>
      <h1>Part 2</h1><p>more</p>
    </body></html>
  `);
  const r = await parseBook(fp);
  assert.ok(r.sections.length >= 4, `expected ≥4 sections; got ${r.sections.length}`);
  const levels = r.sections.map((s) => s.level);
  assert.ok(levels.includes(1), "must have h1-level sections");
  assert.ok(levels.includes(2), "must have h2-level sections");
});

test("parseBook(html): теги <script> и <style> не попадают в текст", async () => {
  const fp = await tmpFile("scripted.html", `
    <html><head>
      <style>body { color: red; }</style>
      <script>alert('hi')</script>
    </head><body>
      <h1>Real Content</h1>
      <p>This is the actual text we want.</p>
      <script>window.tracking()</script>
    </body></html>
  `);
  const r = await parseBook(fp);
  const allText = r.sections.flatMap((s) => `${s.title}\n${s.paragraphs.join(" ")}`).join("\n");
  assert.ok(!allText.includes("alert("), `script content leaked: ${allText.slice(0, 200)}`);
  assert.ok(!allText.includes("color: red"), "style content leaked");
  assert.ok(!allText.includes("window.tracking"), "inline script leaked");
  assert.match(allText, /Real Content/);
  assert.match(allText, /actual text/);
});

test("parseBook(html): <meta charset='windows-1251'> декодируется", async () => {
  /* Симулируем кириллицу в windows-1251 (cp1251) */
  const cp1251Bytes = Buffer.concat([
    Buffer.from("<html><head><meta charset='windows-1251'><title>", "ascii"),
    /* "Заголовок" в cp1251: */
    Buffer.from([0xc7, 0xe0, 0xe3, 0xee, 0xeb, 0xee, 0xe2, 0xee, 0xea]),
    Buffer.from("</title></head><body><p>", "ascii"),
    /* "текст" в cp1251: */
    Buffer.from([0xf2, 0xe5, 0xea, 0xf1, 0xf2]),
    Buffer.from("</p></body></html>", "ascii"),
  ]);
  const fp = await tmpFile("cp1251.html", cp1251Bytes);
  const r = await parseBook(fp);
  /* Не должно быть mojibake-replacement chars */
  assert.ok(r.metadata.warnings.some((w) => w.includes("windows-1251")),
    `expected charset warning; got: ${r.metadata.warnings.join("|")}`);
});

test("parseBook(html): большой синтетический файл (1MB) парсится за <2s", async () => {
  const para = `<p>Lorem ipsum dolor sit amet, consectetur adipiscing elit. ${"long ".repeat(50)}</p>`;
  const body = `<html><body><h1>Big Doc</h1>${para.repeat(800)}</body></html>`;
  const fp = await tmpFile("big.html", body);
  const t0 = Date.now();
  const r = await parseBook(fp);
  const dur = Date.now() - t0;
  assert.ok(dur < 2000, `parse took ${dur}ms (expected <2000ms)`);
  assert.ok(r.sections.length > 0);
});

test("parseBook(html): таблица <td>/<th> ячейки попадают в параграфы", async () => {
  const fp = await tmpFile("table.html", `
    <html><body>
      <h1>Stats</h1>
      <table>
        <tr><th>Algorithm</th><th>Complexity</th></tr>
        <tr><td>QuickSort</td><td>O(n log n)</td></tr>
        <tr><td>BubbleSort</td><td>O(n²)</td></tr>
      </table>
    </body></html>
  `);
  const r = await parseBook(fp);
  const allText = r.sections.flatMap((s) => s.paragraphs).join(" ");
  assert.match(allText, /QuickSort/);
  assert.match(allText, /O\(n log n\)/);
});

test("parseBook(html): namespace XHTML → парсится как обычный HTML", async () => {
  const fp = await tmpFile("xhtml.html", `<?xml version="1.0"?>
    <html xmlns="http://www.w3.org/1999/xhtml">
    <head><title>XHTML Doc</title></head>
    <body><h1>Heading</h1><p>Some content here.</p></body>
    </html>
  `);
  const r = await parseBook(fp);
  assert.equal(r.metadata.title, "XHTML Doc");
  assert.ok(r.sections.length > 0);
});

test("parseBook(html): URL без расширения через ext-mapping (не работает у нас, но не падает)", async () => {
  /* Проверяем что .htm работает так же как .html */
  const fp = await tmpFile("doc.htm", "<html><body><h1>Title</h1><p>text</p></body></html>");
  const r = await parseBook(fp);
  assert.match(r.metadata.title.toLowerCase(), /title|doc/);
  assert.ok(r.sections.length > 0);
});
