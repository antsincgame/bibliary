/**
 * Forge config generators — генерируют готовые скрипты/конфиги для всех
 * популярных fine-tune фреймворков 2026 на основе единой `ForgeSpec`.
 *
 * Поддерживаются:
 *   - Unsloth (Python-скрипт с FastLanguageModel + SFTTrainer)
 *   - HuggingFace AutoTrain (llm-sft YAML)
 *   - Google Colab (.ipynb с pre-filled cells)
 *   - Axolotl (YAML)
 *
 * Источники консенсуса 2026:
 *   - r=16, α=2r, all-linear targets, DoRA on, lr=2e-4, 2-3 epochs
 *   - JSONL ChatML формат, 90/10 train/val
 *   - QLoRA 4-bit для consumer GPU
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
  /** Push to HF Hub. */
  pushToHub: z.boolean().default(false),
  hubModelId: z.string().optional(),
  /** Экспорт в GGUF Q4_K_M после тренировки. */
  exportGguf: z.boolean().default(true),
});

export type ForgeSpec = z.infer<typeof ForgeSpecSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Unsloth Python
// ─────────────────────────────────────────────────────────────────────────────

/** FastLanguageModel.from_pretrained(...) — загрузка базовой модели + токенайзера. */
function unslothLoadModelBlock(spec: ForgeSpec): string {
  const loadIn4bit = spec.quantization === "int4" ? "True" : "False";
  return `model, tokenizer = FastLanguageModel.from_pretrained(
    model_name="${spec.baseModel}",
    max_seq_length=${spec.maxSeqLength},
    dtype=None,
    load_in_4bit=${loadIn4bit},
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
  return `# Generated by Bibliary Forge v3 — ${spec.runId}
# DOCS: https://docs.unsloth.ai
# RUN:  pip install -U "unsloth[colab-new] @ git+https://github.com/unslothai/unsloth.git"
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
// HuggingFace AutoTrain YAML
// ─────────────────────────────────────────────────────────────────────────────

/**
 * AutoTrain `hub:` блок — добавляется только если `pushToHub` включён,
 * иначе пустая строка. Включает trailing newline когда непустой —
 * сохраняем формат исходного шаблона для байт-в-байт идентичности.
 */
function autoTrainHubBlock(spec: ForgeSpec): string {
  if (!spec.pushToHub) return "";
  const repoLine = spec.hubModelId ? `\n  repo_id: ${spec.hubModelId}` : "";
  return `hub:\n  username: \${HF_USERNAME}\n  token: \${HF_TOKEN}\n  push_to_hub: true${repoLine}\n`;
}

export function generateAutoTrainYaml(spec: ForgeSpec): string {
  const peft = spec.method !== "full" ? "peft: true" : "peft: false";
  const quant = spec.quantization === "int4" ? "quantization: int4" : spec.quantization === "int8" ? "quantization: int8" : "";
  const hub = autoTrainHubBlock(spec);

  return `# Generated by Bibliary Forge v3 — ${spec.runId}
# RUN: autotrain --config ${spec.runId}.yaml
task: llm-sft
base_model: ${spec.baseModel}
project_name: ${spec.runId}
log: tensorboard
backend: local

data:
  path: ${spec.datasetPath}
  train_split: train
  valid_split: null
  chat_template: tokenizer
  column_mapping:
    text_column: messages

params:
  block_size: ${spec.maxSeqLength}
  model_max_length: ${spec.maxSeqLength}
  epochs: ${spec.numEpochs}
  batch_size: ${spec.perDeviceBatchSize}
  gradient_accumulation: ${spec.gradientAccumulation}
  lr: ${spec.learningRate}
  warmup_ratio: ${spec.warmupRatio}
  weight_decay: ${spec.weightDecay}
  scheduler: ${spec.scheduler}
  optimizer: ${spec.optimizer}
  ${peft}
  lora_r: ${spec.loraR}
  lora_alpha: ${spec.loraAlpha}
  lora_dropout: ${spec.loraDropout}
  target_modules: all-linear
  ${quant}
  mixed_precision: bf16
  unsloth: true
${hub}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Colab notebook (.ipynb)
// ─────────────────────────────────────────────────────────────────────────────

export interface IPyNotebook {
  cells: IPyCell[];
  metadata: Record<string, unknown>;
  nbformat: 4;
  nbformat_minor: 5;
}

export interface IPyCell {
  cell_type: "markdown" | "code";
  source: string[];
  metadata?: Record<string, unknown>;
  outputs?: unknown[];
  execution_count?: null;
}

export function generateColabNotebook(spec: ForgeSpec): IPyNotebook {
  const md = (lines: string[]): IPyCell => ({ cell_type: "markdown", source: lines.map((l) => l + "\n") });
  const code = (lines: string[]): IPyCell => ({
    cell_type: "code",
    source: lines.map((l) => l + "\n"),
    metadata: {},
    outputs: [],
    execution_count: null,
  });

  return {
    cells: [
      md([
        `# Bibliary Forge — ${spec.runId}`,
        "",
        `Fine-tune **${spec.baseModel}** на вашем датасете.`,
        "",
        `- Метод: \`${spec.method.toUpperCase()}\` (rank=${spec.loraR}, α=${spec.loraAlpha}, DoRA=${spec.useDora ? "on" : "off"})`,
        `- Контекст: ${spec.maxSeqLength} токенов`,
        `- Эпохи: ${spec.numEpochs}, lr=${spec.learningRate}`,
        "",
        "**Шаги**: загрузите ваш датасет (или используйте HF), запустите все ячейки сверху вниз.",
      ]),
      md(["## 1. Установка зависимостей"]),
      code([
        "!pip install -U \"unsloth[colab-new] @ git+https://github.com/unslothai/unsloth.git\"",
        "!pip install -U trl peft accelerate bitsandbytes datasets",
      ]),
      md(["## 2. Загрузка датасета", "Замените путь на свой HF dataset или загрузите файл."]),
      code([
        `DATASET_PATH = "${spec.datasetPath}"  # HF repo или локальный JSONL после upload`,
        "from datasets import load_dataset",
        `dataset = load_dataset("json", data_files=DATASET_PATH)["train"]`,
        `print(f"Loaded {len(dataset)} examples")`,
      ]),
      md(["## 3. Загрузка модели + LoRA адаптер"]),
      code([
        "from unsloth import FastLanguageModel",
        "model, tokenizer = FastLanguageModel.from_pretrained(",
        `    model_name="${spec.baseModel}",`,
        `    max_seq_length=${spec.maxSeqLength},`,
        `    dtype=None,`,
        `    load_in_4bit=${spec.quantization === "int4" ? "True" : "False"},`,
        ")",
        "",
        "model = FastLanguageModel.get_peft_model(",
        "    model,",
        `    r=${spec.loraR},`,
        `    lora_alpha=${spec.loraAlpha},`,
        `    lora_dropout=${spec.loraDropout},`,
        '    bias="none",',
        `    use_dora=${spec.useDora ? "True" : "False"},`,
        `    target_modules=${JSON.stringify(spec.targetModules)},`,
        '    use_gradient_checkpointing="unsloth",',
        "    random_state=42,",
        ")",
      ]),
      md(["## 4. Тренировка"]),
      code([
        "from trl import SFTTrainer",
        "from transformers import TrainingArguments",
        "trainer = SFTTrainer(",
        "    model=model,",
        "    tokenizer=tokenizer,",
        "    train_dataset=dataset,",
        '    dataset_text_field="messages",',
        `    max_seq_length=${spec.maxSeqLength},`,
        "    args=TrainingArguments(",
        `        per_device_train_batch_size=${spec.perDeviceBatchSize},`,
        `        gradient_accumulation_steps=${spec.gradientAccumulation},`,
        `        warmup_ratio=${spec.warmupRatio},`,
        `        num_train_epochs=${spec.numEpochs},`,
        `        learning_rate=${spec.learningRate},`,
        "        logging_steps=10,",
        '        save_strategy="epoch",',
        `        optim="${spec.optimizer}",`,
        `        weight_decay=${spec.weightDecay},`,
        `        lr_scheduler_type="${spec.scheduler}",`,
        `        output_dir="${spec.outputDir}",`,
        '        report_to="none",',
        "    ),",
        ")",
        "trainer.train()",
      ]),
      ...(spec.exportGguf
        ? [
            md(["## 5. Экспорт GGUF для LM Studio"]),
            code([
              `model.save_pretrained_gguf("${spec.outputDir}/gguf-q4_k_m", tokenizer, quantization_method="q4_k_m")`,
              `print("GGUF saved — скачайте файл из ${spec.outputDir}/gguf-q4_k_m/ и положите в LM Studio models dir")`,
            ]),
          ]
        : []),
      md([
        "## Готово",
        "",
        "Положите GGUF в `~/.cache/lm-studio/models/bibliary-finetuned/<run-id>/`, перезапустите LM Studio.",
        "В Bibliary Models route модель появится автоматически.",
      ]),
    ],
    metadata: {
      kernelspec: { name: "python3", display_name: "Python 3" },
      colab: { provenance: [], gpuType: "T4" },
      bibliary: { runId: spec.runId, generatedBy: "bibliary-forge/v3" },
    },
    nbformat: 4,
    nbformat_minor: 5,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Axolotl YAML
// ─────────────────────────────────────────────────────────────────────────────

export function generateAxolotlYaml(spec: ForgeSpec): string {
  const isPeft = spec.method !== "full";
  const qloraBlock = spec.method === "qlora"
    ? "load_in_4bit: true\nbnb_4bit_quant_type: nf4\nbnb_4bit_compute_dtype: bfloat16"
    : "";

  return `# Generated by Bibliary Forge v3 — ${spec.runId}
# RUN: axolotl train ${spec.runId}.yaml
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
${spec.pushToHub && spec.hubModelId ? `hub_model_id: ${spec.hubModelId}` : ""}
`;
}

// ─────────────────────────────────────────────────────────────────────────────
// README — что делать с этой папкой
// ─────────────────────────────────────────────────────────────────────────────

export function generateBundleReadme(spec: ForgeSpec, files: string[]): string {
  const fileList = files.map((f) => `- \`${f}\``).join("\n");
  return `# Bibliary Forge bundle — ${spec.runId}

Эта папка содержит всё нужное для запуска fine-tune в любой среде.
Если нужен ZIP — упакуйте вручную (Windows: \`Compress-Archive\`, *nix: \`zip -r\`).

## Содержимое

${fileList}

## Что выбрать

| Среда | Файл | Команда |
|---|---|---|
| Local Python (Win/Linux/Mac) | \`${spec.runId}.py\` | \`python ${spec.runId}.py\` |
| HuggingFace AutoTrain | \`${spec.runId}.yaml\` | \`autotrain --config ${spec.runId}.yaml\` |
| Google Colab | \`${spec.runId}.ipynb\` | Загрузите → Run All |
| Axolotl | \`${spec.runId}-axolotl.yaml\` | \`axolotl train ${spec.runId}-axolotl.yaml\` |

## Параметры

- **Базовая модель**: \`${spec.baseModel}\`
- **Метод**: ${spec.method.toUpperCase()} (r=${spec.loraR}, α=${spec.loraAlpha}, DoRA=${spec.useDora ? "on" : "off"})
- **Контекст**: ${spec.maxSeqLength} токенов
- **Эпохи**: ${spec.numEpochs}
- **Learning rate**: ${spec.learningRate}
- **Quantization**: ${spec.quantization}

## После тренировки

1. GGUF файл будет в \`${spec.outputDir}/gguf-q4_k_m/\` (если \`exportGguf\`).
2. Скопируйте в \`~/.cache/lm-studio/models/bibliary-finetuned/${spec.runId}/\`.
3. Перезапустите LM Studio. Модель появится в Bibliary Models route автоматически.

---
Сгенерировано Bibliary Forge v3.
`;
}
