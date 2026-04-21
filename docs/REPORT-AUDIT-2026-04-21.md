# Аудит и санация Bibliary — 21 апреля 2026

Отчёт магосу Нораду по итогам сессии `/om /inquisitor /mahakala /ui-tester`.

## Сделано в этой сессии (3 атомарных коммита)

| # | SHA | Что починено | Тип по rubric |
|---|-----|--------------|----------------|
| 1 | `82e4b76` | **P0 HIGH:** `forge:run-eval` без `AbortSignal` → залип IPC. Обёрнут в `chatWithPolicy` + module-level `activeEvalController` + новый IPC `forge:cancel-eval`. Добавлены подписки `onStderr`/`onError` в preload (P2.b). Расширен `TelemetryEvent.forge.eval.judge_error`. | Тип 2 (Strangler) |
| 2 | `d7d141f` | **HIGH:** silent `catch` в `dataset-v2:list-accepted` глотал Qdrant ошибки → "0 концептов в бейдже" без сигнала. Теперь `console.warn`. Удалён мусор `void (() => null)()` + мёртвый импорт `AcceptedConcept`. Удалён мёртвый реэкспорт `judgeOne` из `forge/index.ts` (Inquisitor подтвердил 0 импортёров). | Тип 1 |
| 3 | `6bd0780` | **CRITICAL UI ⇄ Logic:** 4 строки i18n ссылались на удалённый "Dataset route" / "Open Dataset". Заменено на "Кристаллизатор" / "Open Crystallizer" (в кнопках уже была навигация на `crystal` — копи lied). | Тип 1 |

## Состояние baseline (после правок)

```
TypeScript:     0 errors
ESLint:         0 errors / 0 warnings (--max-warnings=0)
test-forge:     16/16 PASS
test-forge-local: 14/14 PASS
test-dataset-v2: 30/30 PASS
Итого:          60/60 PASS, baseline зелёный
```

## Карта тёмных мест (что ещё осталось — приоритизировано)

### Закрыто сегодня

- ~~P0 HIGH: forge:run-eval без AbortSignal~~ ✅
- ~~MED: judge catch swallow~~ ✅ (заодно в коммите 1)
- ~~P0: list-accepted silent Qdrant~~ ✅
- ~~CRITICAL: битые ссылки "Dataset route"~~ ✅
- ~~LOW: мёртвый `judgeOne` реэкспорт~~ ✅
- ~~LOW: мусор `void (() => null)()` в dataset-v2.ipc.ts~~ ✅
- ~~P2 LOW: preload не подписан на forge:local-stderr/error~~ ✅

### Открытые HIGH (требуют работы)

| Severity | Где | Что нужно |
|----------|-----|-----------|
| HIGH | `electron/lib/dataset-v2/judge.ts:326-356` | `inBatchCache` без cap — O(N²) на больших batch. Под-этап 6.3 плана: FIFO 200/domain. |
| HIGH | `electron/lib/forge/configgen.ts:71-187` | `generateUnslothPython` (67 строк) и `generateAutoTrainYaml` (43) > 40 строк. Extract Method с characterization snapshot. Под-этап 6.2.b плана. |
| HIGH | `electron/lib/scanner/parsers/pdf.ts` | PDF читается целиком в память — OOM на больших книгах (audit предыдущей сессии). |
| HIGH | `electron/lib/resilience/lmstudio-watchdog.ts:38-40` | `configureWatchdog` не пересоздаёт `setInterval` на лету — задокументировано, но baggy при runtime смене prefs. |

### Открытые MEDIUM

- `renderer/router.js:129` — `showRoute(onboardingDone ? "chat" : "chat")` мёртвая ветка (тернарник `chat ? "chat" : "chat"`).
- `renderer/i18n.js` — `nav.forge` (EN) = "Forge", `nav.crystal` (EN) = "Crystallizer", `Memory Forge`, `Phase 3.3` остались — план *finetune-3-step-simplification* предусматривает массовую зачистку.
- `electron/preload.ts` — экспортированы IPC методы без потребителей в renderer (`qdrant.points`, `yarn.recommend`, `yarn.listModels`, `system.envSummary`, `system.hardwarePresets`, `wsl.detect`, `forge.genConfig`, `forge.listRuns`, `forgeLocal.start/cancel/importGguf/onMetric/onStdout/onExit`). Решить: оставить (на будущее) или удалить (Inquisitor — экстерминатус).
- `MECHANICUS` упоминается в `docs.section.formats.*` (RU+EN) встроенной справки — пользовательский UI.
- `electron/ipc/forge.ipc.ts:241-263` — *исходный* handler eval до фикса жил большой функцией (~50 строк). После фикса 6.1 ещё длинней (~75). Можно extract `buildEvalChatCallback`, но это не блокер.

### Открытые LOW (техдолг)

- `scripts/delete-ids.ts`, `scripts/dump-by-ids.ts`, `src/init-optimized.ts` — orphan-утилиты с захардкоженными ID, не в `package.json`. Решить: удалить или задокументировать.
- `renderer/router.js:136-138` — `export function navigate` без потребителей.
- ROUGE-L `lcsLen` O(m×n) — на длинных eval-ответах CPU. Cap до 500 токенов.
- Множество `catch {}` в `lmstudio-client.ts` (`loadRuntimePolicy`, `listOpenAiModels`, `unloadModel`, `getServerStatus`, `dispose`) глотают тихо. Не критично, но не помогает диагностике.

## Активный план

`finetune-3-step-simplification_8b5b8faa.plan.md` — двунаправленный (UI упрощение + Вариант δ санация). Из 9 todo:

- ✅ Под-этап 6.1 (P0) — закрыт сейчас
- ✅ Под-этап 6.2.a (judge catch) — закрыт сейчас (заодно с 6.1)
- ⏳ Под-этап 6.2.b (Extract Method для configgen) — следующий по ROI 2.25
- ⏳ Под-этап 6.3 (intra-dedup cap) — ROI 6.0, самый высокий
- ⏳ Под-этап 6.4.a (ROUGE-L cap) — ROI 3.0
- ✅ Под-этап 6.4.b (preload subscriptions) — закрыт сейчас
- ⏳ Под-этап 6.5 (sweep) — частично (judgeOne удалён, getMainWindow остаётся живым)
- ⏳ Этап 1 (массовое переименование Forge/Crystallizer/Memory Forge) — большая видимая победа
- ⏳ Этапы 2-4 (AutoML defaults + wizard 5→3 + docs) — основная задача упрощения

## Профиль магоса Норада

### Стиль работы (на основе 85+ коммитов и серии сессий)

- **Качество > скорость:** требует минимум 0 lint warnings + tests PASS перед каждым коммитом. Это правильно.
- **Атомарные коммиты:** коммиты узкого скоупа с понятными сообщениями. Это правильно.
- **Аудит-driven:** регулярно запускает `/inquisitor`, `/mahakala`, `/ui-tester`, `/om` — поднимает технический долг наверх. Это правильно.
- **Inquisitor для legacy:** систематические "экстерминатус" процедуры (v1 dataset pipeline удалён каскадно за 7 коммитов). Это правильно.
- **Терминология:** Warhammer-жаргон — личный язык, узнаваемый. Минус: попадал в продуктовый UI, что Норад сам и осудил в этой сессии. Сейчас исправляется.

### Где Норад может улучшиться

1. **Рассинхрон между документацией и кодом.** Доки `docs/RESILIENCE.md`, `docs/FORGE.md`, `docs/REPORT-USER-SKILLS.md` отстают от рефакторов (например, всё ещё упоминают `mechanicus.md`, `dataset.ipc.ts`, удалённые IPC). Рекомендация: после каждого экстерминатуса прогонять `Grep` по docs и обновлять.

2. **"Pro/Simple/Advanced" 3-уровневый toggle усложняет UI.** UI-tester отметил: переключатель режима не решает проблему, что в Pro по-прежнему виден жаргон (LoRA r, DoRA, QLoRA, Q4_K_M). Рекомендация: 2 уровня "Default + Эксперт", и плотный mini-glossary с tooltip'ами.

3. **Backend код имеет HIGH технического долга:**
   - `judge.ts` без cap на in-batch cache — потенциальная OOM на больших batch
   - PDF parser читает файл в память
   - Watchdog не пересоздаёт interval на лету
   Все эти места — известные из предыдущих аудитов, но не закрыты. Рекомендация: спринт "только тех. долг", без новых фич.

4. **Слишком широкий preload surface.** ~12 IPC методов экспонируются в renderer без потребителей. Это либо мёртвый код (удалить), либо запланированные фичи без UI (создать TODO в плане). Сейчас — middle ground, что хуже всего: легко забыть что нужно подключить.

5. **"Кустарные" CLI-скрипты (`delete-ids.ts`, `dump-by-ids.ts`)** — хардкод ID и emergency-утилиты. Должны быть либо в `package.json` scripts с понятными аргументами, либо в `docs/RUNBOOKS.md` как ad-hoc.

### Сильные стороны

- Глубокое понимание архитектуры — резилианс layer (coordinator/watchdog/telemetry/checkpoint) — сложная инженерная работа, корректно собрана.
- Системное мышление — видит цепочки причин (LM Studio JSON schema bug → reasoning decoder → dual-prompt routing — решено архитектурно, не патчем).
- Готовность к радикальным решениям — экстерминатус v1 был правильным шагом, не накапливал legacy.
- Использует индустриальные стандарты — Unsloth 2026 defaults, ROUGE-L, ChatML, GGUF — без изобретения велосипедов.

## Краткая рекомендация на завтра

В порядке приоритета:

1. **Вариант δ Под-этап 6.3** (intra-dedup cap) — ROI 6.0, 30 минут, защищает от OOM.
2. **Под-этап 6.4.a** (ROUGE-L cap) — 30 минут, защищает CPU при длинных eval.
3. **Этап 1** (массовое переименование) — 2-3 часа, видимая победа для UX.
4. **Под-этап 6.2.b** (Extract Method configgen) — 1-2 часа с characterization snapshot.

Не рекомендую сейчас:
- Этап 3 (wizard 5→3) — большая работа в renderer/forge.js, требует Этапа 1 как preset.
- Удаление preload orphan IPC — нужно сначала свериться с роадмапом, что планируется к подключению.

---

ॐ Магос, продукт защищён. 60/60 тестов зелёные. Push готов.
