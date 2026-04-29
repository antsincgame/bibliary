# 01 — Роли LLM и применимость Thinking-моделей

## Карта ролей

| Роль | Что делает | Объём вывода | Thinking? |
|------|-----------|--------------|-----------|
| `crystallizer` | Извлекает факты + сущности + отношения из chunk текста (delta-extractor). | JSON, средний-большой | ✅ **ДА** |
| `evaluator` | Оценивает качество книги по описанию (0-10). | JSON {score, reasoning} | ⚠️ **СЕРАЯ ЗОНА** (только для middle 5-7) |
| `judge` | Сравнивает два варианта (A vs B). Используется в Bradley-Terry матчах. | Один токен ("A"/"B") | ❌ **НЕТ** (overthinking вредит) |
| `lang_detector` | Определяет язык фрагмента (en/ru/uk/de/...). | 1-2 токена | ❌ **НЕТ** (single-shot pattern) |
| `translator` | Переводит UK→RU с сохранением технических терминов. | Связный текст | ❌ **НЕТ** (overthinking ломает поток) |
| `vision` | OCR + описание изображения (DJVU, scanned PDF). | Текст | ❌ **НЕТ** (vision-модели не имеют CoT-tokens) |

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

## Why thinking is harmful for judge / lang_detector / translator

- **Judge** должен ответить «A» или «B» одним токеном за <500 ms. Если он
  начинает thinking-цепочку — Bradley-Terry матч превращается из 64 матчей
  в 64×30s = полчаса вместо минуты.
- **Lang-detector** — задача классификации с очевидным признаком (кириллица /
  латиница / иероглифы). Thinking просто тратит токены и даёт тот же ответ.
- **Translator** — последовательная генерация. Reasoning-блок прерывает поток
  и часто протекает в финальный текст («let me think... here's the translation:»).

## Why thinking is conditional for evaluator

- На крайних точках шкалы (1-3 шум, 9-10 классика) даже малая модель
  справляется без thinking — там сигнал явный.
- На **середине шкалы** (5-7) нужно одновременно держать в голове плюсы
  И минусы книги (актуальность темы vs устаревший год; известный автор vs
  плохое издательство). **Здесь thinking-модель даёт +30% accuracy.**
- → В дисциплине `evaluator-nuanced` поставлен `thinkingFriendly: true`.

## Алгоритм выбора модели в pipeline

```
function pickModelForRole(role, available):
  if role in {"judge", "lang_detector", "translator"}:
    # FAST path — отбрасываем reasoning-модели или просим disable thinking.
    return prefer(small_fast, exclude_reasoning=true)

  if role == "vision":
    return prefer(vision_capable)

  if role == "crystallizer":
    # SLOW path — reasoning-модели приоритетны для длинных chunks.
    return prefer(reasoning_capable, min_params="7B")

  if role == "evaluator":
    # CONDITIONAL — thinking желателен на ambiguous, но не на очевидном.
    # Heuristic: если описание книги ≥150 chars — даём reasoning model.
    return adaptive(reasoning_if_complex)
```

## Stripping `<think>` для scorer'ов

Все scorer-функции получают **очищенный** `content` (через `stripThinkingBlock`),
чтобы не парсить reasoning-теги как часть ответа. Сами reasoning-блоки могут
быть полезны для UI-debug, но в pipeline идёт только финальный ответ.

## Проверка в Олимпиаде

| Роль | Дисциплина-якорь | Thinking? |
|------|------------------|-----------|
| crystallizer | `crystallizer-rover`, `crystallizer-ru-mendeleev` | нейтрально |
| crystallizer | `crystallizer-deep-extract` | ✅ **только thinking-friendly** |
| evaluator | `evaluator-clrs`, `evaluator-noise` | нейтрально |
| evaluator | `evaluator-midrange`, `evaluator-nuanced` | ✅ thinking-friendly |
| judge | (matches in Bradley-Terry round) | штраф за длительность |
| lang_detector | `lang-detect-uk-*`, `lang-detect-ru` | штраф за длительность |
| translator | `translator-uk-ru` | штраф за длительность |
| vision | `vision-describe` | n/a |
