# QUALITY GATES — Bibliary

> Контрольные точки проекта. Перед каждым merge / RC / release сверяемся
> с этим документом. "Зелёный" результат = можно двигать дальше; "красный"
> -- блокирует.
>
> Применяем rubric: один тип gate -- один уровень безопасности (Type 1 / Type 2 / Type 3).

## Gate 0 -- Pre-commit (локально, каждый коммит)

Type 1, обязательно. Время прохождения: <30 сек.

```
□ npx tsc -p tsconfig.electron.json --noEmit       (exit 0)
□ npm run lint                                      (exit 0)
□ ReadLints для всех изменённых файлов              (no errors)
□ Нет .git-commit-msg.txt в индексе
□ Нет console.log в electron/* (warn/error -- OK)
□ Нет TODO/FIXME без явного тикета
□ Нет hardcoded localhost вне const с комментарием
```

Auto-detect (рекомендация на будущее): pre-commit hook через `husky` +
скрипт `scripts/precommit.ps1`.

## Gate 1 -- Pre-push (перед `git push`)

Type 1+2, обязательно. Время: <2 мин.

```
□ Gate 0 пройден
□ npm run test:scanner                              (smoke, без LM Studio)
□ npm run test:dataset-v2                           (smoke с фикстурами)
□ git status -- working tree clean
□ Сообщения коммитов: prefix(scope): summary
□ Каждый коммит атомарный (один тип изменений)
```

## Gate 2 -- Pre-PR / merge (перед интеграцией в main)

Type 2, обязательно. Время: <10 мин.

```
□ Gate 1 пройден
□ Если изменился PreferencesSchema (55 ключей) -- проверить backward compat:
  data/preferences.json от прошлой версии не падает при load
□ Если добавлен новый preference key -- открыть в renderer/settings/sections.js
  ИЛИ явно пометить «internal» комментарием в PreferencesSchema
□ Если изменился UI -- проверить что нет dead handlers (кнопок без обработчиков)
□ Diff для CHANGELOG.md (если user-facing change)
□ Refactor-rubric checklist (что Type, какой ROI)
```

## Gate 3 -- Pre-release (RC билд)

Type 2+3, обязательно. Время: <30 мин.

```
□ Gate 2 пройден
□ npm run test:smoke                                (Electron UI E2E, playwright)
□ npm run test:e2e:scanner                          (живой Qdrant)
□ npm run test:e2e:library-ux                       (живой Qdrant)
□ npm run test:e2e:full-corpus                      (реальный корпус книг)
□ npm run test:e2e:bookhunter                       (живая сеть)
□ npm run test:agent-live                           (живой LM Studio)
□ npm run electron:build-portable                   (.exe Windows portable)
□ Smoke install test на чистой OS Windows 10+
□ OCR прогон на 1 scanned PDF (Windows.Media.Ocr)
□ docs/ROADMAP-TO-MVP.md -- P0 пункты закрыты
```

## Gate 4 -- Production release

Type 3, обязательно. Время: <2 часа.

```
□ Gate 3 пройден
□ Tag v0.X.Y-rc{n} создан + push --tags
□ GitHub Release с changelog + бинарями
□ EAS Update / OTA channel настроен (опц.)
□ Telemetry опт-ин баннер в первой run
□ README первой страницы обновлён
□ Sentry / log aggregator подключен (опц.)
```

---

## Контрольные точки прогресса (внутренние, не блокирующие)

Эти числа отслеживаются для понимания, где мы относительно MVP. Обновляются
после каждого "феaturecommit". Не "должны быть зелёными" -- это компас, не
светофор.

### Wired preferences ratio

```
Итого ключей в PreferencesSchema: 55
Открыто в Settings UI:           41 (74%)
Внутренних/wizard:               14 (26%) — chatModel, agentModel, extractorModel,
                                            judgeModel, chatHistoryCap, chatHistoryPersist,
                                            onboardingDone, onboardingVersion, seenRebrandV2,
                                            libraryGroupBy, visionModelKey, visionMetaEnabled,
                                            ingestUpsertBatch, maxBookChars

P1-задача: добавить visionModelKey/visionMetaEnabled в UI Settings → OCR секция.
```

### Test coverage by route

```
Library          smoke ✓  e2e ✓
Chat             smoke ✗  e2e ✗   (требует LM Studio)
Qdrant UI        smoke ✗  e2e ✗
Crystallizer     smoke ✓  e2e ✓
Forge            smoke ✗  e2e ✗   (требует WSL + GPU)
Forge Agent      smoke ✗  e2e ✗
Settings         smoke ✗  e2e ✗
Models           smoke ✗  e2e ✗
Docs             smoke ✗  e2e -   (статика)
```

P1 пункт roadmap: написать smoke тесты для Chat / Qdrant / Settings.

### Файлы > 400 строк (Type 2 кандидаты на split)

```
(актуальный список — запустить: git ls-files | xargs wc -l | sort -rn | head -20)
Ориентировочные кандидаты: renderer/forge.js, renderer/dataset-v2.js,
electron/lib/forge/configgen.ts, renderer/components/context-slider.js
```

ROI этого split < 2.0 пока нет тестов покрывающих UI behaviour.
План: сначала Electron E2E smoke (P2.6), потом split.

### Hot-path функции > 50 строк

```
(актуальный список — запустить: grep -n "^function\|^async function\|^export function" electron/**/*.ts | awk -F: '{print $2}' | sort)
Известные hotspots: buildContextSlider (context-slider.js), runAgentLoop (agent/loop.ts)
```

Не блокирующее. Type 2 refactor candidates на P2/P3.

---

## Refactor-rubric quick-reference

```
ROI = (Pain × 3) / (Cost × 2)

ROI > 2.0   → делать сейчас
1.0..2.0    → планировать на следующий спринт
< 1.0       → отложить
```

| Тип | Когда | Тесты | Безопасность |
|---|---|---|---|
| Type 1 | Renames, extract const, dead code, lint | Не нужны | Тесты не должны меняться |
| Type 2 | Split god-class, extract layer, replace pattern | Нужны до начала | Адаптация тестов ожидается |
| Type 3 | Split monolith, swap library, change API | Нужны + plan | Migration path + rollback |

Текущий проект в **Type 1 режиме**. Type 2 (split крупных renderer-файлов)
планируется после написания полноценных UI-level E2E тестов.
