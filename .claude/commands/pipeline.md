---
description: Навигатор по generation pipeline — agents / stages / postprocess / prompts
argument-hint: "[фаза или запрос]"
---

# /pipeline — Навигация по пайплайну

Помоги ориентироваться в pipeline генерации. Знаешь архитектуру по слоям.

## Архитектура (общая для генеративных проектов)

```
spec → planner → schema (JSON)
schema → setup → generate (coder) → review
                          ↓
              postprocess → lint → fix cycle → build
```

## Слои

| Слой | Папка | Ответственность |
|------|-------|----------------|
| Agents | `agents/`, `electron/lib/llm/` | LLM-роли: planner, coder, reviewer, fixer, crystallizer |
| Stages | `stages/` | Оркестрация фаз генерации |
| Postprocess | `postprocess/` | Детерминированные правки (typecheck-fix, import-sort) |
| Pipeline core | `pipeline_*.ts`, `pipeline_*.py` | Координация, состояние, retry-логика |
| LLM layer | `llm_*.ts`, `electron/lib/llm/` | Клиент, retry, streaming, fallback chain |
| Prompts | `prompts/`, `.claude/rules/` | Markdown-промпты и правила ролей |

## Для Bibliary конкретно

Карта ключевых файлов (по `.claude/rules/01-roles.md`):

- `electron/lib/llm/model-role-resolver.ts` — резолвер ролей
- `electron/lib/llm/with-model-fallback.ts` — fallback chain
- `electron/lib/llm/model-role-resolver-internals.ts` — тип `ModelRole`
- `dataset-v2/delta-extractor.ts` — crystallizer
- `dataset-v2/extraction-runner.ts` — language router (украинский)
- `library/book-evaluator.ts` — evaluator
- `library/md-converter.ts` — vision_meta + text-meta fallback
- `scanner/ocr/index.ts` — vision_ocr
- `library/illustration-worker.ts` — vision_illustration
- `library/layout-assistant.ts` — layout_assistant
- `llm/lang-detector.ts` — lang_detector

## Workflow при запросе

1. Определи о какой фазе речь: спецификация, генерация, постобработка, ревью
2. Покажи соответствующий слой со ссылками `file:line`
3. Если нужно — построй mini-диаграмму как данные перетекают через пайплайн
4. Если задача на правку — укажи **где именно** в пайплайне правка должна жить

Запрос: $ARGUMENTS
