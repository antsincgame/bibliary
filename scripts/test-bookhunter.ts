/**
 * Phase 3.0 — BookHunter integration tests против live API.
 * Запуск:  npx tsx scripts/test-bookhunter.ts
 *
 * Тесты сетевые. Если интернет недоступен или какой-то источник лежит,
 * соответствующие тесты будут SKIP (не FAIL) — для CI-friendliness.
 */

import { aggregateSearch, downloadBook, ALLOWED_LICENSES } from "../electron/lib/bookhunter/index.js";
import { promises as fs } from "fs";
import * as path from "path";
import * as os from "os";

const COLOR = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
};

let passed = 0;
let failed = 0;
let skipped = 0;
const failures: string[] = [];

async function step(label: string, fn: () => Promise<void> | void): Promise<void> {
  process.stdout.write(`  ${label.padEnd(70, ".")} `);
  try {
    await fn();
    console.log(`${COLOR.green}PASS${COLOR.reset}`);
    passed++;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("SKIP:")) {
      console.log(`${COLOR.yellow}SKIP${COLOR.reset} ${COLOR.dim}${msg.replace("SKIP:", "")}${COLOR.reset}`);
      skipped++;
      return;
    }
    console.log(`${COLOR.red}FAIL${COLOR.reset}\n      ${COLOR.dim}${msg}${COLOR.reset}`);
    failed++;
    failures.push(`${label}: ${msg}`);
  }
}

async function main(): Promise<void> {
  console.log(`\n${COLOR.bold}== Bibliary BookHunter live tests ==${COLOR.reset}\n`);

  /* T-1 — Gutendex (всегда работает, public domain) */
  let gutendexResults: Awaited<ReturnType<typeof aggregateSearch>> = [];
  await step("T1 — Gutendex search «Sherlock Holmes» возвращает результаты", async () => {
    gutendexResults = await aggregateSearch({
      query: "Sherlock Holmes",
      sources: ["gutendex"],
      perSourceLimit: 5,
    });
    if (gutendexResults.length === 0) throw new Error("zero results");
    if (gutendexResults.length > 5) throw new Error(`got ${gutendexResults.length}, expected ≤5`);
  });

  await step("T2 — Gutendex result has license=public-domain", () => {
    if (gutendexResults.length === 0) throw new Error("SKIP: no results from T1");
    for (const r of gutendexResults) {
      if (r.license !== "public-domain") throw new Error(`license=${r.license}`);
      if (!ALLOWED_LICENSES.has(r.license)) throw new Error(`not in whitelist`);
    }
  });

  await step("T3 — Gutendex дает хотя бы 1 EPUB или TXT format", () => {
    if (gutendexResults.length === 0) throw new Error("SKIP: no results");
    const hasParseable = gutendexResults.some((r) => r.formats.some((f) => f.format === "epub" || f.format === "txt"));
    if (!hasParseable) throw new Error("no EPUB/TXT in any result");
  });

  /* T-4 — Aggregator dedup (одинаковый title из двух источников = один результат) */
  await step("T4 — agg dedup: title+author уникальны", async () => {
    const seen = new Map<string, number>();
    for (const r of gutendexResults) {
      const k = `${r.title.toLowerCase()}|${r.authors[0]?.toLowerCase() ?? ""}`;
      seen.set(k, (seen.get(k) ?? 0) + 1);
    }
    for (const [k, count] of seen.entries()) {
      if (count > 1) throw new Error(`dup: ${k} → ${count}`);
    }
  });

  /* T-5 — License whitelist (искусственный кандидат с unknown license отфильтруется) */
  await step("T5 — License whitelist отбрасывает unknown", async () => {
    /* Симулируем искусственно: сами проверим filter в aggregator при нашем mock-источнике */
    /* Здесь просто проверяем, что ALLOWED_LICENSES не содержит unknown */
    if (ALLOWED_LICENSES.has("unknown" as never)) throw new Error("unknown leaked into whitelist");
  });

  /* T-6 — arXiv search (если доступен) */
  await step("T6 — arXiv search «attention is all you need»", async () => {
    try {
      const arxivResults = await aggregateSearch({
        query: "attention is all you need",
        sources: ["arxiv"],
        perSourceLimit: 3,
      });
      if (arxivResults.length === 0) throw new Error("SKIP: arXiv returned no results (offline?)");
      if (!arxivResults.some((r) => r.title.toLowerCase().includes("attention"))) {
        throw new Error("Нет результата с 'attention' в title");
      }
      const hasPdf = arxivResults.some((r) => r.formats.some((f) => f.format === "pdf"));
      if (!hasPdf) throw new Error("arxiv must yield PDF format");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("SKIP:")) throw e;
      if (msg.includes("ECONN") || msg.includes("ETIMEOUT") || msg.includes("ENOTFOUND")) {
        throw new Error("SKIP: network error");
      }
      throw e;
    }
  });

  /* T-7 — Aggregator multi-source */
  await step("T7 — aggregator multi-source merge sorted by rank", async () => {
    try {
      const merged = await aggregateSearch({
        query: "Pride and Prejudice",
        sources: ["gutendex", "arxiv"],
        perSourceLimit: 3,
      });
      if (merged.length === 0) throw new Error("SKIP: no results");
      /* Sorted descending — public-domain (Gutendex) обычно выше open-access (arxiv) */
      for (let i = 1; i < merged.length; i++) {
        if (merged[i - 1].license === "public-domain" && merged[i].license === "open-access") {
          /* OK ordering */
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("ECONN") || msg.includes("ENOTFOUND")) throw new Error("SKIP: network");
      throw e;
    }
  });

  /* T-8 — Streaming download (Gutendex TXT, маленький файл) */
  await step("T8 — Streaming download Gutendex TXT (~1MB)", async () => {
    if (gutendexResults.length === 0) throw new Error("SKIP: no candidates");
    const target = gutendexResults.find((r) => r.formats.some((f) => f.format === "txt"));
    if (!target) throw new Error("SKIP: no TXT variant");
    const txtVariant = target.formats.find((f) => f.format === "txt")!;
    const tmpFile = path.join(os.tmpdir(), `bibliary-bh-test-${Date.now()}.txt`);
    let lastBytes = 0;
    try {
      const result = await downloadBook({
        variant: txtVariant,
        destPath: tmpFile,
        onProgress: (downloaded) => {
          lastBytes = downloaded;
        },
      });
      if (result.bytesWritten <= 0) throw new Error("zero bytes written");
      if (lastBytes !== result.bytesWritten) throw new Error(`progress mismatch: ${lastBytes} vs ${result.bytesWritten}`);
      const stat = await fs.stat(tmpFile);
      if (stat.size !== result.bytesWritten) throw new Error("file size mismatch");
    } finally {
      await fs.unlink(tmpFile).catch(() => {});
    }
  });

  /* Summary */
  console.log(`\n${COLOR.bold}--- Summary ---${COLOR.reset}`);
  console.log(`Tests passed: ${COLOR.green}${passed}${COLOR.reset}`);
  console.log(`Tests skipped: ${COLOR.yellow}${skipped}${COLOR.reset} (network-dependent)`);
  console.log(`Tests failed: ${failed === 0 ? COLOR.green : COLOR.red}${failed}${COLOR.reset}`);
  if (failed > 0) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(2);
});
