# 02 — Топологическое Извлечение Знаний (Crystallizer)

## Цель

Из произвольного chunk текста (200-1500 токенов) получить:
1. **Атомарные факты** (`facts`) — каждая запись = одна проверяемая истина.
2. **Сущности** (`entities`) — нормализованные имена + типизация.
3. **Отношения** (`relations`) — `subject → predicate → object`, образующие
   топологический граф знаний.

## Целевая JSON-структура

```json
{
  "facts": [
    "Apollo 11 landed on the Moon on July 20, 1969",
    "Saturn V rocket was designed by Wernher von Braun"
  ],
  "entities": [
    {"name": "Apollo 11", "type": "mission"},
    {"name": "Wernher von Braun", "type": "person"},
    {"name": "Saturn V", "type": "rocket"}
  ],
  "relations": [
    {"subject": "Saturn V", "predicate": "designed_by", "object": "Wernher von Braun"},
    {"subject": "Apollo 11", "predicate": "launched_with", "object": "Saturn V"}
  ]
}
```

## Правила Кристаллизатора

### 1. Атомарность фактов
Один факт = одна истина. Не объединять «Armstrong и Aldrin вышли на Луну»
в один факт — это два факта.

### 2. Полнота сущностей
Каждое **имя собственное** должно стать сущностью с типом.
Типы: `person`, `place`, `event`, `mission`, `technology`, `concept`,
`organization`, `date`, `quantity`, `work` (книга/статья), `language`.

### 3. Связи — обязательны
Без `relations` датасет — это плоский список фактов.
**Минимум 1 relation на 3-4 факта.** Для технических текстов — ещё чаще.

### 4. Никаких галлюцинаций
**Запрещено** добавлять факты, которых нет в источнике, даже если они
«очевидны» из общих знаний. Это правило проверяется штрафами в scorer.

### 5. Сохранять цифры точно
Даты, количества, версии — копируй как есть. «1969» ≠ «1979».

## CoST-шаблон для thinking-моделей (LiteCoST)

Когда модель reasoning-capable (Qwen3, GLM-4.7, DeepSeek-R1), system-prompt
поощряет structured CoT:

```
You extract structured knowledge from text.
Think step by step BEFORE producing JSON:
  1. Identify all named entities → list them with types.
  2. List atomic facts (each fact = one verifiable truth).
  3. For each pair of related entities → define a predicate.
  4. Then produce ONLY the final JSON.

Output FORMAT (no markdown fences, no comments):
{"facts":[...], "entities":[...], "relations":[...]}
```

Затем `stripThinkingBlock()` срезает `<think>...</think>` перед парсингом.

## F-CoT для коротких chunks

Если chunk < 200 токенов — full CoT слишком дорог.
Используем **Focused Chain-of-Thought**: одна короткая reasoning-фраза
вместо полной цепочки.

```
Think briefly: list entities, then relations, then JSON.
```

## Антипаттерны

❌ **Над-извлечение**: модель копирует ВСЕ слова в `entities` (включая «and»,
   «the», «is»). Решение: фильтр по длине ≥2 + блок-лист стоп-слов.

❌ **Дубли**: одна и та же сущность в трёх формах («NASA», «N.A.S.A.»,
   «National Aeronautics»). Решение: post-process нормализация —
   keep canonical form, аннотируй варианты как aliases.

❌ **Слишком общие relations**: `(X, "is", Y)` — бесполезно.
   Решение: запрещаем predicate length < 3 chars или `is/was/has`
   без квалификатора.

❌ **Пропуск causal chains**: «X произошло потому что Y» вытаскивается
   только как два отдельных факта без связи. Решение: явная просьба
   в prompt искать `cause`, `because`, `due to`, `enabled`, `prevented`.

## Проверка качества (scorer-логика)

Scorer для `crystallizer-deep-extract` начисляет:
- 0.10 за валидную базовую структуру;
- до 0.50 за **факт-якоря** (17 ключевых сигналов источника);
- до 0.15 за **топологические relations**;
- до 0.15 за extraction completeness (≥8 facts);
- штраф −0.20 за галлюцинации (Apollo 12, не упомянутые годы).

**Идеальный результат: 0.95-1.00 → топология полностью восстановлена.**

## Минимальный размер модели

- Для коротких chunks (<300 токенов) — **3B+ thinking** или **7B без thinking**.
- Для средних chunks (300-800) — **7B+ thinking** обязательно.
- Для длинных chunks (>800) — **14B+ thinking**, иначе context bleed.

В нашем проекте delta-extractor работает на 7-14B reasoning моделях
(Qwen3-7B-Instruct, Qwen3-14B-Thinking, GLM-4.7-Air-Reasoning).

## Связь с Олимпиадой

- `crystallizer-rover` — короткий chunk (4 факта), проверяет базу.
- `crystallizer-ru-mendeleev` — кириллица, 4 факта.
- `crystallizer-deep-extract` — длинный chunk (15+ фактов, relations,
  causal chains). Помечен `thinkingFriendly: true` — efficiency не
  делится на время. Это РЕАЛЬНЫЙ benchmark для production моделей.
