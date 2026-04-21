// Чистая утилита для чтения каталога обучающих JSONL-батчей.
// Источник для Forge — после экстерминатуса legacy v1 dataset generator пользователь
// кладёт сюда .jsonl вручную либо через будущий v2 экспорт.
import { promises as fs } from "fs";
import * as path from "path";

const FINETUNE_DIR = path.resolve("data", "finetune");
const BATCHES_DIR = path.join(FINETUNE_DIR, "batches");

export function getBatchesDir(): string {
  return BATCHES_DIR;
}

export async function ensureBatchesDir(): Promise<void> {
  await fs.mkdir(BATCHES_DIR, { recursive: true });
}

export async function listBatchFiles(): Promise<string[]> {
  try {
    const entries = await fs.readdir(BATCHES_DIR);
    return entries.filter((f) => f.endsWith(".jsonl")).sort();
  } catch {
    return [];
  }
}
