/**
 * scripts/run-olympics.ts — РЕАЛЬНАЯ Олимпиада на твоих локальных моделях.
 *
 * ИДЕОЛОГИЯ (важно):
 *   Цель — НЕ найти сильнейшую модель. Цель — найти ОПТИМАЛЬНУЮ для каждой
 *   роли. Optimum = best efficiency (score / time) среди тех, кто набрал
 *   ≥ 70% от score чемпиона. На практике это значит: «модель, которая
 *   решает задачу почти так же хорошо, но в N раз быстрее».
 *
 * Запуск:
 *   npx tsx scripts/run-olympics.ts                                # default = class S
 *   npx tsx scripts/run-olympics.ts --weight-classes=xs,s          # лёгкие классы
 *   npx tsx scripts/run-olympics.ts --weight-classes=s,m           # типичная связка
 *   npx tsx scripts/run-olympics.ts --weight-classes=all           # ВСЕ модели (медленно)
 *   npx tsx scripts/run-olympics.ts --models=qwen3-0.6b,qwen/qwen3-4b-2507
 *   npx tsx scripts/run-olympics.ts --disciplines=crystallizer,evaluator
 *
 * Без LM Studio скрипт честно скажет «офлайн» и выйдет с кодом 2.
 *
 * Все типы и логика расчёта живут в `electron/lib/llm/arena/olympics.ts` —
 * скрипт лишь печатает отчёт и пишет JSON.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import {
  runOlympics,
  type OlympicsReport,
  type WeightClass,
} from "../electron/lib/llm/arena/olympics.ts";

const REPORT_PATH = path.resolve("release", "olympics-report.json");

interface CliArgs {
  models?: string[];
  disciplines?: string[];
  weightClasses?: WeightClass[];
  maxModels?: number;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {};
  for (const arg of argv.slice(2)) {
    const m = /^--([^=]+)=(.+)$/.exec(arg);
    if (!m) continue;
    const [, k, v] = m;
    const splitCsv = (s: string): string[] => s.split(",").map((x) => x.trim()).filter(Boolean);
    if (k === "models") out.models = splitCsv(v!);
    else if (k === "disciplines") out.disciplines = splitCsv(v!);
    else if (k === "weight-classes" || k === "weight-class") {
      const parts = splitCsv(v!.toLowerCase());
      if (parts.includes("all")) {
        out.weightClasses = ["xs", "s", "m", "l", "xl"];
      } else {
        out.weightClasses = parts.filter(
          (p): p is WeightClass => ["xs", "s", "m", "l", "xl", "unknown"].includes(p),
        );
      }
    }
    else if (k === "max-models") out.maxModels = Number(v);
  }
  return out;
}

function printReport(report: OlympicsReport): void {
  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`🏆 РЕЗУЛЬТАТЫ ОЛИМПИАДЫ (${(report.totalDurationMs / 1000).toFixed(1)}s)`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`Участники по весовым классам:`);
  for (const [model, wc] of Object.entries(report.modelWeightClass)) {
    console.log(`  [${wc.toUpperCase().padEnd(2)}] ${model}`);
  }

  for (const r of report.disciplines) {
    console.log(`\n▣ ${r.discipline} (${r.role})`);
    const sorted = [...r.perModel].sort((a, b) => b.score - a.score);
    const podium = ["🥇", "🥈", "🥉"];
    sorted.forEach((p, i) => {
      const medal = podium[i] ?? "  ";
      const wc = `[${p.weightClass.toUpperCase()}]`.padEnd(4);
      const isOpt = p.model === r.optimum ? " ⭐ОПТИМАЛЬНАЯ" : "";
      console.log(`  ${medal} ${wc} ${p.model}: ${(p.score * 100).toFixed(0)}/100  (${(p.durationMs / 1000).toFixed(1)}s, eff=${p.efficiency.toFixed(2)})${isOpt}`);
    });
    if (r.champion && r.optimum && r.champion !== r.optimum) {
      console.log(`  ↳ champion=${r.champion} (best score), optimum=${r.optimum} (best efficiency at ≥70% score)`);
    }
  }

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`📊 МЕДАЛЬНЫЙ ЗАЧЁТ`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  for (const m of report.medals) {
    const wc = `[${(report.modelWeightClass[m.model] ?? "?").toUpperCase()}]`.padEnd(4);
    console.log(`  ${wc} ${m.model.padEnd(45)}  🥇${m.gold}  🥈${m.silver}  🥉${m.bronze}   score=${m.totalScore.toFixed(2)}  time=${(m.totalDurationMs / 1000).toFixed(1)}s`);
  }

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`✨ РЕКОМЕНДАЦИИ для Settings → Models`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`(default = OPTIMUM: «бабушкин выбор» — почти как чемпион, но быстрее)`);
  if (Object.keys(report.recommendations).length === 0) {
    console.log("  (нет надёжных оптимумов — все модели завалили или дисциплины неинформативны)");
  } else {
    for (const [k, v] of Object.entries(report.recommendations)) {
      const champ = report.recommendationsByScore[k];
      const note = champ && champ !== v ? `  (champion=${champ})` : "";
      console.log(`  ${k.padEnd(20)} = ${v}${note}`);
    }
  }
  console.log(`\n📄 Полный отчёт: ${REPORT_PATH}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  console.log("ॐ Bibliary Olympics — реальный турнир локальных моделей");
  console.log(`   weight-classes: ${(args.weightClasses ?? ["s"]).join(", ")}`);
  console.log(`   disciplines: ${args.disciplines?.join(", ") ?? "all"}`);
  console.log(`   models: ${args.models?.join(", ") ?? "auto"}\n`);

  const t0 = Date.now();
  let report: OlympicsReport;
  try {
    report = await runOlympics({
      models: args.models,
      disciplines: args.disciplines,
      weightClasses: args.weightClasses,
      maxModels: args.maxModels,
      onProgress: (e) => {
        if (e.type === "olympics.start") {
          console.log(`▣ Старт: ${e.models.length} моделей × ${e.disciplines.length} дисциплин`);
        } else if (e.type === "olympics.discipline.start") {
          console.log(`\n▶ Дисциплина «${e.discipline}» (${e.role})`);
        } else if (e.type === "olympics.model.done") {
          const score = (e.score * 100).toFixed(0);
          const dur = (e.durationMs / 1000).toFixed(1);
          process.stdout.write(`     · ${e.model} → ${e.ok ? `${score}/100 (${dur}s)` : `FAIL (${e.error})`}\n`);
        }
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`✗ Олимпиада не запустилась: ${msg}`);
    process.exit(2);
  }

  await fs.mkdir(path.dirname(REPORT_PATH), { recursive: true });
  await fs.writeFile(REPORT_PATH, JSON.stringify(report, null, 2), "utf8");
  console.log(`\n[${((Date.now() - t0) / 1000).toFixed(1)}s wall-clock]`);
  printReport(report);
}

main().catch((e) => {
  console.error("✗ Olympics failed:", e);
  process.exit(1);
});
