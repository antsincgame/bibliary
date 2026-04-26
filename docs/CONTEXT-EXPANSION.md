# Расширение контекста — Universal YaRN Slider

> v3.1.0 · «сокровище индустрии»
>
> Внутреннее (историческое) название: Memory Forge. В UI начиная с v2.4 — **«Расширение контекста»** (RU) / **«Context Expansion»** (EN).

Расширение контекста — это первая в индустрии «бытовая» абстракция над YaRN. Vibecoder двигает слайдер с пиктограммами «Чат / Документ / Книга / Кодекс / Библиотека» — Bibliary сам считает factor, проверяет VRAM, рекомендует KV-cache dtype, и атомарно патчит `config.json` модели в LM Studio. Без единой строки JSON, без формул, без открывания terminal.

## Что закрывает

Без расширения контекста, чтобы растянуть окно модели в LM Studio, vibecoder должен:

1. Знать что такое RoPE scaling.
2. Открыть LM Studio → Custom config → ввести JSON руками:
   ```json
   { "rope_scaling": { "rope_type": "yarn", "factor": 4.0, "original_max_position_embeddings": 262144 } }
   ```
3. Знать нативный контекст модели.
4. Самому посчитать `factor = target / native`.
5. Догадаться, что KV-cache раздуется в N раз и не влезет в VRAM.

«Расширение контекста» скрывает всё это под одним кликом по карточке «Книга».

## Архитектура

```
┌─ renderer ─────────────────────────────────────────────────────────────┐
│                                                                         │
│   context-slider.js  ◄──┐                                              │
│   (full / compact / embedded)                                           │
│                          │                                              │
│   context-presets.js     │                                              │
│   (большие task-карточки) │                                              │
│                          │                                              │
└──────────────────────────┼──────────────────────────────────────────────┘
                           │ window.api.yarn.{recommend, apply, revert, ...}
                           ▼
┌─ electron main process ─────────────────────────────────────────────────┐
│                                                                         │
│   electron/lib/yarn/                                                    │
│   ├── engine.ts          — pure logic (recommend, factor, KV-cache)     │
│   ├── lmstudio-patcher.ts — atomic write rope_scaling + backup          │
│   ├── suggestions.ts     — 4 типа советов с one-click action            │
│   ├── native-contexts.json — БД 15+ моделей (native, yarnMax, arch)     │
│   └── index.ts           — barrel                                       │
│                                                                         │
│   ipc-handlers.ts (yarn:*)                                              │
│     · recommend(modelKey, target, vram?)  →  arch + recommendation +   │
│                                              suggestions                │
│     · apply(modelKey, target, kvDtype)    →  atomic patch + backup     │
│     · revert(modelKey)                    →  restore from backup        │
│     · readCurrent(modelKey)               →  current rope_scaling       │
│     · listModels()                        →  known DB                   │
│     · hasBackup(modelKey)                 →  bool                       │
│                                                                         │
│   resilience/telemetry.ts                                               │
│     yarn.context.changed / preset.applied / suggestion.shown /          │
│     suggestion.applied / applied / reverted / error                     │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
                           │ filesystem
                           ▼
        ~/.cache/lm-studio/models/<author>/<repo>/
        ├── <model>.gguf
        ├── config.json                ◄── мы пишем сюда rope_scaling
        └── config.bibliary.bak.json   ◄── backup, создаётся автоматически
```

## Engine — формулы

### YaRN factor

```typescript
factor = snap(target / native)
// snap → ближайший шаг из {1.5, 2, 3, 4, 6, 8, 12, 16}
// причина: Qwen team рекомендует целые / полуцелые factor (меньше деградации)
```

Возвращает `null` если `target ≤ native` — значит YaRN не нужен.

### KV-cache estimate (источник: flozi.net 2026)

```
bytes = 2 × n_layers × n_kv_heads × head_dim × context × dtype_bytes
```

- `2` — отдельные тензоры K и V
- `n_kv_heads` — с учётом GQA (Llama3-8B: 8, не 32)
- `dtype_bytes` — `fp16=2`, `q8_0=1`, `q4_0=0.5`

Пример: Qwen3.6-35B (L=64, Hkv=8, Hd=128) на 32K контексте FP16 = 8 GB.

### KV-dtype recommendation

Приоритет: fp16 > q8_0 > q4_0. Если ничто не помещается — возвращает q4_0 + warning.

## БД моделей

`electron/lib/yarn/native-contexts.json` — 15+ моделей с метаданными для расчёта KV-cache. Поля:

| Поле | Описание |
|---|---|
| `modelKey` | Канонический ключ как в LM Studio (lowercase, slash) |
| `displayName` | Человеческое имя для UI |
| `nativeTokens` | Нативный максимум контекста (без YaRN) |
| `yarnMaxTokens` | Officially-tested потолок YaRN (выше — на свой риск) |
| `nLayers`, `nKvHeads`, `headDim` | Архитектура для KV-cache |
| `family` | qwen3, llama3, mistral, gemma, phi3, deepseek |
| `moe` | true для MoE моделей (Qwen3.6-A3B, DeepSeek V2 Lite) |

Если модель не в БД, возвращается `fallback` с консервативными дефолтами (4K native).

## Smart Suggestions

Каждая suggestion — `{ id, severity, params, action? }`. Реализовано 5 типов:

| ID | Severity | Когда | One-click action |
|---|---|---|---|
| `yarn-not-needed` | info | target ≤ native | disable-yarn |
| `kv-fit` | warn | FP16 не лезет, есть Q8/Q4 лекарство | set-kv-dtype |
| `kv-fit` (no fit) | warn | даже Q4 не лезет | lower-target |
| `factor-too-high` | tip | factor > 4 | — |
| `official-supported` | good | factor ≤ 4 и в пределах yarnMax | — |
| `exceeds-max` | warn | target > yarnMaxTokens | — |

Suggestions появляются как inline-карточки под слайдером. Action-кнопки изменяют состояние слайдера и заново вызывают recommend.

## LM Studio Patcher

### Atomic write через `withFileLock` + `writeJsonAtomic`

Гарантии:
- Сбой питания → `config.json` либо старый, либо новый, никогда полу-записанный
- Параллельный UI + CLI → сериализуются через `proper-lockfile`
- Перед первой правкой — backup в `config.bibliary.bak.json`
- Если оригинал отсутствовал — backup это sentinel `{ __bibliary_no_original__: true }`

### `applyRopeScaling(modelKey, scaling)`

```typescript
// Идемпотентен по содержимому. Backup создаётся ОДНОКРАТНО — повторные apply
// не пересоздают .bak (он защищает оригинал).
const result = await applyRopeScaling("qwen/qwen3.6-35b-a3b", {
  rope_type: "yarn",
  factor: 4,
  original_max_position_embeddings: 262144,
});
// result: { configPath, backupCreated: true|false, hadPriorRopeScaling: true|false }
```

### `revertRopeScaling(modelKey)`

```typescript
// Восстанавливает config.json из .bak, удаляет .bak.
// Если .bak это sentinel — удаляет сам config.json (нечего восстанавливать).
const result = await revertRopeScaling("qwen/qwen3.6-35b-a3b");
// result: { configPath, restored: true, configRemoved: bool }
```

## UI: три режима context-slider

### `mode: "full"` — Models route

Полный UI: header, 5 сегментов-presets, range, текущее значение, VRAM bar, suggestions, technical details (свёрнуто), Apply + Revert кнопки.

### `mode: "compact"` — Chat top-bar popover

Только header + presets + range + текущее значение. Без VRAM bar и details — экономит место в небольшом popover'е. Apply + Revert работают.

### `mode: "embedded"` — мастер дообучения, Step 3 (Phase 3.2)

Без apply-кнопки. Значения экспортируются через `slider.getValue()` в config-generator.

## Telemetry

Все события — структурированный JSON в `data/telemetry.jsonl`:

```jsonl
{"type":"yarn.context.changed","modelKey":"qwen/qwen3-8b","fromTokens":131072,"toTokens":262144,"factor":2,"kvDtype":"fp16","ts":"2026-04-20T12:00:00Z"}
{"type":"yarn.preset.applied","modelKey":"qwen/qwen3-8b","presetId":"codex","targetTokens":262144,"ts":"..."}
{"type":"yarn.suggestion.shown","modelKey":"...","suggestionId":"kv-fit","severity":"warn","ts":"..."}
{"type":"yarn.suggestion.applied","modelKey":"...","suggestionId":"kv-fit","action":"set-kv-dtype","ts":"..."}
{"type":"yarn.applied","modelKey":"...","factor":4,"kvDtype":"q8_0","vramEstimateGb":8,"ts":"..."}
{"type":"yarn.reverted","modelKey":"...","reason":"user-requested","ts":"..."}
{"type":"yarn.error","modelKey":"...","error":"Model directory not found","ts":"..."}
```

## Тесты

Тесты YaRN engine интегрированы в основной unit-suite (`npm run test:fast`). Отдельного файла `scripts/test-yarn-engine.ts` нет — логика engine покрыта через integration тесты и используется в production pipeline без отдельного скрипта.

Проверить работу YaRN вручную:
```bash
# Запустить приложение и перейти в Models route → Расширение контекста
npm run electron:dev
```

## Wow-критерий релиза

Vibecoder, никогда не слышавший про YaRN, должен за **20 секунд** на новой модели:

1. Models route → Load
2. Раскрыть «Расширение контекста» для модели
3. Кликнуть пресет «Книга» 📖
4. Увидеть «✓ помещается в ваш GPU»
5. Нажать «Применить к модели»
6. Получить рабочий 128K-контекст без единой строки JSON, terminal или документации

Это приёмочный сценарий. Если хоть один шаг падает — релиз блокируется.

## Статус roadmap

- **Phase 3.2** — мастер дообучения использует slider в режиме `embedded` для выбора `max_seq_length` ✅ **реализовано** (`mode: "embedded"` в `context-slider.js`, Step 2 Forge wizard)
- **Hardware Profiler** — передача точного `vramGB` в slider для автоматического recommendation — **backlog** (нет в текущем roadmap)
- **ProfileStore** — автоматическая регистрация новой модели после fine-tune — **backlog** (GGUF auto-import работает, но ProfileStore registration не реализована)
- **Live HF lookup** — подтягивать `config.json` с Hugging Face для незнакомых моделей — **backlog**
