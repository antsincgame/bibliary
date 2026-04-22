# Дообучение — мастер fine-tuning (Cloud Bridge, Phase 3.2)

> v2.3.0 · «датасет → fine-tune за 5 шагов без Python»
>
> Внутреннее (исторические) название: Forge / Forge wizard. В UI начиная с v2.4 — **«Дообучение»** (RU) / **«Fine-tuning»** (EN). Идентификаторы кода (`ForgeSpec`, `electron/lib/forge/`, namespace `forge:*`) сохранены ради backward compatibility.

## Что это

«Дообучение» — это `route` в Bibliary, который превращает ShareGPT/ChatML JSONL батч в production-ready bundle для fine-tune в любом популярном фреймворке 2026:

- **Unsloth** (Python скрипт)
- **HuggingFace AutoTrain** (YAML config)
- **Google Colab** (.ipynb с pre-filled cells)
- **Axolotl** (YAML config)

Один общий Spec → 4 разных артефакта. Vibecoder может выбрать привычный fr или просто скачать ZIP-bundle и запустить «где угодно».

## 5-шаговый wizard

```
┌─ 1. Source ──┬─ 2. Format ──┬─ 3. Params ──┬─ 4. Target ──┬─ 5. Run ──┐
│ Pick batch    │ ShareGPT→     │ Quick preset  │ Colab /       │ Generate    │
│ JSONL         │ ChatML        │ или Advanced  │ AutoTrain /   │ bundle +    │
│ + preview     │ + train/val   │ + VRAM calc   │ ZIP / Local   │ open target │
│ 3 lines       │ /eval split   │ + ctx slider  │ (Phase 3.3)   │             │
└───────────────┴───────────────┴───────────────┴───────────────┴─────────────┘
```

### Step 1 — Source
Список batch-файлов из `data/finetune/batches/`. Клик «Выбрать» → preview первых 3 строк + total/error count.

### Step 2 — Format & Split
- Конвертация ShareGPT → ChatML (стандарт 2026)
- Slider train ratio 70-99% (default 90%)
- Slider eval ratio 0-30% (default 5%)
- Кнопка «Подготовить» — создаёт `train.jsonl` / `val.jsonl` / `eval.jsonl` в `data/forge/<runId>/` через `splitLines` с воспроизводимым seed=42.

### Step 3 — Method & Hyperparams
**Simple mode** — 3 кнопки-карточки:
| Preset | r | α | DoRA | lr | epochs |
|---|---|---|---|---|---|
| Быстро | 16 | 32 | ✓ | 2e-4 | 2 |
| Сбалансированно | 32 | 64 | ✓ | 1e-4 | 3 |
| Качество | 64 | 128 | ✓ | 5e-5 | 5 |

**Advanced/Pro** — раскрытая сетка с ВСЕМИ параметрами unsloth:
LoRA r/alpha/dropout/DoRA, LR/Epochs/Batch/Grad accum/Warmup/Weight decay, Method (qlora/lora/dora/full), Quant (int4/int8/bf16/fp16).

Внизу — **embedded slider «Расширение контекста»** (для `max_seq_length`) + **VRAM Calculator** (предсказывает поместится ли).

### Step 4 — Target
| Target | Где запускается | Bibliary делает |
|---|---|---|
| **Colab** | Google T4/A100 | Открывает colab.research.google.com, .ipynb загружается вручную |
| **AutoTrain** | HF Spaces | Открывает huggingface.co/autotrain, yaml загружается вручную |
| **Bundle** | Где угодно | ZIP с train.py + .yaml + .ipynb + axolotl + README |
| **Local WSL** | Pro tier | Phase 3.3 — пока disabled |

### Step 5 — Run
Сводка spec. Кнопка «Сгенерировать bundle и открыть» — создаёт все файлы в `data/forge/<runId>/`, отмечает в coordinator `forge.run.start`, открывает выбранный target.

После завершения тренировки извне — пользователь жмёт «Отметить: успех/сбой/отмена» — Bibliary логирует `forge.run.success` с durationMs и обновляет state.

## Архитектура

```
electron/lib/forge/
├── format.ts           — ShareGPT↔ChatML, parseAsChatML, splitLines
├── configgen.ts        — 4 generator + ForgeSpec Zod-схема
├── pipeline.ts         — prepareDataset, generateBundle (orchestration)
├── state.ts            — registerForgePipeline (coordinator), checkpoint store
└── index.ts            — barrel

electron/lib/hf/
└── client.ts           — safeStorage token, search, openExternal URL builders

electron/ipc-handlers.ts — namespaces: forge:*, hf:*

renderer/
├── forge.js            — основной 5-step wizard
└── components/
    ├── context-slider.js  — embedded mode для maxSeqLength
    └── vram-calc.js       — live VRAM прогноз
```

## ForgeSpec — единая схема

Zod-валидируемая структура, описывает ВСЁ что нужно для воспроизведения тренировки:

```typescript
{
  runId, baseModel, method,
  loraR, loraAlpha, loraDropout, useDora, targetModules,
  maxSeqLength, learningRate, numEpochs,
  perDeviceBatchSize, gradientAccumulation,
  warmupRatio, weightDecay, scheduler, optimizer,
  datasetPath, outputDir, quantization,
  pushToHub, hubModelId, exportGguf,
}
```

Один и тот же spec идёт во все 4 generator'а — гарантия consistent поведения.

## Resilience integration

«Дообучение» зарегистрировано как `pipeline: "forge"` в `coordinator` (имя пайплайна сохранено ради backward compatibility). Это даёт:
- **Resume** незавершённого run после перезапуска приложения
- **Telemetry**: `forge.run.start/success/fail`, `forge.cloud.upload`, `batch.start`
- **Watchdog**: интеграция с LM Studio offline detection (для local target в 3.3)
- **Graceful shutdown**: state сохраняется в `data/forge/checkpoints/<runId>.json` через `createCheckpointStore`

## HF integration (минимальный MVP)

Без зависимости от `@huggingface/hub` — реализовано на чистом fetch + safeStorage.

| API | Что делает | Auth |
|---|---|---|
| `searchModels(query)` | поиск через HF API | нет |
| `getModelInfo(repoId)` | подробности модели | нет |
| `saveHfToken(token)` | хранит в OS keychain | safeStorage |
| `loadHfToken()` | читает из keychain | safeStorage |
| `buildColabUrl()` | URL Colab | — |
| `buildAutoTrainUrl()` | URL AutoTrain | — |
| `buildModelPageUrl(repoId)` | страница модели | — |

В будущем (Phase 4) — добавить `@huggingface/hub` для full upload/download flow.

## Telemetry

Новые события в `data/telemetry.jsonl`:

```jsonl
{"type":"forge.run.start","runId":"forge-2026-04-20-1234","target":"colab","baseModel":"unsloth/Qwen3-4B-Instruct-2507","method":"qlora","ts":"..."}
{"type":"forge.run.success","runId":"...","durationMs":3600000,"ts":"..."}
{"type":"forge.run.fail","runId":"...","target":"autotrain","error":"OOM","ts":"..."}
{"type":"forge.cloud.upload","runId":"...","target":"colab","sizeMB":12.4,"ok":true,"ts":"..."}
```

## Тесты

`scripts/test-forge.ts` — 16 тестов:
- format converters (5)
- split с seed (3)
- configgen + Zod (6)
- pipeline prepareDataset + generateBundle (2)

Запуск:
```bash
npx tsx scripts/test-forge.ts
```

## Что дальше — Phase 3.3

- WSL detector + auto-bootstrap setup-wsl.sh
- spawn `wsl python forge-train.py` с live loss/grad-norm стримом
- Auto-copy GGUF → LM Studio dir + автоматическая регистрация в ProfileStore
- Eval Harness: A/B compare base vs tuned model на eval-set с rouge-l + LLM-as-judge
