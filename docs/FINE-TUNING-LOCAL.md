# Дообучение (локально) — WSL + Unsloth runner (Phase 3.3, Pro tier)

> v3.1.0 · «полный цикл fine-tune без выхода из Bibliary»
>
> Внутреннее (исторические) название: Forge Local. В UI — **«Дообучение → локально»** (RU) / **«Fine-tuning → local»** (EN). Идентификаторы кода (`forge:start-local`, `LocalRunner`, `electron/lib/forge/wsl.ts`) сохранены ради backward compatibility.

## Что это

Phase 3.3 расширяет «Дообучение» до полного локального цикла:

1. **WSL detector** — определяет наличие/версию/distros/CUDA passthrough
2. **setup-wsl.sh** — one-click bootstrap (venv + unsloth + torch CUDA)
3. **LocalRunner** — спавнит unsloth тренировку через WSL и стримит loss/grad-norm
4. **GGUF auto-import** — копирует выходной .gguf в LM Studio dir, регистрирует в ProfileStore
5. **Eval Harness** — A/B compare base vs tuned с ROUGE-L и LLM-as-judge

Всё это — в **Pro mode** UI (Simple/Advanced спрятано). Vibecoder без Pro mode видит target «Local WSL» как disabled.

## Архитектура

```
electron/lib/forge/
├── wsl.ts             — detectWSL, spawnWsl, toWslPath
├── local-runner.ts    — LocalRunner + parseMetric + importGgufToLMStudio
├── eval-harness.ts    — runEval, rougeL, judgeOne, chatMLToEvalCases
└── ...

electron/defaults/forge/
└── setup-wsl.sh       — bootstrap (apt, venv, pip torch+unsloth)
```

## WSL детект

```typescript
const info = await detectWSL();
// {
//   installed: true,
//   version: 2,
//   distros: ["Ubuntu", "Debian"],
//   defaultDistro: "Ubuntu",
//   gpuPassthrough: true,
// }
```

Внутри:
- `wsl.exe --list --verbose` (на не-Windows возвращает empty)
- Проверка `nvidia-smi -L` внутри default distro для GPU passthrough

UI рисует green/yellow badge в мастере дообучения, step 4: green если `installed && gpuPassthrough`, yellow при installed без CUDA.

## Setup script (`electron/defaults/forge/setup-wsl.sh`)

Идемпотентный bash:

1. `sudo apt install python3-venv python3-pip git`
2. `python3 -m venv ~/bibliary-forge/.venv`
3. `pip install torch --index-url https://download.pytorch.org/whl/cu124`
4. `pip install -U "unsloth[colab-new] @ git+..."`
5. `pip install -U trl peft accelerate bitsandbytes datasets transformers`
6. Smoke test: `python -c "import unsloth"`

Запуск из UI: `wsl bash /mnt/c/.../setup-wsl.sh`. Логи стримятся в маршруте «Дообучение».

## LocalRunner

```typescript
const runner = new LocalRunner();
runner.on("metric", (m) => {
  console.log(`step=${m.step} loss=${m.loss}`);
});
runner.on("exit", (code) => {
  if (code === 0) /* success */;
});
runner.start({
  scriptWinPath: "C:\\Users\\me\\forge-run-1.py",
  distro: "Ubuntu",
});
```

Парсер метрик использует regex на trainer log:

```
{'loss': 1.234, 'grad_norm': 0.567, 'learning_rate': 2e-4, 'epoch': 0.42}
```

Извлекает loss / gradNorm / learningRate / epoch + step (из `12/100` префикса).

## GGUF auto-import

```typescript
const { destPath, copied } = await importGgufToLMStudio(
  "out/forge-run-1",
  "qwen3-4b-bibliary-tuned"
);
// destPath: %USERPROFILE%/.cache/lm-studio/models/bibliary-finetuned/qwen3-4b-bibliary-tuned/<file>.gguf
// copied: 1
```

После копирования модель появляется в LM Studio listDownloaded → автоматически в Bibliary Models route → можно сразу применить «Расширение контекста» (YaRN).

## Eval Harness

### ROUGE-L (lexical overlap)

```typescript
const score = rougeL("hello world brown fox", "hello brown fox");
// { precision: 0.5, recall: 0.667, f1: 0.571 }
```

LCS-based, токены через split на whitespace. Для русского/китайского — character-level не делаем (упрощённо).

### LLM-as-judge

Используем уже-загруженную BIG модель (или любую другую) как judge. Промпт:

```
You are an impartial judge. You will compare two answers (A, B) to the same
question against a reference answer.
Score each answer from 0 to 2:
- 2 = matches reference in meaning and quality
- 1 = partially correct
- 0 = wrong or off-topic
Output STRICTLY in JSON: {"a": <0|1|2>, "b": <0|1|2>, "winner": "a"|"b"|"tie"}.
```

Парсим JSON из ответа, считаем wins.

### Полный run

```typescript
const summary = await runEval({
  cases: chatMLToEvalCases(loadedEvalLines, 50),
  baseModel: "qwen/qwen3-4b-2507",
  tunedModel: "bibliary-finetuned/qwen3-4b-bibliary-tuned",
  judgeModel: "qwen/qwen3.6-35b-a3b",
  chat: lmStudioChatFn,
  onProgress: (done, total) => updateUI(done, total),
});
// {
//   cases: [...],
//   meanRougeBase: 0.234,
//   meanRougeTuned: 0.567,
//   delta: 0.333,
//   judgeWins: { base: 2, tuned: 17, tie: 1 },
// }
```

## IPC namespace (`forge:*`, `wsl:*`)

| Канал | Что делает |
|---|---|
| `wsl:detect` | возвращает WslInfo |
| `forge:start-local` | создаёт LocalRunner, эмитит `forge:local-{metric,stdout,stderr,exit,error}` |
| `forge:cancel-local` | SIGTERM |
| `forge:import-gguf` | копирует .gguf в LM Studio dir |
| `forge:run-eval` | запускает runEval, эмитит `forge:eval-progress` |

## Telemetry

Расширены events Phase 3.2:

```jsonl
{"type":"forge.run.start","runId":"...","target":"local","baseModel":"...","method":"qlora","ts":"..."}
{"type":"forge.local.metric","runId":"...","step":42,"loss":1.234,"gradNorm":0.567,"lr":2e-4,"ts":"..."}
{"type":"forge.eval.compare","runId":"...","metric":"rouge-l","baseScore":0.234,"tunedScore":0.567,"delta":0.333,"ts":"..."}
```

## Troubleshooting

### LM Studio не видит модель после import
- Проверьте что файл лежит в `%USERPROFILE%/.cache/lm-studio/models/bibliary-finetuned/<name>/`
- Перезапустите LM Studio (модели сканируются при старте)
- Имя файла должно заканчиваться на `.gguf`

### `nvidia-smi` в WSL не работает
- Установите [Nvidia CUDA on WSL](https://docs.nvidia.com/cuda/wsl-user-guide/index.html)
- Драйвер должен быть на host Windows ≥ 510, не нужно ставить в WSL
- `wsl --shutdown && wsl` для рестарта VM

### OOM во время тренировки
- Откройте мастер дообучения → Step 3 → переключите method на `qlora`
- Уменьшите `maxSeqLength` (например 2048 → 1024)
- Уменьшите `perDeviceBatchSize` до 1
- Увеличьте `gradientAccumulation` (например 4 → 16)

### `unsloth` import падает после bootstrap
- Запустите вручную: `wsl ~/bibliary-forge/.venv/bin/python -c "import unsloth"`
- Если ругается на CUDA — проверьте `nvidia-smi` внутри WSL
- Если на bitsandbytes — `pip install --force-reinstall bitsandbytes`

### Eval Harness падает на judge
- Загрузите BIG модель в LM Studio с context ≥ 8K
- Если модель thinking (Qwen3.x) — увеличьте `max_tokens` через «Расширение контекста»

## Тесты

Отдельного `scripts/test-forge-local.ts` нет. Логика покрыта в рамках общего unit-suite:

- `tests/dataset-synth-presets.test.ts` — пресеты синтеза

Тесты WSL detect, parseMetric, ROUGE-L и runEval можно запустить вручную через разработческий DevTools в приложении или через `npm run test:agent-internals`.

Для полного unit-покрытия forge-local модулей — см. P2.6 в `docs/ROADMAP-TO-MVP.md`.
