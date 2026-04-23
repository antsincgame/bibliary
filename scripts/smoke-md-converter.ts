/**
 * Smoke test для md-converter: берёт по одной книге каждого формата
 * из Downloads и проверяет, что .md создаётся корректно.
 *
 * Не использует LLM/Qdrant -- чистая CPU-проверка.
 *
 *   npx tsx scripts/smoke-md-converter.ts [--downloads "path"]
 */

import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import { probeBooks } from "../electron/lib/scanner/parsers/index.js";
import { convertBookToMarkdown, parseFrontmatter } from "../electron/lib/library/md-converter.js";

const COLOR = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
};

function pickArg(argv: string[], flag: string): string | null {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const downloads = pickArg(argv, "--downloads") ?? path.join(os.homedir(), "Downloads");
  const outDir = path.resolve(process.cwd(), "release", "smoke-md-converter");
  await fs.mkdir(outDir, { recursive: true });

  console.log(`${COLOR.bold}=== md-converter smoke test ===${COLOR.reset}`);
  console.log(`Downloads: ${downloads}`);
  console.log(`Out      : ${outDir}\n`);

  const all = await probeBooks(downloads, 4, false);
  const eligible = all.filter((b) => ["pdf", "epub", "fb2", "txt", "docx"].includes(b.ext) && b.sizeBytes <= 50 * 1024 * 1024);

  /* По одной книге каждого формата, выбирая средние по размеру (не самые
     мелкие чеки и не самые жирные сборники). */
  const byFormat = new Map<string, typeof eligible>();
  for (const b of eligible) {
    const arr = byFormat.get(b.ext) ?? [];
    arr.push(b);
    byFormat.set(b.ext, arr);
  }
  const samples: typeof eligible = [];
  for (const [, arr] of byFormat) {
    arr.sort((a, b) => a.sizeBytes - b.sizeBytes);
    samples.push(arr[Math.floor(arr.length / 2)]);
  }

  let passed = 0;
  let failed = 0;
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

      if (errors.length === 0) {
        console.log(`${COLOR.green}PASS${COLOR.reset} ${COLOR.dim}${dur}s, ${result.chapters.length}ch, ${result.meta.wordCount}w, ${result.images.length}img, md=${(result.markdown.length / 1024).toFixed(1)}KB${COLOR.reset}`);
        passed++;
      } else {
        console.log(`${COLOR.red}FAIL${COLOR.reset}`);
        for (const e of errors) console.log(`    ${COLOR.red}✗${COLOR.reset} ${e}`);
        failed++;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`${COLOR.red}ERROR${COLOR.reset}\n    ${COLOR.dim}${msg}${COLOR.reset}`);
      failed++;
    }
  }

  console.log(`\n${COLOR.bold}Result:${COLOR.reset} ${passed} passed, ${failed} failed`);
  console.log(`Artifacts in: ${outDir}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
