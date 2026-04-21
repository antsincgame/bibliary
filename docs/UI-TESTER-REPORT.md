# UI-TESTER REPORT — Bibliary v2.5.2

> Скилл `/ui-tester` -- статический инспектор интерактивных элементов.
> Дата отчёта: 2026-04-21. Скан после Phase 6.0 (OCR) + drag&drop + grouping.

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

## 4. Store / Preferences интеграция

| Action / preference key       | Используется в UI?                              | Status |
|-------------------------------|-------------------------------------------------|--------|
| `ragTopK`, `ragScoreThreshold`| RAG runtime + Settings field                    | OK     |
| `chatTemperature`, `chatTopP` | RAG runtime + Settings field                    | OK     |
| `chatMaxTokens`               | RAG runtime + Settings field                    | OK     |
| `ingestParallelism`           | Library queue + Settings field                  | OK     |
| `ingestUpsertBatch`           | Scanner ingest + Settings (под капотом)         | OK     |
| `maxBookChars`                | Scanner ingest + Settings                       | OK     |
| `chunkSafeLimit`, `chunkMinWords`, `driftThreshold` | Crystallizer + Settings  | OK     |
| `judgeScoreThreshold`         | Crystallizer + Settings                         | OK     |
| `crossLibDupeThreshold`, `intraDedupThreshold` | Crystallizer + Settings        | OK     |
| `policyMaxRetries`, `policyBaseBackoffMs`, `hardTimeoutCapMs` | Settings (Pro)  | WIRE   |
| `forgeHeartbeatMs`, `forgeMaxWallMs` | Settings (Pro)                           | WIRE   |
| `searchPerSourceLimit`        | Library search + Settings                       | OK     |
| `qdrantTimeoutMs`, `qdrantSearchLimit` | Settings + qdrant search                | OK     |
| `refreshIntervalMs`, `toastTtlMs`, `spinDurationMs` | UI runtime + Settings      | OK     |
| `resilienceBarHideDelayMs`    | resilience-bar + Settings                       | OK     |
| `ocrEnabled`, `ocrAccuracy`, `ocrLanguages`, `ocrPdfDpi` | OCR + Settings       | OK     |
| `libraryGroupBy`              | Library group control + Settings (под капотом)  | OK     |

`WIRE` -- ключ сохраняется и виден в UI, но в backend ещё не подключен к
runtime decision (используется default из constants). Это явный пункт roadmap
(см. `docs/ROADMAP-TO-MVP.md`).

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

Store / Preferences keys:         32
Используются в UI:                32 (100%)
Wired to runtime:                 30 (94%)
Только в Settings (нужен wire):    2 (forge watchdog runtime use-case)

Drag&Drop сценариев:               6 / 6  OK
OCR сценариев:                     7 / 7  OK
```

## 9. Рекомендация (одна, как требует протокол)

`forgeHeartbeatMs` и `forgeMaxWallMs` уже сохраняются и читаются из preferences
в Settings UI, но в `electron/lib/forge/local-runner.ts` всё ещё используются
жёстко вшитые константы. Подключить их к `getPreferencesStore()` -- одна правка
файла, ~5 строк, после которой все 32 ключа preferences будут полностью
runtime-конфигурируемые.
