/**
 * Smoke test для md-converter: берёт по одной книге каждого формата
 * из Downloads и проверяет, что .md создаётся корректно.
 *
 * Не использует LLM/Qdrant -- чистая CPU-проверка.
 *
 *   npx tsx scripts/smoke-md-converter.ts [--downloads "path"]
 */

import { promises as fs } from "fs";
import * as path from "path";
import { convertBookToMarkdown, parseFrontmatter } from "../electron/lib/library/md-converter.js";
import { collectProbeBooksFromRoots, getSourceRootsFromArgv, argValues } from "./e2e-source-roots.js";

const COLOR = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
};

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const roots = getSourceRootsFromArgv(argv, path.join(process.cwd(), "data", "library"));
  const samplePerFormat = Math.max(1, Number(argValues(argv, "--sample-per-format")[0] ?? "2"));
  const outDir = path.resolve(process.cwd(), "release", "smoke-md-converter");
  await fs.mkdir(outDir, { recursive: true });

  console.log(`${COLOR.bold}=== md-converter smoke test ===${COLOR.reset}`);
  console.log(`Roots    : ${roots.join(" | ")}`);
  console.log(`Out      : ${outDir}\n`);

  const all = await collectProbeBooksFromRoots(roots, 4, false);
  const eligible = all.filter((b) => ["pdf", "epub", "fb2", "txt", "docx", "doc", "rtf", "djvu", "html", "htm", "odt"].includes(b.ext) && b.sizeBytes <= 50 * 1024 * 1024);

  /* По несколько книг каждого формата, выбирая средние по размеру
     вместо крайних случаев-монстров и микрофайлов. */
  const byFormat = new Map<string, typeof eligible>();
  for (const b of eligible) {
    const arr = byFormat.get(b.ext) ?? [];
    arr.push(b);
    byFormat.set(b.ext, arr);
  }
  const samples: typeof eligible = [];
  for (const [, arr] of byFormat) {
    arr.sort((a, b) => a.sizeBytes - b.sizeBytes);
    if (arr.length === 0) continue;
    if (arr.length <= samplePerFormat) {
      samples.push(...arr);
      continue;
    }
    const step = (arr.length - 1) / Math.max(1, samplePerFormat - 1);
    const picked = new Set<number>();
    for (let i = 0; i < samplePerFormat; i++) {
      picked.add(Math.round(i * step));
    }
    for (const index of picked) samples.push(arr[index]);
  }

  let passed = 0;
  let failed = 0;
  const report: Array<{
    fileName: string;
    absPath: string;
    ext: string;
    chapterCount?: number;
    wordCount?: number;
    imageCount?: number;
    illustrationCount?: number;
    warnings?: string[];
    status: "pass" | "fail";
    errors?: string[];
  }> = [];
  for (const book of samples) {
    const sizeMb = (book.sizeBytes / 1024 / 1024).toFixed(2);
    process.stdout.write(`${COLOR.cyan}[${book.ext}]${COLOR.reset} ${book.fileName} ${COLOR.dim}(${sizeMb} MB)${COLOR.reset} ... `);
    const t0 = Date.now();
    try {
      const result = await convertBookToMarkdown(book.absPath, { ocrEnabled: false, maxImagesPerBook: 30, maxImageBytes: 3 * 1024 * 1024 });
      const dur = ((Date.now() - t0) / 1000).toFixed(1);
      const safeName = book.fileName.replace(/[^\w.-]/g, "_").slice(0, 60);
      const mdPath = path.join(outDir, `${book.ext}__${safeName}.md`);
      await fs.writeFile(mdPath, result.markdown, "utf8");

      /* Проверки контракта: */
      const errors: string[] = [];
      const fm = parseFrontmatter(result.markdown);
      if (!fm) errors.push("frontmatter not parseable");
      if (fm && fm.title !== result.meta.title) errors.push(`frontmatter title mismatch: ${fm.title} vs ${result.meta.title}`);
      if (result.markdown.length < 200) errors.push(`markdown too short: ${result.markdown.length}`);
      const refsStart = result.markdown.indexOf("\n---\n\n<!-- Image references");
      if (result.images.length > 0 && refsStart === -1) errors.push("image refs section missing");
      /* Контракт читаемости: все refs ПОСЛЕ последнего заголовка главы (`## `).
         Это гарантирует что человек, листающий главы, не наткнётся на Base64.
         Размер refs vs body неважен -- картинки могут быть тяжелее текста. */
      if (result.images.length > 0 && refsStart !== -1) {
        const lastChapterHeader = result.markdown.lastIndexOf("\n## ");
        if (lastChapterHeader > refsStart) errors.push(`image refs (offset ${refsStart}) appear before last chapter header (offset ${lastChapterHeader})`);
      }
      for (const img of result.images) {
        if (!result.markdown.includes(`[${img.id}]: data:`)) errors.push(`image ref ${img.id} missing in markdown`);
      }
      if (result.images.some((img) => img.id === "img-cover") && !result.markdown.includes("![Cover][img-cover]")) {
        errors.push("cover not inlined in body");
      }
      for (const img of result.images.filter((entry) => entry.id !== "img-cover")) {
        const inlineRe = new RegExp(`!\\[[^\\]]*\\]\\[${img.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]`);
        if (!inlineRe.test(result.markdown)) errors.push(`illustration ${img.id} not inlined in body`);
      }

      if (errors.length === 0) {
        console.log(`${COLOR.green}PASS${COLOR.reset} ${COLOR.dim}${dur}s, ${result.chapters.length}ch, ${result.meta.wordCount}w, ${result.images.length}img, md=${(result.markdown.length / 1024).toFixed(1)}KB${COLOR.reset}`);
        passed++;
        report.push({
          fileName: book.fileName,
          absPath: book.absPath,
          ext: book.ext,
          chapterCount: result.chapters.length,
          wordCount: result.meta.wordCount,
          imageCount: result.images.length,
          illustrationCount: result.images.filter((img) => img.id !== "img-cover").length,
          warnings: result.meta.warnings,
          status: "pass",
        });
      } else {
        console.log(`${COLOR.red}FAIL${COLOR.reset}`);
        for (const e of errors) console.log(`    ${COLOR.red}✗${COLOR.reset} ${e}`);
        failed++;
        report.push({
          fileName: book.fileName,
          absPath: book.absPath,
          ext: book.ext,
          chapterCount: result.chapters.length,
          wordCount: result.meta.wordCount,
          imageCount: result.images.length,
          illustrationCount: result.images.filter((img) => img.id !== "img-cover").length,
          warnings: result.meta.warnings,
          status: "fail",
          errors,
        });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`${COLOR.red}ERROR${COLOR.reset}\n    ${COLOR.dim}${msg}${COLOR.reset}`);
      failed++;
      report.push({
        fileName: book.fileName,
        absPath: book.absPath,
        ext: book.ext,
        status: "fail",
        errors: [msg],
      });
    }
  }

  const reportPath = path.join(outDir, `${new Date().toISOString().replace(/[:.]/g, "-")}-report.json`);
  await fs.writeFile(reportPath, JSON.stringify({
    roots,
    samplePerFormat,
    discovered: all.length,
    sampled: samples.length,
    report,
  }, null, 2), "utf8");

  console.log(`\n${COLOR.bold}Result:${COLOR.reset} ${passed} passed, ${failed} failed`);
  console.log(`Artifacts in: ${outDir}`);
  console.log(`Report    : ${reportPath}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
