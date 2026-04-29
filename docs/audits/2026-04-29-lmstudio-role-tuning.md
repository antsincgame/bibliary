# LM Studio SDK: per-role load configuration research

Дата: 2026-04-29
Статус: research-результат, готовый к интеграции в отдельной итерации.

## TL;DR

LM Studio SDK позволяет задать load-time параметры (`contextLength`, `gpu.ratio`,
`flashAttention`, `keepModelInMemory`, `tryMmap`) и inference-time параметры
(`temperature`, `topP`, `maxTokens`) на каждую загрузку модели. Bibliary сейчас
**не использует эту возможность** — модели грузятся с дефолтным preset, что для
production-pipeline сборки датасетов из 35 GB книг даёт суб-оптимальную RAM/VRAM
утилизацию.

**Implementation status:** `electron/lib/llm/role-load-config.ts` готов. Не
подключён к `lmsLoadModel()` — это требует UX-решения в Models page (тумблер
«Оптимизировать загрузку под роли»).

## Доступные параметры load-config

Источник: <https://lmstudio.ai/docs/typescript/api-reference/llm-load-model-config>

| Параметр | Тип | Описание |
|---|---|---|
| `contextLength` | `number` | Длина контекста в токенах. Главный driver RAM/VRAM. |
| `gpu` | `{ ratio: "max" \| "off" \| 0..1 }` | Доля слоёв на GPU. |
| `flashAttention` | `boolean` | Эффективная attention-implementation для длинных контекстов. |
| `keepModelInMemory` | `boolean` | Запрет swap в диск (для часто вызываемых ролей). |
| `tryMmap` | `boolean` | Memory-mapped загрузка (быстрый cold-start). |
| `offload_kv_cache_to_gpu` | `boolean` | KV-cache в GPU memory (для длинных context). |
| `eval_batch_size` | `number` | Batch size при evaluation. |

API:
```ts
const model = await client.llm.load("qwen2.5-7b-instruct", {
  config: {
    contextLength: 8192,
    gpu: { ratio: 0.5 },
    flashAttention: true,
  }
});
```

## Per-role recommended configs

См. полную таблицу в `electron/lib/llm/role-load-config.ts`. Сводка:

| Role | ctx | gpu | FA | keepInMem | rationale |
|---|---|---|---|---|---|
| crystallizer | 32K | max | ✓ | ✓ | длинные главы + thinking + structured output |
| evaluator | 4K | max | – | ✓ | короткое описание, много вызовов |
| judge | 2K | max | – | ✓ | бинарный A/B, минимум всего |
| translator | 8K | max | ✓ | – | страница input + output |
| lang_detector | 1K | 0.5 | – | – | один токен, мелкая модель |
| ukrainian_specialist | 4K | max | – | – | редкий вызов |
| vision_meta | 2K | max | – | ✓ | обложка → JSON, batch |
| vision_ocr | 8K | max | ✓ | ✓ | OCR может быть длинный |
| vision_illustration | 4K | max | – | ✓ | описание 1-3 предложения |

## Per-role inference defaults

| Role | temp | topP | maxTokens | rationale |
|---|---|---|---|---|
| crystallizer | 0.1 | 0.9 | 2048 | structured JSON — нужен детерминизм |
| evaluator | 0.2 | 0.9 | 512 | короткий JSON |
| judge | 0.0 | 0.5 | 16 | один токен (A/B) |
| translator | 0.2 | 0.9 | 4096 | точный перевод |
| lang_detector | 0.0 | 0.5 | 8 | один токен |
| ukrainian_specialist | 0.4 | 0.95 | 1024 | естественность речи |
| vision_meta | 0.0 | 0.7 | 256 | strict JSON |
| vision_ocr | 0.0 | 0.7 | 1024 | точность транскрипции |
| vision_illustration | 0.3 | 0.9 | 384 | живое описание |

## Почему это улучшит pipeline

### Сценарий A — batch import 1000 книг

Сейчас:
- Все модели грузятся с дефолтом (typically `contextLength=4096`, `gpu="auto"`).
- crystallizer вынужден усекать главы до 4K, теряя контекст.
- evaluator резервирует 4K хотя ему нужно 1K — VRAM расходуется впустую.
- При batch import vision_meta (одна обложка) тоже получает 4K буфер.

С per-role config:
- crystallizer = 32K → главы целиком + overlap + thesis помещаются.
- evaluator = 4K → не меняется, но free RAM не тратится зря.
- vision_meta = 2K → освобождает 2K * N_workers RAM для других ролей.

Грубая оценка экономии RAM при 4 одновременных воркерах: 8-16 GB в реальных
сборках Bibliary.

### Сценарий B — судья на batch evaluator-queue

Sample size: 200 пар. Сейчас:
- Каждый запрос грузит judge модель с defaultContext = 4096.
- При temp=0.7 (default) судья непредсказуем — на одинаковых парах разные ответы.

С per-role:
- judge: ctx=2K (×2 быстрее на тех же ядрах), temp=0.0 (детерминизм).

## Risks & blast radius

**Главный risk:** уменьшение `contextLength` ниже того что нужно роли в проде.
crystallizer в реальности может получить 50K-токенный chunk (длинная PDF
страница), и тогда 32K не хватит.

**Mitigation:** добавить health-check в `executeDiscipline` Олимпиады — если
prompt+output > contextLength, роль помечается `unsuitable` для модели.

## Integration plan (next iteration)

1. UI: в Models page добавить toggle «Optimize per-role load config» (default off).
2. Отдельный prefs-flag `roleLoadOptimizationEnabled`.
3. Обновить `lmsLoadModel()` в `olympics.ts`, чтобы при флаге передавать
   `{ config: getRoleLoadConfig(role) }`.
4. На Олимпиаде сравнить champions с/без оптимизации — реальное A/B.
5. Если champions стабильно лучше с оптимизацией → включить по умолчанию.

## References

- <https://lmstudio.ai/docs/typescript/api-reference/llm-load-model-config>
- <https://lmstudio.ai/docs/typescript/llm-prediction/parameters>
- <https://lmstudio.ai/docs/api/sdk/lmstudioclient>
- `electron/lib/llm/role-load-config.ts` — реализованные constants.
