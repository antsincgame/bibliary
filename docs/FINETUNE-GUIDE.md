# Fine-tuning Guide — Qwen3 для локального вайбкодинга

Гайд по тренировке двух моделей на датасете, сгенерированном Bibliary, под
задачу генерации сайтов / текстов / UI.

## Целевые модели

| Профиль | Модель | Контекст | Назначение после тьюна |
|---|---|---|---|
| BIG | `unsloth/Qwen3.6-35B-A3B-bnb-4bit` | 262K (1M YaRN) | Генерация сайтов, длинные интерфейсы, ревью |
| SMALL | `unsloth/Qwen3-4B-Instruct-2507` | 32K (128K YaRN) | Inline ассистент, быстрая дистрибуция |

Обе тренируются **на одном датасете** (~1900 примеров), полученном из Bibliary
через UI Dataset Generator.

## Требования

- Linux / WSL2 / Colab Pro+
- Python 3.10+
- CUDA 12.4+
- Unsloth `>= 2026.4` (`pip install -U "unsloth[colab-new] @ git+https://github.com/unslothai/unsloth.git"`)
- Wandb (опционально для логов)

VRAM:
- SMALL: 8 GB достаточно (QLoRA 4-bit)
- BIG: 24 GB (QLoRA 4-bit, MoE — тренируются gating + shared expert + LoRA на routed)

## Подготовка датасета

```bash
# 1. Сгенерируй все батчи через Bibliary UI (Dataset Generator).
# 2. После генерации — слей в один файл:
node scripts/merge-dataset.cjs   # появится после Шага 4 ниже
# Результат: data/finetune/dataset.jsonl
```

Если merger ещё не написан, временно используй:

```bash
cat data/finetune/gold-examples.jsonl data/finetune/batches/*.jsonl > data/finetune/dataset.jsonl
```

## Общие гиперпараметры (для обеих моделей)

```python
TRAINING_CONFIG = dict(
    r=32,                      # LoRA rank
    lora_alpha=32,
    lora_dropout=0,
    bias="none",
    target_modules=[
        "q_proj", "k_proj", "v_proj", "o_proj",
        "gate_proj", "up_proj", "down_proj",
    ],
    use_gradient_checkpointing="unsloth",
    learning_rate=2e-4,
    lr_scheduler_type="cosine",
    warmup_ratio=0.03,
    optim="adamw_8bit",
    weight_decay=0.01,
)
```

## Тренировка SMALL (Qwen3-4B-Instruct-2507) — 8 GB VRAM

```python
from unsloth import FastLanguageModel
from trl import SFTTrainer
from datasets import load_dataset

model, tokenizer = FastLanguageModel.from_pretrained(
    model_name="unsloth/Qwen3-4B-Instruct-2507",
    max_seq_length=4096,
    load_in_4bit=True,
)

model = FastLanguageModel.get_peft_model(model, **TRAINING_CONFIG)

dataset = load_dataset("json", data_files="data/finetune/dataset.jsonl")["train"]

trainer = SFTTrainer(
    model=model,
    tokenizer=tokenizer,
    train_dataset=dataset,
    dataset_text_field="conversations",
    max_seq_length=4096,
    args=dict(
        per_device_train_batch_size=2,
        gradient_accumulation_steps=4,
        num_train_epochs=2,
        output_dir="out/qwen3-4b-mechanicus",
        logging_steps=10,
        save_strategy="epoch",
    ),
)
trainer.train()

# Экспорт в GGUF для LM Studio
model.save_pretrained_gguf("qwen3-4b-mechanicus-q8", tokenizer, quantization_method="q8_0")
```

Ожидаемое время: 3-5 часов на RTX 3060 12GB.

## Тренировка BIG (Qwen3.6-35B-A3B) — 24+ GB VRAM

```python
model, tokenizer = FastLanguageModel.from_pretrained(
    model_name="unsloth/Qwen3.6-35B-A3B-bnb-4bit",
    max_seq_length=4096,
    load_in_4bit=True,
)

# MoE-специфика: тренируем routing-веса + LoRA на experts
model = FastLanguageModel.get_peft_model(
    model,
    **TRAINING_CONFIG,
    target_modules=[
        "q_proj", "k_proj", "v_proj", "o_proj",
        "gate_proj", "up_proj", "down_proj",
        # MoE-специфика — gating и shared expert проходят через LoRA
        "shared_expert.gate_proj", "shared_expert.up_proj", "shared_expert.down_proj",
    ],
)

trainer = SFTTrainer(
    model=model,
    tokenizer=tokenizer,
    train_dataset=dataset,
    args=dict(
        per_device_train_batch_size=1,
        gradient_accumulation_steps=16,
        num_train_epochs=1,
        output_dir="out/qwen3.6-35b-mechanicus",
        logging_steps=5,
        save_strategy="epoch",
    ),
)
trainer.train()

model.save_pretrained_gguf("qwen3.6-35b-mechanicus-q4_k_m", tokenizer, quantization_method="q4_k_m")
```

Ожидаемое время: 12-18 часов на RTX 5090.

## Развёртывание после тьюна

1. Скопируй полученный `.gguf` в каталог моделей LM Studio
   (`%USERPROFILE%\.cache\lm-studio\models\<author>\<repo>\`).
2. Перезапусти LM Studio — модель появится в списке.
3. В Bibliary UI открой **Models** route и нажми Load.
4. Используй в **Chat** или подключи как генератор в новом батче — циклическое
   улучшение датасета.

## Vibecoding-специфика

Датасет содержит чанки по domain'ам:
- `ui` / `ux` — компоненты, паттерны, навигация
- `copy` — микрокопирайт, формы, CTA
- `seo` — структура, schema.org, локальный SEO
- `mobile` — iOS/Android паттерны
- `perf` / `arch` — оптимизация, архитектура

Этот микс покрывает полный стек "сайт + текст + UI" — после тьюна модель
по бриф-промпту выдаёт production-ready решение в нужном стиле.

## Иттерация

После каждых 5-10 батчей датасета — перезапускай тренировку и оцени delta
качества вручную (compare-mode в Chat: модель до vs после).

Когда качество перестало расти — собери финальный merge и зафиксируй версию
GGUF в `docs/MODELS-CHANGELOG.md`.
