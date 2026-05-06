# 01 — Роли LLM в Bibliary

## Карта ролей (актуально для 2026-05-06)

Тип `ModelRole` определён в `electron/lib/llm/model-role-resolver-internals.ts`.
Резолвер: `electron/lib/llm/model-role-resolver.ts`. Fallback chain:
`electron/lib/llm/with-model-fallback.ts`. Pref keys: `electron/lib/preferences/store.ts`.

| Роль | Что делает | Capabilities | Где вызывается | Thinking? |
|------|-----------|--------------|----------------|-----------|
| `crystallizer` | Извлечение фактов / сущностей / отношений из chunk (delta-extractor). | — | `dataset-v2/delta-extractor.ts`, `library/md-converter.ts` (text-meta fallback) | ✅ ДА |
| `evaluator` | Оценка качества книги по описанию (0-10). | — | `library/book-evaluator.ts` (через свой `pickEvaluatorModel`) | ⚠️ для серой зоны 5-7 |
| `vision_meta` | Извлечение metadata из обложки (title, author, year). | `vision` | `library/md-converter.ts` (`extractMetadataFromCover`) | ❌ |
| `vision_ocr` | OCR сканированных страниц без text layer. | `vision` | `scanner/ocr/index.ts` (`recognizeWithVisionLlm`) | ❌ |
| `vision_illustration` | Описание иллюстраций для full-text search. | `vision` | `library/illustration-worker.ts` | ❌ |
| `layout_assistant` | Cleanup типографики и layout post-import. | — | `library/layout-assistant.ts` | ❌ |
| `ukrainian_specialist` | Кристаллизация для украинских книг (специализированная LLM). | — | `dataset-v2/extraction-runner.ts` через `resolveCrystallizerForLanguage` (lang === "uk" + prefs configured) | ✅ ДА (как crystallizer) |
| `lang_detector` | Определение языка фрагмента (en/ru/uk/de/...). | — | `llm/lang-detector.ts` (LLM-путь написан, но в production используется regex) | ❌ |
| `translator` | Перевод UK→RU при ingest (legacy). | — | `scanner/ingest.ts` — **stub, no-op в MVP v1.0** | ❌ |

**Удалённые роли** (для истории — не возвращать без необходимости):
- `judge` — был в Bradley-Terry матчах Олимпиады, удалён вместе с модулем (2026-05).

## Why thinking matters for crystallizer

> *LiteCoST (ICLR'26): для structured extraction CoT-модели дают **+8-12 quality
> points** на тестах с >10 фактами. Прямой вывод теряет связи между сущностями,
> CoT-модель проходит цепочкой и собирает топологию.*

**Конкретно в Bibliary:**
- Реальные chunks книг — это абзацы 200-1000 слов с десятками сущностей.
- Малая 3B-модель без thinking найдёт 2-3 очевидных факта (заголовок, автор, год).
- 8B+ модель с thinking найдёт 8-12 фактов и **связи** между ними.
- Связи (relations) — это и есть **топологический** скелет датасета,
  без которого граф знаний бесполезен.

## Why thinking is harmful for vision / lang_detector / translator

- **Vision-модели** не имеют CoT-tokens — они работают через image embeddings,
  thinking-block негде «жить». Дополнительный текстовый CoT ломает single-shot
  паттерн pixel→caption.
- **Lang-detector** — задача классификации с очевидным признаком (кириллица /
  латиница / иероглифы / специфические буквы `і ї є ґ` для украинского).
  Thinking просто тратит токены и даёт тот же ответ.
- **Translator** — последовательная генерация. Reasoning-блок прерывает поток
  и часто протекает в финальный текст («let me think... here's the translation:»).

## Why thinking is conditional for evaluator

- На крайних точках шкалы (1-3 шум, 9-10 классика) даже малая модель
  справляется без thinking — там сигнал явный.
- На **середине шкалы** (5-7) нужно одновременно держать в голове плюсы
  И минусы книги (актуальность темы vs устаревший год; известный автор vs
  плохое издательство). **Здесь thinking-модель даёт +30% accuracy.**

## Language router (украинский корпус)

Bibliary поддерживает украинский корпус. Для книг с `metadata.language === "uk"`
работает специальный роутер в `extraction-runner.ts`:

```
if (!args.extractModel && parsed.metadata.language === "uk") {
  const langAware = await resolveCrystallizerForLanguage("uk");
  // → ukrainian_specialist если сконфигурирован, иначе crystallizer
}
```

**Условие активации:** `prefs.ukrainianSpecialistModel` или
`prefs.ukrainianSpecialistModelFallbacks` непуст. Иначе graceful fallback
на стандартный crystallizer — украинская книга всё равно обработается,
просто без специализации.

**Что НЕ делает router:**
- Не переводит украинский текст в русский перед embedding (multilingual-e5
  обрабатывает украинский нативно, перевод сломал бы cross-lingual поиск).
- Не отбрасывает книгу если ни одна модель не подошла — fallback на
  generic crystallizer всегда сработает.

**Книги на других языках** (en, ru, de, fr, ...) идут через стандартный
crystallizer — современные мультиязычные LLM (Qwen, Llama, Mistral) их
обрабатывают без специализации.

## Алгоритм выбора модели в pipeline

```
function pickModelForRole(role, context):
  if role in {"lang_detector", "translator"}:
    # FAST path — отбрасываем reasoning-модели или просим disable thinking.
    return prefer(small_fast, exclude_reasoning=true)

  if role in {"vision_meta", "vision_ocr", "vision_illustration"}:
    return prefer(vision_capable)

  if role == "crystallizer":
    # Language-aware: для uk — попытка ukrainian_specialist.
    if context.language == "uk" and ukrainian_specialist_configured():
      return resolve("ukrainian_specialist")
    # SLOW path — reasoning-модели приоритетны для длинных chunks.
    return prefer(reasoning_capable, min_params="7B")

  if role == "evaluator":
    # CONDITIONAL — thinking желателен на ambiguous, но не на очевидном.
    return adaptive(reasoning_if_complex)

  if role == "layout_assistant":
    # Лёгкая роль для post-processing типографики.
    return prefer(small_fast)
```

## Stripping `<think>` для scorer'ов

Все scorer-функции получают **очищенный** `content` (через `stripThinkingBlock`),
чтобы не парсить reasoning-теги как часть ответа. Сами reasoning-блоки могут
быть полезны для UI-debug, но в pipeline идёт только финальный ответ.

## Capability filtering

Vision-роли (`vision_meta`, `vision_ocr`, `vision_illustration`) имеют
`required: ["vision"]` в `ROLE_REQUIRED_CAPS_INTERNAL`. Резолвер отбрасывает
кандидатов без vision capability. Остальные роли capability-agnostic —
любая загруженная LLM подходит.
