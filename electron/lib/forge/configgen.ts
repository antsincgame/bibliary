/**
 * Forge config generators — генерируют скрипты/конфиги для self-hosted
 * fine-tune workflow на базе единой `ForgeSpec`.
 *
 * Поддерживаются (v2.4 — self-hosted only):
 *   - Unsloth (Python-скрипт с FastLanguageModel + SFTTrainer + опциональный YaRN rope_scaling)
 *   - Axolotl (YAML)
 *   - README — инструкция по запуску workspace
 *
 * История: до v2.4 также поддерживались HuggingFace AutoTrain и Google Colab
 * notebook — удалены вместе с облачной инфраструктурой при переходе на 100%
 * self-hosted философию.
 *
 * Источники консенсуса 2026:
 *   - r=16, α=2r, all-linear targets, DoRA on, lr=2e-4, 2-3 epochs
 *   - JSONL ChatML формат, 90/10 train/val
 *   - QLoRA 4-bit для consumer GPU
 *   - YaRN rope_scaling для контекста > native (Peng et al., 2023)
 */

import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// Spec
// ─────────────────────────────────────────────────────────────────────────────

export const ForgeSpecSchema = z.object({
  /** Стабильный run-id (используется как project_name). */
  runId: z.string().min(1).max(64),
  /** HF-имя базовой модели (например "unsloth/Qwen3-4B-Instruct-2507"). */
  baseModel: z.string().min(1).max(256),
  /** Метод тренировки. */
  method: z.enum(["lora", "qlora", "dora", "full"]).default("lora"),
  /** LoRA rank (4-128). */
  loraR: z.number().int().min(4).max(128).default(16),
  /** LoRA alpha (4-256). */
  loraAlpha: z.number().int().min(4).max(256).default(32),
  loraDropout: z.number().min(0).max(0.5).default(0.05),
  /** Включить DoRA (Dynamic LoRA). */
  useDora: z.boolean().default(true),
  /** Target modules для адаптеров. */
  targetModules: z.array(z.string()).default([
    "q_proj", "k_proj", "v_proj", "o_proj",
    "gate_proj", "up_proj", "down_proj",
  ]),
  /** Контекст. */
  maxSeqLength: z.number().int().min(512).max(1_048_576).default(2048),
  learningRate: z.number().min(1e-7).max(1e-2).default(2e-4),
  numEpochs: z.number().int().min(1).max(20).default(2),
  perDeviceBatchSize: z.number().int().min(1).max(64).default(2),
  gradientAccumulation: z.number().int().min(1).max(64).default(4),
  warmupRatio: z.number().min(0).max(0.5).default(0.03),
  weightDecay: z.number().min(0).max(0.5).default(0.01),
  scheduler: z.enum(["cosine", "linear", "constant"]).default("cosine"),
  optimizer: z.enum(["adamw_8bit", "adamw_torch", "paged_adamw_8bit"]).default("adamw_8bit"),
  /** Путь к датасету (HF repo или локальный JSONL). */
  datasetPath: z.string().min(1),
  /** Output dir. */
  outputDir: z.string().min(1).default("out/forge-run"),
  /** Quantization. */
  quantization: z.enum(["int4", "int8", "bf16", "fp16"]).default("int4"),
  /** Экспорт в GGUF Q4_K_M после тренировки. */
  exportGguf: z.boolean().default(true),
  /**
   * YaRN rope_scaling. Когда true и `yarnFactor > 1`, в train.py добавляется
   * `model_kwargs={"rope_scaling": {"type": "yarn", "factor": <factor>,
   * "original_max_position_embeddings": <nativeContextLength>}}` —
   * позволяет дообучать модель на контексте больше её native window.
   */
  useYarn: z.boolean().default(false),
  /** YaRN scaling factor (1..8). 1 = no scaling. */
  yarnFactor: z.number().min(1).max(8).default(1.0),
  /**
   * Родное окно контекста модели (для YaRN original_max_position_embeddings).
   * UI заполняет из yarn/native-contexts.json при выборе baseModel.
   * Опционально: если не задано и useYarn=true, train.py читает из config.json модели.
   */
  nativeContextLength: z.number().int().min(512).max(1_048_576).optional(),
});

export type ForgeSpec = z.infer<typeof ForgeSpecSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Unsloth Python
// ─────────────────────────────────────────────────────────────────────────────

/**
 * YaRN rope_scaling блок для FastLanguageModel.from_pretrained(...).
 * Возвращает строку для подстановки в kwargs либо пустую строку.
 * Для сохранения backward-compat исходных байтов (без YaRN) — пустая строка.
 */
function unslothYarnKwarg(spec: ForgeSpec): string {
  if (!spec.useYarn || spec.yarnFactor <= 1) return "";
  const native = spec.nativeContextLength ?? Math.max(2048, Math.floor(spec.maxSeqLength / spec.yarnFactor));
  return `\n    rope_scaling={"type": "yarn", "factor": ${spec.yarnFactor}, "original_max_position_embeddings": ${native}},`;
}

/** FastLanguageModel.from_pretrained(...) — загрузка базовой модели + токенайзера. */
function unslothLoadModelBlock(spec: ForgeSpec): string {
  const loadIn4bit = spec.quantization === "int4" ? "True" : "False";
  return `model, tokenizer = FastLanguageModel.from_pretrained(
    model_name="${spec.baseModel}",
    max_seq_length=${spec.maxSeqLength},
    dtype=None,
    load_in_4bit=${loadIn4bit},${unslothYarnKwarg(spec)}
)`;
}

/** get_peft_model(...) — установка LoRA/DoRA адаптера поверх базовой модели. */
function unslothPeftBlock(spec: ForgeSpec): string {
  const targetModulesStr = JSON.stringify(spec.targetModules);
  return `model = FastLanguageModel.get_peft_model(
    model,
    r=${spec.loraR},
    lora_alpha=${spec.loraAlpha},
    lora_dropout=${spec.loraDropout},
    bias="none",
    use_dora=${spec.useDora ? "True" : "False"},
    target_modules=${targetModulesStr},
    use_gradient_checkpointing="unsloth",
    random_state=42,
)`;
}

/** SFTTrainer(...) — конфиг тренера + TrainingArguments. */
function unslothTrainerBlock(spec: ForgeSpec): string {
  return `trainer = SFTTrainer(
    model=model,
    tokenizer=tokenizer,
    train_dataset=dataset,
    dataset_text_field="messages",
    max_seq_length=${spec.maxSeqLength},
    args=TrainingArguments(
        per_device_train_batch_size=${spec.perDeviceBatchSize},
        gradient_accumulation_steps=${spec.gradientAccumulation},
        warmup_ratio=${spec.warmupRatio},
        num_train_epochs=${spec.numEpochs},
        learning_rate=${spec.learningRate},
        logging_steps=10,
        save_strategy="epoch",
        optim="${spec.optimizer}",
        weight_decay=${spec.weightDecay},
        lr_scheduler_type="${spec.scheduler}",
        output_dir="${spec.outputDir}",
        report_to="none",
    ),
)`;
}

/**
 * GGUF-export блок (Q4_K_M для LM Studio / llama.cpp).
 * Возвращает строку с leading и trailing newline когда экспорт включён,
 * пустую строку когда выключен — формат сохранён из исходной реализации,
 * поэтому окружающий шаблон не нужно менять.
 */
function unslothExportBlock(spec: ForgeSpec): string {
  if (!spec.exportGguf) return "";
  return `
# Export to GGUF for LM Studio / llama.cpp
model.save_pretrained_gguf("${spec.outputDir}/gguf-q4_k_m", tokenizer, quantization_method="q4_k_m")
`;
}

export function generateUnslothPython(spec: ForgeSpec): string {
  return `# Generated by Bibliary Forge v2.4 (self-hosted) — ${spec.runId}
# DOCS: https://docs.unsloth.ai
# RUN:  pip install -U "unsloth @ git+https://github.com/unslothai/unsloth.git"
#       python ${spec.runId}.py

from unsloth import FastLanguageModel
from trl import SFTTrainer
from transformers import TrainingArguments
from datasets import load_dataset

${unslothLoadModelBlock(spec)}

${unslothPeftBlock(spec)}

dataset = load_dataset("json", data_files="${spec.datasetPath}")["train"]

${unslothTrainerBlock(spec)}

trainer.train()
${unslothExportBlock(spec)}
print("DONE — adapters at ${spec.outputDir}")
`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Axolotl YAML
// ─────────────────────────────────────────────────────────────────────────────

/**
 * YaRN rope_scaling блок для Axolotl. Axolotl использует HF Transformers
 * config schema напрямую, поэтому ключ совпадает с rope_scaling в config.json.
 */
function axolotlYarnBlock(spec: ForgeSpec): string {
  if (!spec.useYarn || spec.yarnFactor <= 1) return "";
  const native = spec.nativeContextLength ?? Math.max(2048, Math.floor(spec.maxSeqLength / spec.yarnFactor));
  return `\nrope_scaling:\n  type: yarn\n  factor: ${spec.yarnFactor}\n  original_max_position_embeddings: ${native}`;
}

export function generateAxolotlYaml(spec: ForgeSpec): string {
  const isPeft = spec.method !== "full";
  const qloraBlock = spec.method === "qlora"
    ? "load_in_4bit: true\nbnb_4bit_quant_type: nf4\nbnb_4bit_compute_dtype: bfloat16"
    : "";

  return `# Generated by Bibliary Forge v2.4 (self-hosted) — ${spec.runId}
# RUN: axolotl train ${spec.runId}-axolotl.yaml
base_model: ${spec.baseModel}
model_type: AutoModelForCausalLM
tokenizer_type: AutoTokenizer

datasets:
  - path: ${spec.datasetPath}
    type: chat_template
    chat_template: chatml

dataset_prepared_path: last_run_prepared
val_set_size: 0.1
output_dir: ${spec.outputDir}

sequence_len: ${spec.maxSeqLength}
sample_packing: true
pad_to_sequence_len: true
${axolotlYarnBlock(spec)}

${qloraBlock}

${isPeft ? `adapter: ${spec.method === "dora" ? "lora" : spec.method}` : ""}
${isPeft ? `peft_use_dora: ${spec.useDora ? "true" : "false"}` : ""}
${isPeft ? `lora_r: ${spec.loraR}` : ""}
${isPeft ? `lora_alpha: ${spec.loraAlpha}` : ""}
${isPeft ? `lora_dropout: ${spec.loraDropout}` : ""}
${isPeft ? `lora_target_modules: ${JSON.stringify(spec.targetModules)}` : ""}

gradient_accumulation_steps: ${spec.gradientAccumulation}
micro_batch_size: ${spec.perDeviceBatchSize}
num_epochs: ${spec.numEpochs}
optimizer: ${spec.optimizer}
lr_scheduler: ${spec.scheduler}
learning_rate: ${spec.learningRate}
warmup_ratio: ${spec.warmupRatio}
weight_decay: ${spec.weightDecay}

train_on_inputs: false
group_by_length: false
bf16: true
gradient_checkpointing: true
flash_attention: true

logging_steps: 10
saves_per_epoch: 1
`;
}

// ─────────────────────────────────────────────────────────────────────────────
// README — инструкция для self-hosted workspace
// ─────────────────────────────────────────────────────────────────────────────

export function generateBundleReadme(spec: ForgeSpec, files: string[]): string {
  const fileList = files.map((f) => `- \`${f}\``).join("\n");
  const yarnNote = spec.useYarn && spec.yarnFactor > 1
    ? `\n## YaRN context expansion\n\nЭтот workspace использует YaRN rope_scaling: factor=${spec.yarnFactor} → max_seq_length=${spec.maxSeqLength}.\nЭто позволяет тренировать на контексте больше родного окна модели ценой ~15-20% времени тренировки.\nКонфигурация уже записана в \`${spec.runId}.py\` и \`${spec.runId}-axolotl.yaml\`.\n`
    : "";

  return `# Bibliary Forge workspace — ${spec.runId}

Локальный self-hosted workspace для fine-tune. Запустите на своей машине,
WSL, или арендованном bare-metal GPU (RunPod / Vast.ai / Lambda Labs).

## Содержимое

${fileList}

## Запуск

| Среда | Файл | Команда |
|---|---|---|
| Local Python (Win/Linux/Mac) | \`${spec.runId}.py\` | \`python ${spec.runId}.py\` |
| Axolotl | \`${spec.runId}-axolotl.yaml\` | \`axolotl train ${spec.runId}-axolotl.yaml\` |

## Параметры

- **Базовая модель**: \`${spec.baseModel}\`
- **Метод**: ${spec.method.toUpperCase()} (r=${spec.loraR}, α=${spec.loraAlpha}, DoRA=${spec.useDora ? "on" : "off"})
- **Контекст**: ${spec.maxSeqLength} токенов${spec.useYarn && spec.yarnFactor > 1 ? ` (YaRN ×${spec.yarnFactor})` : ""}
- **Эпохи**: ${spec.numEpochs}
- **Learning rate**: ${spec.learningRate}
- **Quantization**: ${spec.quantization}
${yarnNote}
## После тренировки

1. GGUF файл будет в \`${spec.outputDir}/gguf-q4_k_m/\` (если \`exportGguf\`).
2. Скопируйте в \`~/.cache/lm-studio/models/bibliary-finetuned/${spec.runId}/\`.
3. Перезапустите LM Studio. Модель появится в Bibliary Models route автоматически.

---
Сгенерировано Bibliary Forge v2.4 (self-hosted only).
`;
}
