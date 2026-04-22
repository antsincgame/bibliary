# Дообучение — мастер fine-tuning (Self-Hosted, Phase 3.2 / v2.4)

> v2.4 · «датасет → fine-tune за 3 шага, на своём железе, без облачных счетов»
>
> Внутреннее (исторические) название: Forge / Forge wizard. В UI начиная с v2.4 — **«Дообучение»** (RU) / **«Fine-tuning»** (EN). Идентификаторы кода (`ForgeSpec`, `electron/lib/forge/`, namespace `forge:*`) сохранены ради backward compatibility.

## Философия — self-hosted only

Bibliary v2.4 — это **100% локальный продукт**. Дообучение работает только на железе пользователя:

- ✅ **Local Python / WSL** на своём ПК
- ✅ **Bare-metal GPU** аренда (RunPod, Vast.ai, Lambda Labs) — копируете workspace через `rsync`/`scp`, запускаете `python ${runId}.py`
- ❌ Никаких Google Colab — ваши данные не уходят в Google
- ❌ Никаких HuggingFace AutoTrain — никаких счетов за HF Spaces
- ❌ Никакого `push_to_hub` — модель остаётся на вашей машине

Если вам **обязательно** нужен Colab — экспортируйте `train.py` сами через `forge:gen-config` IPC. Bibliary его сгенерирует, но не будет открывать никаких внешних сервисов.

> **Историческая нота**: до v2.4 Bibliary поддерживал Colab/AutoTrain/HuggingFace `push_to_hub` как полноценные таргеты — вместе с HF token widget, AutoTrain YAML генератором и Colab notebook (.ipynb) генератором. Эта инфраструктура полностью удалена в v2.4 ради приватности и фокуса. См. `git log -- electron/lib/hf/` для архивного кода.

## Что это

«Дообучение» — это `route` в Bibliary, который превращает ShareGPT/ChatML JSONL батч в self-hosted **workspace** — папку с готовыми скриптами для запуска на своём железе:

- **Unsloth** (Python скрипт `${runId}.py`) — основной путь
- **Axolotl** (YAML config `${runId}-axolotl.yaml`) — для тех кто привык к axolotl pipeline
- **README.md** — инструкция: куда копировать workspace, чем запускать, что делать с GGUF после тренировки

Один общий Spec → 2 эквивалентных конфига для разных тренеров. Vibecoder выбирает привычный.

## 3-шаговый wizard

```
┌─ 1. Подготовка ────┬─ 2. Параметры ──────┬─ 3. Workspace ─────┐
│ Pick batch JSONL    │ 3 пресета            │ Сводка spec         │
│ + preview           │ + Base model         │ + «Сгенерировать    │
│ + Подготовить       │ + Context slider     │   файлы для         │
│ (split inside       │ + YaRN секция        │   запуска»          │
│  Advanced details)  │ + VRAM прогноз       │ + путь, открыть,    │
│                     │ + Advanced details   │   статус            │
└─────────────────────┴──────────────────────┴─────────────────────┘
```

### Step 1 — Подготовка

Объединяет старые Source + Format в один экран:

- Список batch-файлов из `data/finetune/batches/` → клик «Выбрать» → preview первых 3 строк + total/error count.
- Кнопка «Подготовить» создаёт `train.jsonl` / `val.jsonl` / `eval.jsonl` в `data/forge/<runId>/` через `splitLines` с воспроизводимым seed=42.
- В `<details>` «Расширенные настройки разбиения» — slider train ratio (default 90%) и eval ratio (default 5%). По умолчанию свёрнуто, чтобы не пугать новичков.

### Step 2 — Параметры

Главный экран. Всё что влияет на качество и потребление VRAM — здесь.

**Пресеты** (3 кнопки-карточки, оптимизированы под self-hosted энтузиастов):

| Preset | method | r | α | DoRA | lr | epochs | ctx | YaRN |
|---|---|---|---|---|---|---|---|---|
| Базовый | qlora | 32 | 64 | ✓ | 1e-4 | 3 | 8K | — |
| Максимальное качество | lora | 128 | 256 | ✓ | 3e-5 | 8 | 16K | — |
| Глубокий контекст (YaRN) | qlora | 32 | 64 | ✓ | 1e-4 | 4 | 131K | ×4 |

**Base model** — текстовое поле HF repo id. По change подгружается родное окно контекста модели через `window.api.yarn.recommend(...)` для YaRN-секции.

**Context slider** — embedded `buildContextSlider({ mode: "embedded" })` с реактивным обновлением VRAM-калькулятора и YaRN-объяснения. Если вы выкручиваете контекст выше native — Bibliary показывает toast «Контекст требует YaRN. Включить?».

**YaRN секция** (`forge.params.yarn_section`):
- Toggle «YaRN расширение»
- Auto-suggest factor = `ceil(maxSeqLength / nativeContext)` при включении
- Реактивный объяснительный текст:
  - `forge.yarn.off.short_ctx` — родного окна достаточно
  - `forge.yarn.off.long_ctx_warn` — ⚠ родного не хватает, рекомендуем YaRN
  - `forge.yarn.on` — ✓ rope_scaling factor=N будет записан в train.py
- Input коэффициента (1..8, шаг 0.5) — виден только когда YaRN on

**VRAM forecast секция** (`forge.params.vram_section`) — `buildVramCalculator(...)`. Всегда виден, не убирается. Реагирует на context, method, quant изменения live через `vramCalc.update(opts)`.

**Advanced details** (`<details>` свёрнут): полная сетка LoRA r/alpha/dropout/DoRA, LR/Epochs/Batch/Grad accum/Warmup/Weight decay, Method (qlora/lora/dora/full), Quant (int4/int8/bf16/fp16). Изменение Method/Quant дёргает refresh VRAM.

### Step 3 — Локальный Workspace

Сводка spec (`forge-run-summary`):
```
runId, model, method r=N α=N, context (с пометкой YaRN ×N если активен), dataset
```

**Workspace actions**:
- Кнопка «Сгенерировать файлы для запуска» (`forge.run.workspace.generate`) → `window.api.forge.generateBundle({ ... target: "bundle" })` (target захардкожен: backend всё равно поддерживает только bundle).
- После успеха показывается путь с кнопкой «Скопировать путь».
- Кнопка «Открыть workspace» — `forge:open-bundle-folder` (shell.openPath).

**Post-training details** (`<details>` свёрнут):
- Кнопки статуса: успех / сбой / отмена → `forge:mark-status` → telemetry `forge.run.success/fail`.
- `<EvalPanel>` (Pro mode) — A/B compare base vs tuned model.

## YaRN-augmented training

YaRN (Yet another RoPE extensioN, Peng et al., 2023) — алгоритм расширения контекстного окна модели за счёт интерполяции RoPE-частот. Bibliary интегрирует YaRN в pipeline дообучения:

1. **UI**: пресет «Глубокий контекст (YaRN)» или ручное включение через YaRN toggle.
2. **Spec**: `useYarn: true`, `yarnFactor: N`, `nativeContextLength: <native>` (заполняется из `electron/lib/yarn/native-contexts.json`).
3. **Generator**: `unslothYarnKwarg(spec)` в [configgen.ts](../electron/lib/forge/configgen.ts) добавляет в `FastLanguageModel.from_pretrained(...)`:
   ```python
   rope_scaling={"type": "yarn", "factor": 4.0, "original_max_position_embeddings": 32768},
   ```
   Аналогично `axolotlYarnBlock(spec)` пишет в Axolotl YAML:
   ```yaml
   rope_scaling:
     type: yarn
     factor: 4.0
     original_max_position_embeddings: 32768
   ```
4. **README workspace**: содержит секцию «YaRN context expansion» с пояснением что модель тренируется на расширенном контексте, что factor применён, и что ожидать ~15-20% дополнительного времени тренировки.

## Архитектура

```
electron/lib/forge/
├── format.ts           — ShareGPT↔ChatML, parseAsChatML, splitLines
├── configgen.ts        — generateUnslothPython, generateAxolotlYaml,
│                          generateBundleReadme + ForgeSpec Zod
├── pipeline.ts         — prepareDataset, generateBundle (3 файла)
├── state.ts            — registerForgePipeline (coordinator), checkpoint store
├── local-runner.ts     — Phase 3.3: spawn WSL python с live стримом
├── eval-harness.ts     — Eval Suite (rouge-l + judge)
├── wsl/                — WSL detection / paths
└── index.ts            — barrel

electron/ipc/forge.ipc.ts — namespace: forge:*

renderer/
├── forge.js            — 3-step self-hosted wizard
└── components/
    ├── context-slider.js  — embedded mode для maxSeqLength + YaRN suggestions
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
  datasetPath, outputDir, quantization, exportGguf,
  // YaRN (v2.4):
  useYarn, yarnFactor, nativeContextLength,
}
```

Один и тот же spec идёт во все 2 generator'а — гарантия consistent поведения. Backward compat: старые поля `pushToHub` / `hubModelId` Zod-схема молча отбрасывает (strict mode disabled).

## Resilience integration

«Дообучение» зарегистрировано как `pipeline: "forge"` в `coordinator` (имя пайплайна сохранено ради backward compatibility). Это даёт:
- **Resume** незавершённого run после перезапуска приложения
- **Telemetry**: `forge.run.start/success/fail`, `batch.start`
- **Watchdog**: интеграция с LM Studio offline detection (для Phase 3.3 local runner)
- **Graceful shutdown**: state сохраняется в `data/forge/checkpoints/<runId>.json` через `createCheckpointStore`

`ForgeRunStateSchema.target` принимает enum `["colab", "autotrain", "local", "bundle"]` ТОЛЬКО для backward compat со старыми checkpoint'ами v2.3. Новый код всегда пишет `"bundle"`.

## Workspace contents (генерируется в `data/forge/<runId>/`)

| Файл | Содержимое | Назначение |
|---|---|---|
| `${runId}.py` | Unsloth FastLanguageModel + SFTTrainer (+ rope_scaling если YaRN) | Local Python / WSL run |
| `${runId}-axolotl.yaml` | Axolotl config (chat_template chatml + LoRA + YaRN) | Альтернативный путь для axolotl users |
| `README.md` | Инструкции, параметры, post-training шаги | Руководство для рук |
| `train.jsonl` / `val.jsonl` / `eval.jsonl` | Подготовленные через prepareDataset | Датасеты после split |

Итого 6 файлов в workspace. Workspace = папка, без ZIP — сжатие пользователь делает сам если нужно (`Compress-Archive` / `zip -r` / `tar`).

## Telemetry

События в `data/telemetry.jsonl`:

```jsonl
{"type":"forge.run.start","runId":"forge-2026-04-20-1234","target":"bundle","baseModel":"unsloth/Qwen3-4B-Instruct-2507","method":"qlora","ts":"..."}
{"type":"forge.run.success","runId":"...","durationMs":3600000,"ts":"..."}
{"type":"forge.run.fail","runId":"...","target":"bundle","error":"OOM","ts":"..."}
```

## Тесты

`scripts/test-forge.ts` — 19 тестов:
- format converters (5)
- split с seed (3)
- configgen + Zod + YaRN (8 — включая YaRN rope_scaling в Unsloth и Axolotl, backward compat для pushToHub/hubModelId)
- pipeline prepareDataset + generateBundle workspace shape (3 — включая «не должно генерироваться AutoTrain/Colab»)

Запуск:
```bash
npx tsx scripts/test-forge.ts
```

## Что дальше — Phase 3.3

- WSL detector + auto-bootstrap setup-wsl.sh ✅ (готово, настройка одной командой)
- spawn `wsl python forge-train.py` с live loss/grad-norm стримом ✅ (LocalRunner)
- Auto-copy GGUF → LM Studio dir + автоматическая регистрация в ProfileStore
- Eval Harness ✅ (готов)
- Multi-run experiment matrix (запуск N spec'ов параллельно с разными hyperparams)
