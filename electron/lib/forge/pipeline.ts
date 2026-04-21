/**
 * Forge pipeline — оркестрация preparation + bundle.
 *
 * Шаги:
 *   1. Прочитать batch JSONL (ShareGPT) → парсинг → конверсия в ChatML
 *   2. Train/val/eval split с seed
 *   3. Записать train.jsonl, val.jsonl, eval.jsonl в forge/<runId>/
 *   4. Сгенерировать configs (unsloth.py, autotrain.yaml, colab.ipynb, axolotl.yaml)
 *
 * Bundle = папка. ZIP-упаковка пока не входит в MVP — пользователь
 * упаковывает вручную (Compress-Archive / 7z), либо см. roadmap раздела
 * Forge в plans/ для интеграции `archiver`/`adm-zip`.
 *
 * Использует resilience-stack: writeJsonAtomic, withFileLock.
 */

import { promises as fs } from "fs";
import * as path from "path";

import { writeJsonAtomic } from "../resilience";
import {
  parseAsChatML,
  chatMLLinesToJsonl,
  splitLines,
  type ChatMLLine,
} from "./format";
import {
  generateAutoTrainYaml,
  generateAxolotlYaml,
  generateColabNotebook,
  generateUnslothPython,
  generateBundleReadme,
  type ForgeSpec,
} from "./configgen";

// ─────────────────────────────────────────────────────────────────────────────

export interface PrepareOptions {
  spec: ForgeSpec;
  /** Путь к исходному JSONL (ShareGPT или ChatML). */
  sourceJsonl: string;
  /** Корень для артефактов (data/forge/<runId>). */
  workspaceDir: string;
  /** Train ratio. */
  trainRatio?: number;
  /** Eval ratio (от total). */
  evalRatio?: number;
  /** Seed. */
  seed?: number;
}

export interface PrepareResult {
  trainPath: string;
  valPath: string;
  evalPath: string;
  counts: { total: number; train: number; val: number; eval: number };
  parseErrors: Array<{ line: number; reason: string }>;
}

export async function prepareDataset(opts: PrepareOptions): Promise<PrepareResult> {
  await fs.mkdir(opts.workspaceDir, { recursive: true });

  const raw = await fs.readFile(opts.sourceJsonl, "utf8");
  const { lines, errors } = parseAsChatML(raw);

  const split = splitLines<ChatMLLine>(lines, {
    trainRatio: opts.trainRatio ?? 0.9,
    evalRatio: opts.evalRatio ?? 0,
    seed: opts.seed ?? 42,
  });

  const trainPath = path.join(opts.workspaceDir, "train.jsonl");
  const valPath = path.join(opts.workspaceDir, "val.jsonl");
  const evalPath = path.join(opts.workspaceDir, "eval.jsonl");

  await fs.writeFile(trainPath, chatMLLinesToJsonl(split.train), "utf8");
  await fs.writeFile(valPath, chatMLLinesToJsonl(split.val), "utf8");
  await fs.writeFile(evalPath, chatMLLinesToJsonl(split.eval), "utf8");

  return {
    trainPath,
    valPath,
    evalPath,
    counts: {
      total: lines.length,
      train: split.train.length,
      val: split.val.length,
      eval: split.eval.length,
    },
    parseErrors: errors,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Bundle — генерация набора файлов в одной папке.
// ─────────────────────────────────────────────────────────────────────────────

export interface BundleResult {
  bundleDir: string;
  files: string[];
  /**
   * Зарезервировано под будущую интеграцию `archiver`/`adm-zip`.
   * Сейчас всегда `null` — bundle отдаётся как папка.
   */
  zipPath: string | null;
}

export async function generateBundle(opts: {
  spec: ForgeSpec;
  workspaceDir: string;
}): Promise<BundleResult> {
  await fs.mkdir(opts.workspaceDir, { recursive: true });

  const files: string[] = [];

  // Unsloth Python
  const pyPath = path.join(opts.workspaceDir, `${opts.spec.runId}.py`);
  await fs.writeFile(pyPath, generateUnslothPython(opts.spec), "utf8");
  files.push(`${opts.spec.runId}.py`);

  // AutoTrain YAML
  const ytPath = path.join(opts.workspaceDir, `${opts.spec.runId}.yaml`);
  await fs.writeFile(ytPath, generateAutoTrainYaml(opts.spec), "utf8");
  files.push(`${opts.spec.runId}.yaml`);

  // Colab notebook
  const ipynbPath = path.join(opts.workspaceDir, `${opts.spec.runId}.ipynb`);
  await writeJsonAtomic(ipynbPath, generateColabNotebook(opts.spec));
  files.push(`${opts.spec.runId}.ipynb`);

  // Axolotl YAML
  const axPath = path.join(opts.workspaceDir, `${opts.spec.runId}-axolotl.yaml`);
  await fs.writeFile(axPath, generateAxolotlYaml(opts.spec), "utf8");
  files.push(`${opts.spec.runId}-axolotl.yaml`);

  // README
  const readmePath = path.join(opts.workspaceDir, "README.md");
  await fs.writeFile(readmePath, generateBundleReadme(opts.spec, files), "utf8");
  files.push("README.md");

  return {
    bundleDir: opts.workspaceDir,
    files,
    zipPath: null,
  };
}
