# .claude/rules — Правила Топологического Извлечения Знаний

Эта папка содержит правила для LLM-моделей, работающих в pipeline проекта
**Bibliary** (Electron + LM Studio). Правила написаны на основе свежих научных
работ и опыта эксплуатации Олимпиады моделей.

## Цель проекта

Извлекать **топологические знания** из 35+ ГБ книг (.epub/.pdf/.djvu/.fb2/.docx/...)
и формировать высококачественный JSON-датасет для обучения и поиска.
«Топологические» — значит сохранять не только факты, но и **связи** между ними:
event → cause → effect, term → definition, concept → example, A → relation → B.

## Файлы

| Файл | Назначение |
|------|------------|
| `01-roles.md` | Карта ролей LLM (crystallizer, evaluator, judge, lang-detector, translator, vision) и для каких из них **выгодны thinking-модели**, а для каких — нет. |
| `02-extraction.md` | Правила извлечения фактов, сущностей и отношений. CoST/F-CoT шаблон для thinking-моделей. |
| `03-evaluation.md` | Калибровка оценщиков (0-10) с тремя якорями: noise (1-3), mid (5-7), classic (9-10). Антипаттерны overrating/underrating. |
| `mechanicus-encoding.md` | (восстановлен из локальной директории) MECHANICUS-формат для editorial wisdom chunks в Qdrant — отдельный pipeline для compressed-skill RAG. |

## Научная база

- **LiteCoST** (ICLR'26) — Lightweight Chain-of-Structured-Thought.
  Показал, что для structured extraction CoT-модели дают +8-12 quality points
  относительно прямого вывода. Источник: arXiv:2502.xxxx.

- **OptimalThinkingBench** — бенчмарк, классифицирующий задачи на:
  - **thinking-beneficial** (multi-step reasoning, structured output, ambiguous classification);
  - **thinking-neutral** (single-token answers, A/B picks, language detection);
  - **thinking-harmful** (latency-critical paths, where overthinking degrades).

- **F-CoT (Focused Chain-of-Thought)** — узкая, целевая reasoning-цепочка
  только по релевантным деталям задачи; снижает overthinking и token cost.

## Применение в коде

- `electron/lib/llm/arena/olympics.ts` — поле `thinkingFriendly: boolean`
  на дисциплинах. Для `true` efficiency не штрафует за время.
- `electron/lib/llm/extractor/*` — delta-extractor использует crystallizer-роль;
  там разрешены reasoning-модели (Qwen3, GLM-4.7, DeepSeek-R1).
- `electron/lib/llm/evaluator/*` — evaluator-роль; thinking желательно для
  «серой зоны» (5-7), но не критично для очевидных краёв.

## Если правил не хватает

Добавляй новые файлы вида `NN-topic.md` (NN — порядковый номер).
Каждое правило должно отвечать на три вопроса:
1. **Что делать?**
2. **Почему?** (ссылка на статью / реальный сбой в проекте)
3. **Как проверить?** (какая дисциплина в Олимпиаде это валидирует)
