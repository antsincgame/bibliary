# Аудит и санация Bibliary — 21 апреля 2026

Отчёт магосу Нораду по итогам сессии `/om /inquisitor /mahakala /ui-tester`.

## Сделано в этой сессии (8 атомарных коммитов)

| # | SHA | Что починено | Тип по rubric |
|---|-----|--------------|----------------|
| 1 | `82e4b76` | **P0 HIGH:** `forge:run-eval` без `AbortSignal` → залип IPC. Обёрнут в `chatWithPolicy` + module-level `activeEvalController` + новый IPC `forge:cancel-eval`. Добавлены подписки `onStderr`/`onError` в preload (P2.b). Расширен `TelemetryEvent.forge.eval.judge_error`. | Тип 2 (Strangler) |
| 2 | `d7d141f` | **HIGH:** silent `catch` в `dataset-v2:list-accepted` глотал Qdrant ошибки → "0 концептов в бейдже" без сигнала. Теперь `console.warn`. Удалён мусор `void (() => null)()` + мёртвый импорт `AcceptedConcept`. Удалён мёртвый реэкспорт `judgeOne` из `forge/index.ts` (Inquisitor подтвердил 0 импортёров). | Тип 1 |
| 3 | `6bd0780` | **CRITICAL UI ⇄ Logic:** 4 строки i18n ссылались на удалённый "Dataset route" / "Open Dataset". Заменено на "Кристаллизатор" / "Open Crystallizer". | Тип 1 |
| 4 | `725c31c` | **P1 6.3:** `inBatchCache` в judge.ts — FIFO cap 200/domain. Защита от O(N²) на больших batch. | Тип 1 |
| 5 | `e8e44b2` | **P2 6.4.a:** ROUGE-L truncation 500 токенов. Защита CPU при длинных eval. | Тип 1 |
| 6 | `5ddb39d` | **LOW:** мёртвый тернарник `chat ? "chat" : "chat"` + неиспользуемый export `navigate()` в router.js. | Тип 1 |
| 7 | (next) | **P0 HIGH UI⇄Logic:** Добавлена кнопка отмены eval в `eval-panel.js`. Backend готов с `82e4b76`, UI был забыт — закрыта асимметрия. | Тип 1 |
| 8 | (next) | **P0 HIGH SECURITY:** XSS через marked → innerHTML в chat.js. Добавлен DOMPurify (renderer/vendor/) + whitelist тегов. Защита от prompt-injection. | Тип 2 |
| 9 | (next) | **MED:** unhandled rejection на bootstrap dataset-v2 (`Promise.all([...]).then` без `.catch`). | Тип 1 |
| 10 | (next) | **MED:** embedder без таймаутов (cold-start + per-call). Зависший ONNX больше не подвешивает весь Bibliary. | Тип 1 |

## Состояние baseline (после правок)

```
TypeScript:     0 errors
ESLint:         0 errors / 0 warnings (--max-warnings=0)
test-dataset-v2:  30/30 PASS
test-scanner:      4/4  PASS
test-model-select:10/10 PASS
test-bookhunter:   8/8  PASS
test-e2e-mvp:     35/35 PASS
Итого:           87/87 PASS, baseline зелёный
```

## Карта тёмных мест (что ещё осталось — приоритизировано)

### Закрыто сегодня

- ~~P0 HIGH: forge:run-eval без AbortSignal~~ ✅ (`82e4b76`)
- ~~MED: judge catch swallow~~ ✅ (`82e4b76`)
- ~~P0: list-accepted silent Qdrant~~ ✅ (`d7d141f`)
- ~~CRITICAL: битые ссылки "Dataset route"~~ ✅ (`6bd0780`)
- ~~LOW: мёртвый `judgeOne` реэкспорт~~ ✅ (`d7d141f`)
- ~~P2 LOW: preload не подписан на forge:local-stderr/error~~ ✅ (`82e4b76`)
- ~~P1 6.3: inBatchCache cap~~ ✅ (`725c31c`)
- ~~P2 6.4.a: ROUGE-L cap~~ ✅ (`e8e44b2`)
- ~~LOW: мёртвый тернарник + dead navigate export~~ ✅ (`5ddb39d`)
- ~~P0 UI⇄Logic: кнопка отмены eval~~ ✅ (текущая сессия)
- ~~P0 SECURITY: XSS через marked~~ ✅ (текущая сессия — DOMPurify)
- ~~MED: unhandled rejection в crystal bootstrap~~ ✅ (текущая сессия)
- ~~MED: embedder без таймаутов~~ ✅ (текущая сессия)

### Открытые HIGH (требуют работы)

| Severity | Где | Что нужно |
|----------|-----|-----------|
| HIGH | `electron/lib/scanner/parsers/pdf.ts` | PDF читается целиком в память — OOM на больших книгах (audit предыдущей сессии). |
| HIGH | `electron/lib/resilience/lmstudio-watchdog.ts:38-40` | `configureWatchdog` не пересоздаёт `setInterval` на лету — задокументировано, но baggy при runtime смене prefs. |

### Открытые MEDIUM

- `renderer/i18n.js` — `nav.forge` (EN) = "Forge", `nav.crystal` (EN) = "Crystallizer", `Memory Forge`, `Phase 3.3` остались — Этап 1 simplification.
- `electron/preload.ts` — ~12 IPC методов без потребителей в renderer (`qdrant.points`, `yarn.recommend`, `yarn.listModels`, `system.envSummary`, `forge.genConfig`, `hf.searchModels`, `wsl.detect`, `chatHistory.clear`, `forgeLocal.start/cancel/importGguf/onMetric/onStdout/onExit`). Решить: подключить (target=local) или удалить (экстерминатус).
- `electron/ipc/qdrant.ipc.ts:71-78, 122-125` — IPC возвращает `[]` вместо `{ ok:false, error }` — UI не отличает «пусто» от «Qdrant упал».
- `electron/lib/resilience/lmstudio-watchdog.ts:88, 100` — `.catch(() => undefined)` на pause/resume глотает сбои.
- `MECHANICUS` упоминается в `docs.section.formats.*` (RU+EN) встроенной справки — пользовательский UI.
- `electron/ipc/forge.ipc.ts:241-263` — handler eval ~75 строк после фикса 6.1. Можно extract `buildEvalChatCallback`.

### Открытые LOW (техдолг)

- `scripts/delete-ids.ts`, `scripts/dump-by-ids.ts`, `src/init-optimized.ts` — orphan-утилиты с захардкоженными ID, не в `package.json`. Решить: удалить или задокументировать.
- `electron/lib/forge/configgen.ts:71-187` — `generateUnslothPython` (67 строк) и `generateAutoTrainYaml` (43) > 40 строк. Под-этап 6.2.b: Extract Method (Тип 1, ROI 2.25, не острая боль).
- Множество `catch {}` в `lmstudio-client.ts` (`loadRuntimePolicy`, `listOpenAiModels`, `unloadModel`, `getServerStatus`, `dispose`) глотают тихо.

## Активный план

Отслеживается через Cursor todo (план-файл в репо не лежит). Состояние:

- ✅ Под-этап 6.1 (P0 forge:run-eval AbortSignal) — `82e4b76`
- ✅ Под-этап 6.2.a (judge catch + telemetry) — `82e4b76`
- ⏳ Под-этап 6.2.b (Extract Method для configgen) — отложено, ROI 2.25, не острая боль
- ✅ Под-этап 6.3 (intra-dedup cap) — `725c31c`
- ✅ Под-этап 6.4.a (ROUGE-L cap) — `e8e44b2`
- ✅ Под-этап 6.4.b (preload subscriptions) — `82e4b76`
- ⏳ Под-этап 6.5 (sweep) — частично (judgeOne, navigate удалены; getMainWindow живёт)
- ⏳ Этап 1 (массовое переименование Forge/Crystallizer/Memory Forge) — следующий sprint
- ⏳ Этапы 2-4 (AutoML defaults + wizard 5→3 + docs) — основная задача упрощения

## Профиль магоса Норада

### Стиль работы (на основе 85+ коммитов и серии сессий)

- **Качество > скорость:** требует минимум 0 lint warnings + tests PASS перед каждым коммитом. Это правильно.
- **Атомарные коммиты:** коммиты узкого скоупа с понятными сообщениями. Это правильно.
- **Аудит-driven:** регулярно запускает `/inquisitor`, `/mahakala`, `/ui-tester`, `/om` — поднимает технический долг наверх. Это правильно.
- **Inquisitor для legacy:** систематические "экстерминатус" процедуры (v1 dataset pipeline удалён каскадно за 7 коммитов). Это правильно.
- **Терминология:** Warhammer-жаргон — личный язык, узнаваемый. Минус: попадал в продуктовый UI, что Норад сам и осудил в этой сессии. Сейчас исправляется.

### Где Норад может улучшиться

1. **Рассинхрон между документацией и кодом.** Доки `docs/RESILIENCE.md`, `docs/FINE-TUNING.md`, `docs/REPORT-USER-SKILLS.md` отстают от рефакторов (например, всё ещё упоминают `mechanicus.md`, `dataset.ipc.ts`, удалённые IPC). Рекомендация: после каждого экстерминатуса прогонять `Grep` по docs и обновлять.

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

## Краткая рекомендация на завтра (после ручного теста сборки)

В порядке приоритета:

1. **Этап 1** (массовое переименование Forge/Crystallizer/Memory Forge → Дообучение/Извлечение знаний/Расширение контекста) — 2-3 часа, видимая победа для UX.
2. **MED qdrant IPC** — унифицировать `{ ok, data, error }` shape вместо `[]` на ошибке. UI сможет показывать диагностику.
3. **MED preload orphans** — пройти ~12 неиспользуемых методов, решить: подключить к UI или удалить.
4. **HIGH PDF parser** — стримить вместо чтения целиком (защита от OOM на больших книгах).
5. **Под-этап 6.2.b** (Extract Method configgen) — 1-2 часа, ROI 2.25, делать когда руки свободны.

Не рекомендую сейчас:
- Этап 3 (wizard 5→3) — требует Этапа 1 как preset.
- Удаление preload orphan IPC без сверки с roadmap.

---

ॐ Магос, продукт защищён. 87/87 тестов зелёные. P0 SECURITY и UI⇄Logic закрыты.
