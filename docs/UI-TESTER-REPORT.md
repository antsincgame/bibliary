# UI-TESTER REPORT — Bibliary v2.5.4

> **АРХИВНЫЙ СНИМОК НА 2026-04-21.** Этот отчёт фиксирует состояние UI
> ДО v2.4 self-hosted рефактора и v2.5+ wizard / chat / docs обновлений.
> Конкретно устарели:
> - `forge.target.local.disabled_hint` и весь блок про Forge target picker
>   — таргет-шаг удалён в v2.4 (Forge теперь self-hosted only, 3 шага).
> - Welcome wizard (4 шага: Hero/Connect/Setup/Done) и его действия
>   на финальном экране (3 action-карточки) — реализованы позже.
> - Chat: `+`-кнопка коллекции, авто-загрузка downloaded модели,
>   welcome-message от ассистента — добавлены позже.
>
> Скилл `/ui-tester` -- статический инспектор интерактивных элементов.
> Дата отчёта: 2026-04-21 (revision 3 после Phase 2.5R wiring + diamond cleanup).
>
> Изменения с rev2:
> - +5 preference keys (lockRetries, lockStaleMs, healthPollIntervalMs,
>   healthFailThreshold, watchdogLivenessTimeoutMs) -- все wired в runtime
> - -1 dead export (`isImageBookExt` удалён из renderer/library.js)
> - 3 BAD swallowed catches заменены на console.error диагностику

## 1. Покрытие

| Маршрут          | Файл                               | Интер. эл-в | Обработчиков | Status |
|------------------|------------------------------------|-------------|--------------|--------|
| Library          | `renderer/library.js`              | 17          | 17           | OK     |
| Settings         | `renderer/settings.js`             | 8 (типов)   | 8            | OK     |
| Chat             | `renderer/chat.js`                 | 6           | 6            | OK     |
| Qdrant           | `renderer/qdrant.js`               | 9           | 9            | OK     |
| Crystal          | `renderer/dataset-v2.js`           | 11          | 11           | OK     |
| Forge            | `renderer/forge.js`                | 9           | 9            | OK     |
| Forge Agent      | `renderer/forge-agent.js`          | 6           | 6            | OK     |
| Models           | `renderer/models/*.js`             | 13          | 13           | OK     |
| Dataset (legacy) | `renderer/dataset.js`              | 14          | 14           | OK     |
| Docs             | `renderer/docs.js`                 | 3           | 3            | OK     |
| Resilience bar   | `renderer/components/*.js`         | 0 (passive) | --           | OK     |

Всего интерактивных элементов: **~96** (кнопки, чекбоксы, селекты, ссылки, dropzone).

## 2. Реестр критических находок

### A. Функции без UI (мёртвая логика)

`isImageBookExt(ext)` экспортирована из `renderer/library.js`, но потребителей нет.
**Решение:** оставлена как часть public API модуля для будущей фильтрации
(grouping by ext уже использует обычное `b.ext`). Готова к подключению при
расширении группировки. Если в Phase 6.1 не понадобится -- удалить.

### B. UI без функций (мёртвый UI)

Не найдено.

### C. Парная асимметрия

| Action                     | UI                                         | Status |
|----------------------------|--------------------------------------------|--------|
| `enqueueAndStart`          | "Add to Qdrant" + dropzone + per-task      | OK     |
| `cancelAll`                | "Stop all" в toolbar                       | OK     |
| `deleteFromCollection`     | row-level "Delete from collection"         | OK     |
| `addItem` (qdrant create)  | "Create collection" в Qdrant UI            | OK     |
| `removeItem` (qdrant del)  | "Delete collection" в Qdrant UI            | OK     |
| `bookhunter.search`        | tab "Search books"                         | OK     |
| `bookhunter.downloadAndIngest` | "Download & Ingest" в карточке         | OK     |
| `preferences.set/reset`    | Settings save/reset btns                   | OK     |
| `scanner.openFiles`        | "Pick files" + клик по dropzone            | OK     |
| `scanner.probeFiles`       | drop event на dropzone                     | OK     |
| `scanner.ocrSupport`       | OCR badge в toolbar + per-task toggle      | OK     |

### D. Подозрительные обработчики

Не найдено пустых `() => {}`, `() => null`, `console.log`-only, `Alert.alert("Coming soon")`.

`renderer/router.js:127` -- `console.warn("[router] i18n is not initialised")` -- legitimate
diagnostic для случая когда модуль вызван до bootstrap; не мёртвая логика.

`forge.target.local.disabled_hint` "Phase 3.3 -- not yet available" -- помечает явно
disabled feature, кнопка `disabled`. Не мёртвый UI.

## 3. Навигационные маршруты

| Путь                  | Цель                                              | Status |
|-----------------------|---------------------------------------------------|--------|
| `library`             | `mountLibrary` → `route-library`                  | OK     |
| `chat`                | `mountChat` → `route-chat`                        | OK     |
| `qdrant`              | `mountQdrant` → `route-qdrant`                    | OK     |
| `crystal`             | `mountCrystal` → `route-crystal`                  | OK     |
| `forge`               | `mountForge` → `route-forge`                      | OK     |
| `forge-agent`         | `mountForgeAgent` → `route-forge-agent`           | OK     |
| `models`              | `mountModels` → `route-models`                    | OK     |
| `dataset`             | `mountDataset` → `route-dataset`                  | OK     |
| `docs`                | `mountDocs` → `route-docs`                        | OK     |
| `settings`            | `mountSettings` → `route-settings`                | OK     |

## 4. Store / Preferences интеграция (точная сверка)

Полный набор -- **39 ключей** (rev3 добавил 5 resilience-ключей).
Wired в runtime после revision 3 -- **38 / 39**:

| # | Key                          | Wired into                                                  | Status |
|---|------------------------------|-------------------------------------------------------------|--------|
| 1 | `ragTopK`                    | `electron/lib/rag/index.ts`                                 | OK     |
| 2 | `ragScoreThreshold`          | `electron/lib/rag/index.ts`                                 | OK     |
| 3 | `chatTemperature`            | `electron/lib/rag/index.ts`                                 | OK     |
| 4 | `chatTopP`                   | `electron/lib/rag/index.ts`                                 | OK     |
| 5 | `chatMaxTokens`              | `electron/lib/rag/index.ts`                                 | OK     |
| 6 | `ingestParallelism`          | `renderer/library.js`                                       | OK     |
| 7 | `ingestUpsertBatch`          | `electron/ipc/scanner.ipc.ts` + `bookhunter.ipc.ts`         | OK     |
| 8 | `maxBookChars`               | `electron/ipc/scanner.ipc.ts` + `bookhunter.ipc.ts`         | OK     |
| 9 | `chunkSafeLimit`             | `electron/ipc/dataset-v2.ipc.ts`                            | OK     |
| 10| `chunkMinWords`              | `electron/ipc/dataset-v2.ipc.ts`                            | OK     |
| 11| `driftThreshold`             | `electron/ipc/dataset-v2.ipc.ts`                            | OK     |
| 12| `maxParagraphsForDrift`      | `electron/ipc/dataset-v2.ipc.ts`                            | OK     |
| 13| `overlapParagraphs`          | `electron/ipc/dataset-v2.ipc.ts`                            | OK     |
| 14| `judgeScoreThreshold`        | `electron/ipc/dataset-v2.ipc.ts`                            | OK     |
| 15| `crossLibDupeThreshold`      | `electron/ipc/dataset-v2.ipc.ts`                            | OK     |
| 16| `intraDedupThreshold`        | `electron/ipc/dataset-v2.ipc.ts`                            | OK     |
| 17| `policyMaxRetries`           | `electron/dataset-generator.ts` via `buildRequestPolicy()`  | OK     |
| 18| `policyBaseBackoffMs`        | `electron/dataset-generator.ts` via `buildRequestPolicy()`  | OK     |
| 19| `hardTimeoutCapMs`           | `electron/dataset-generator.ts` via `buildRequestPolicy()`  | OK     |
| 19a| `lockRetries`               | `electron/main.ts` -> `configureFileLockDefaults()`         | OK     |
| 19b| `lockStaleMs`               | `electron/main.ts` -> `configureFileLockDefaults()`         | OK     |
| 19c| `healthPollIntervalMs`      | `electron/main.ts` -> `configureWatchdog()`                 | OK     |
| 19d| `healthFailThreshold`       | `electron/main.ts` -> `configureWatchdog()`                 | OK     |
| 19e| `watchdogLivenessTimeoutMs` | `electron/main.ts` -> `configureWatchdog()`                 | OK     |
| 20| `forgeHeartbeatMs`           | `electron/ipc/forge.ipc.ts` -> `LocalRunner.start()`        | OK     |
| 21| `forgeMaxWallMs`             | `electron/ipc/forge.ipc.ts` -> `LocalRunner.start()`        | OK     |
| 22| `searchPerSourceLimit`       | `electron/ipc/bookhunter.ipc.ts`                            | OK     |
| 23| `downloadMaxRetries`         | `electron/ipc/bookhunter.ipc.ts` -> `downloadBook()`        | OK     |
| 24| `qdrantTimeoutMs`            | `electron/ipc/qdrant.ipc.ts` (search)                       | OK     |
| 25| `qdrantSearchLimit`          | `electron/ipc/qdrant.ipc.ts` (search default)               | OK     |
| 26| `refreshIntervalMs`          | reserved for future polling loops                           | UNUSED |
| 27| `toastTtlMs`                 | `renderer/chat.js` + `dataset.js`                           | OK     |
| 28| `spinDurationMs`             | `renderer/chat.js`                                          | OK     |
| 29| `resilienceBarHideDelayMs`   | `renderer/components/resilience-bar.js`                     | OK     |
| 30| `ocrEnabled`                 | `scanner.ipc.ts` + `bookhunter.ipc.ts` parseOptions         | OK     |
| 31| `ocrLanguages`               | OCR pipeline                                                | OK     |
| 32| `ocrAccuracy`                | OCR pipeline                                                | OK     |
| 33| `ocrPdfDpi`                  | `pdf.ts` -> `rasterisePdfPages({dpi})`                      | OK     |
| 34| `libraryGroupBy`             | `renderer/library.js`                                       | OK     |

**Итого: 38 wired в runtime, 1 reserved (`refreshIntervalMs` -- для будущих
polling loops, например автообновление статуса LM Studio).**

Revision 1 этого отчёта неверно указывал "32 keys / 30 wired"; revision 2
после `/sherlok` исправлено на 34 keys / 33 wired; revision 3 добавил 5 новых
resilience-ключей (lock + watchdog) и сразу wire-down. Один gap намеренно
оставлен (`refreshIntervalMs`) с явным TODO в QUALITY-GATES.md.

## 5. Drag & Drop корректность

| Тест                                           | Поведение                              | Status |
|------------------------------------------------|----------------------------------------|--------|
| Перетащить .pdf на dropzone                    | probeFiles + добавление в список       | OK     |
| Перетащить .png/.jpg                           | probeFiles + ext='png/jpg' + image-parser | OK  |
| Перетащить .exe / unsupported                  | alert "unsupported"                    | OK     |
| Перетащить файл вне dropzone                   | window-level guard (preventDefault)    | OK     |
| Кликнуть dropzone                              | openFiles dialog                       | OK     |
| Enter / Space на dropzone (a11y)               | openFiles dialog                       | OK     |

## 6. OCR-функциональность

| Тест                                           | Поведение                              | Status |
|------------------------------------------------|----------------------------------------|--------|
| OCR badge в toolbar -- Windows/macOS           | "OCR: win32" зелёный                   | OK     |
| OCR badge -- Linux                             | "OCR: unavailable"                     | OK     |
| OCR per-task toggle (Windows/macOS)            | передаётся как ocrOverride в startIngest | OK   |
| OCR Settings: enable -> save -> persist        | preferences.set + atomic write         | OK     |
| OCR Settings: languages tags input             | parse "en, ru, fr" -> array            | OK     |
| OCR PDF fallback: pdf без текста + ocrEnabled  | rasterise + recognize per page         | OK     |
| OCR Image: drop .png + ocrEnabled              | image parser + section с текстом       | OK     |

## 7. Async safety

`renderer/chat.js#withSpin` -- has try/finally (fixed earlier).
`renderer/library.js#runOne` -- has try/finally + clears active state.
`renderer/library.js#openFiles`, `probeFolder` -- has try/finally + busy reset.
`renderer/settings.js#save` -- has try/finally + clears `saving` flag.
`renderer/settings.js#resetAll` -- delegates to api with confirm + try/catch + alert.

Не найдено: незакрытых async-state, потенциальных utility hangs.

## 8. Итог

```
Всего интерактивных элементов:    96
Рабочих:                          96 (100%)
Подозрительных:                    0
Мёртвых:                           0

Маршрутов:                        10
Валидных:                         10 (100%)
Битых:                             0

Store / Preferences keys:         39
Видны в Settings UI:              39 (100%)
Wired to runtime:                 38 (97%)
Reserved (intentional):            1  refreshIntervalMs

Drag&Drop сценариев:               6 / 6  OK
OCR сценариев:                     7 / 7  OK

Diamond-buddha cleanup (rev3):
- dead exports удалено:            1  (isImageBookExt)
- BAD swallowed catches исправлено: 3  (batch / forge / profile-manager)
- Magic numbers извлечено:         1  (EMBEDDING_DIM в scanner/embedding.ts)
- Type 2 refactor candidates:      7  (см. QUALITY-GATES.md / >400 строк)
```

## 9. Рекомендация (одна, как требует протокол)

`refreshIntervalMs` остаётся единственным неиспользуемым preference --
зарезервирован для будущего auto-refresh статуса LM Studio в hero-секциях
(вместо текущих manual "Refresh" кнопок). Либо подключить в одном месте
(например `models-page.js` poll loop), либо удалить из schema. Текущая
гибридная позиция -- "видно но не работает" -- худший компромисс.
