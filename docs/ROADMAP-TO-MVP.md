# ROADMAP — Bibliary v3.x

> Живой технический roadmap. Обновляется при каждом релизе.
> Содержит: историю закрытых milestone'ов, инвентарь технического долга, приоритизированные задачи.

---

## История закрытых milestone'ов

| Версия | Дата | Ключевые закрытые задачи |
|--------|------|--------------------------|
| **v2.7.0** | 2026-04-24 | Library + Dataset Factory; Pre-flight Evaluator; DataGrid каталог; Crystallizer pipeline в coordinator; E2E тест `scripts/e2e-full-mvp.ts` |
| **v3.0.0** | 2026-04-25 | Import logging (JSONL persistence + real-time UI); Vision-meta local LM Studio; Graceful shutdown (active import count); Ukrainian OCR patterns; Tag cloud search; Year column; Re-evaluate all |
| **v3.1.0** | 2026-04-26 | Vision-meta multi-model fallback (`pickVisionModels`); PDF/DJVU page gallery (до 12 страниц); Library UI hardening (dropzone drag-drop, busy-lock, danger-confirm); E2E smoke harness (`BIBLIARY_SMOKE_UI_HARNESS`); Полная i18n-локализация Library |

---

## Текущее состояние — v3.1.0 (2026-04-26)

| Слой | Готовность | Примечание |
|------|------------|------------|
| Scanner / Import | 97% | Все форматы; drag-drop; multi-file; OCR; RAR/7z; архивы вложенные |
| Library UI | 100% | Catalog, reader, import, tag cloud, quality filter, год, i18n RU/EN |
| Pre-flight Evaluator | 97% | LLM scoring; surrogate; CoT; parallel slots; priority queue |
| Vision-meta | 95% | Multi-model fallback; local LM Studio only; graceful degrade |
| Image extraction | 90% | EPUB/FB2/DOCX native; PDF/DJVU до 12 страниц; обложки |
| BookHunter | 90% | 4 источника (Gutendex, Archive, OpenLibrary, arXiv); download+ingest |
| Crystallizer (dataset-v2) | 95% | Delta-knowledge; AURA; semantic chunker; e5-small embeddings |
| Forge / Fine-tuning | 95% | 3-step wizard; Unsloth+Axolotl; YaRN; LocalRunner WSL; Eval |
| Agent | 85% | ReAct loop; tools; approval gate; memory; multiturn |
| Chat / RAG | 95% | Semantic search; compare-mode; sampling presets |
| Settings | 100% | 55 ключей в PreferencesSchema; 41 открыт в UI; 14 внутренних/wizard |
| Models / YaRN | 95% | Profiles; context slider; atomic patch; backup+revert |
| Qdrant UI | 100% | Cluster; collections; search; info |
| Resilience | 95% | Atomic write; lockfile; watchdog; abortAll on quit; coordinator |
| OCR | 90% | Windows.Media.Ocr; macOS Vision; DJVU; PDF rasterize |
| Neon / 2666 UI | 100% | Все 9 маршрутов; 2666 + Neon корпоративный стиль |
| Onboarding Wizard | 95% | 4 шага; restore prefs; block без модели |
| Help-KB | 90% | Synthetic KB о приложении; search_help tool агента |
| Tests | 97% | ~153 unit/integration + 1 Electron smoke + 12 E2E-скриптов |
| i18n | 100% | RU + EN; ~1800+ ключей |
| CI/CD | 0% | GitHub Actions отсутствуют |

Общий progress: **~97%** (CI/CD и ряд P2 задач тянут вниз).

---

## Инвентарь технического долга

Результат аудита кодовой базы v3.1.0. Сгруппирован по критичности.

### P0 — Настоящие баги (блокируют качество в production)

| ID | Описание | Файл | Симптом |
|----|----------|------|---------|
| **B-01** | Race condition в evaluator-queue при `DEFAULT_SLOT_COUNT=2`: тест `"continues after single book fails"` нестабилен, т.к. обе книги стартуют параллельно и `count`-счётчик первого вызова может сработать на книге B вместо A | `electron/lib/library/evaluator-queue.ts` | Книга может получить статус `failed` недетерминированно при >1 слоте |
| **B-02** | `loadCatalog` в каталоге при ошибке IPC пишет только в `console.error` — пользователь видит пустую таблицу без объяснений | `renderer/library/catalog.js` | Молчаливый сбой: пользователь не понимает, пуста ли библиотека или произошла ошибка |
| **B-03** | `evaluateBook()` может выбросить исключение, если `listLoaded()` / `listDownloaded()` падают при недоступном LM Studio — `evaluator-queue` перехватит, но standalone вызовы не защищены | `electron/lib/library/book-evaluator.ts` | Потенциальный crash при offline LM Studio в нестандартных call site'ах |

### P1 — Качество и UX (следующий sprint)

| ID | Описание | Файл |
|----|----------|------|
| **Q-01** | `visionModelKey` / `visionMetaEnabled` есть в `PreferencesSchema` (55 ключей), но отсутствуют в `renderer/settings/sections.js` — пользователь не может управлять через UI Settings | `renderer/settings/sections.js` |
| **Q-02** | Bulk delete в каталоге: ошибки удаления отдельных книг уходят в `console.warn` без feedback пользователю | `renderer/library/catalog.js` |
| **Q-03** | Session persistence (`data/library-session.json`) — не реализовано; при перезапуске теряется выбор книг | Планировалось в P1.2 старого roadmap |
| **Q-04** | `help-kb` по умолчанию ингестит только 3 файла из docs/ — после удаления `STATE-OF-PROJECT.md` нужно обновить список на актуальные docs | `electron/lib/help-kb/ingest.ts` |
| **Q-05** | Централизованный toast/notification manager в renderer отсутствует — модули используют разные подходы (`showAlert`, `showLibraryToast`, `setCatalogStatus`) | `renderer/components/` |

### P2 — Архитектура и инфраструктура

| ID | Описание | Файл/область | Сложность |
|----|----------|-------------|-----------|
| **A-01** | CI/CD отсутствует — нет `.github/workflows/`. Ни линт, ни тесты не запускаются автоматически на push | `.github/workflows/` | S |
| **A-02** | Auto-update (`electron-updater`) деферировано с v2.6. `package.json#build.publish` не настроен | `electron-builder.yml`, `package.json` | M |
| **A-03** | `HARD_SPLIT_LIMIT` (2500 слов) захардкожен в semantic-chunker, а `chunkSafeLimit` (4000 в prefs) — настраиваем; семантическое несоответствие | `electron/lib/dataset-v2/semantic-chunker.ts` | S |
| **A-04** | При >800 параграфов drift-detection пропускается полностью — только hard-split. Нет fallback-стратегии для больших книг | `electron/lib/dataset-v2/semantic-chunker.ts` | M |
| **A-05** | `@xenova/transformers` — 60 MB embeddings грузятся при первом старте блокирующе. Нет progress UI и on-demand download | `electron/lib/scanner/embedding.ts` | M |
| **A-06** | Нет unit-тестов для: Forge wizard, BookHunter, Agent, DJVU-парсера, YaRN engine, resilience/watchdog. Тестовое покрытие неравномерно | `tests/` | L |
| **A-07** | Сборочная конфигурация только Windows (`electron-builder.yml` без macOS/Linux targets) | `electron-builder.yml` | M |
| **A-08** | RTF/DOC/ODT парсеры хрупкие — regex-strip или binary fallback; на сложных файлах регулярно возвращают пустые sections | `electron/lib/scanner/parsers/rtf.ts`, `doc.ts`, `odt.ts` | L |

### P3 — Backlog (после первого public release)

- Полные unit-тесты парсеров (RTF/DOC/ODT особенно хрупкие)
- Playwright E2E на уровне UI (сейчас только smoke через harness)
- Telemetry dashboard (renderer route)
- macOS/Linux build targets
- TON licensing (pro-tier gate для forge local runner, кристаллизатор >100 chunks)
- Plugin system (3rd-party extraction roles)
- Memory profiler / heap snapshots для долгих сессий (>4h)
- Crystallizer streaming UI (per-chunk live preview принятых концептов)

---

## P0 — Критические задачи (ближайший спринт)

### P0.1. Фикс race condition в evaluator-queue

**Проблема:** `DEFAULT_SLOT_COUNT=2` означает, что оба слота стартуют параллельно. В тесте `"continues after single book fails"` первый вызов `evaluateBook` может достаться книге B, а не A — что инвертирует ожидаемые статусы. В продакшне это означает, что при нескольких одновременных книгах `failed` может достаться не той.

**Решение:** В тесте добавить `setEvaluatorSlots(1)` перед проверкой. В production-логике — инъекция ошибки по `bookId`, а не по shared counter.

**Файлы:** `tests/evaluator-queue.test.ts`, `electron/lib/library/evaluator-queue.ts`

**Критерий:** `npm run test:fast` зелёный 3 прогона подряд.

### P0.2. Показывать ошибку пользователю при сбое loadCatalog

**Проблема:** `loadCatalog()` при выброшенном исключении логирует только в `console.error`. Пользователь видит пустую таблицу — не понимает: пусто или сломано.

**Решение:** В catch-блоке `loadCatalog` добавить `await showAlert(t("library.catalog.loadError", { msg }))` или вставить error-banner в таблицу.

**Файлы:** `renderer/library/catalog.js`

**Критерий:** При искусственной ошибке IPC пользователь видит явное сообщение.

### P0.3. Защитить evaluateBook от throw при недоступном LM Studio

**Проблема:** `pickEvaluatorModel()` вызывает `listLoaded()` и `listDownloaded()` без try/catch. Если LM Studio недоступен — бросает. В `evaluateBook` этот вызов не обёрнут.

**Решение:** Обернуть вызов `pickEvaluatorModel()` в `evaluateBook` в try/catch и вернуть `{ evaluation: null, warnings: ["evaluator: LM Studio unavailable"] }`.

**Файлы:** `electron/lib/library/book-evaluator.ts`

**Критерий:** `evaluateBook("...", {})` при offline LM Studio никогда не бросает.

---

## P1 — Следующий sprint

### P1.1. Добавить visionModelKey / visionMetaEnabled в Settings UI

`visionModelKey` и `visionMetaEnabled` есть в `PreferencesSchema` (ключи 42–43) но не открыты в `renderer/settings/sections.js`. Добавить в секцию OCR или новую секцию Vision.

**Критерий:** Пользователь может задать/очистить `visionModelKey` в Settings → OCR без правки `data/preferences.json` вручную.

### P1.2. Session persistence

Сохранять состояние библиотеки (`selectedBookIds`, активные фильтры) в `data/library-session.json` при unload и восстанавливать при mount.

**Критерий:** Пользователь выбирает 20 книг → закрывает → открывает → видит тот же набор.

### P1.3. Обновить help-kb source list

После удаления `docs/STATE-OF-PROJECT.md` этот файл больше не существует, но может быть в source list `help-kb/ingest.ts`. Заменить на `docs/AI-AUDIT.md` + `docs/ROADMAP-TO-MVP.md`.

**Критерий:** `npm run build:help-kb` завершается без ошибок 404.

### P1.4. Visible per-book errors при bulk delete

В `catalog.js` `deleteBook` ошибки идут в `console.warn`. Добавить аккумулированный toast: «Удалено N, ошибок M: [детали]».

**Критерий:** При partial failure пользователь видит точное число неудач.

### P1.5. Централизованный toast manager

Создать `renderer/components/toast.js` с очередью, анимацией, auto-dismiss (через `toastTtlMs` из prefs). Заменить прямые `showAlert` в Library на toast где это уместно.

**Критерий:** Все toast-уведомления в Library используют единый компонент; нет `alert()` в маршруте library.

---

## P2 — Архитектурный sprint

### P2.1. CI/CD — GitHub Actions

Создать `.github/workflows/ci.yml`:
- `npm run lint`
- `npm run test:fast`
- `npm run electron:compile`

Триггер: push на `main`, PR.

**Критерий:** Зелёный workflow badge на README.

### P2.2. Auto-update (`electron-updater`)

Добавить `electron-updater` в deps. Настроить `build.publish` в `package.json`:

```yaml
publish:
  provider: github
  owner: <owner>
  repo: bibliary
```

Добавить баннер «Доступна новая версия» при старте.

**Критерий:** Клик «Обновить» → тихая загрузка → перезапуск с новой версией.

### P2.3. chunkHardSplitLimit в prefs

Добавить ключ `chunkHardSplitLimit` (default 2500) в `PreferencesSchema` и пробрасить в `semantic-chunker.ts`. Устранить несоответствие между `chunkSafeLimit` (4000, configurable) и `HARD_SPLIT_LIMIT` (2500, hardcoded).

**Критерий:** Изменение в Settings → следующая кристаллизация использует новое значение.

### P2.4. On-demand embedder download с progress UI

`@xenova/transformers` при первом старте блокирующе качает ~60 MB. Показывать progress bar в onboarding wizard или resilience-bar.

**Критерий:** Первый старт на чистой машине показывает прогресс, не «зависает» на 30 секунд.

### P2.5. RTF/DOC/ODT: smoke unit-тесты + fallback warnings

Добавить тесты с реальными фикстурами для `rtf.ts`, `doc.ts`, `odt.ts`. Убедиться, что при пустом результате warnings содержат actionable сообщение (не просто «0 sections»).

**Критерий:** `tests/parser-smoke.test.ts` проверяет минимальный вывод для каждого формата.

### P2.6. Базовые unit-тесты для Forge, BookHunter, YaRN

Добавить в `tests/`:
- `forge-configgen.test.ts` — Zod schema + generateUnslothPython + generateAxolotlYaml
- `bookhunter-aggregator.test.ts` — mock source, dedup, license filter
- `yarn-engine.test.ts` — snapFactor, estimateKVCache, recommend

**Критерий:** `npm run test:fast` покрывает базовую логику Forge, BookHunter, YaRN без LM Studio.

---

## P3 — Backlog (без конкретных сроков)

```
□ Playwright E2E: полный UI-уровень (не только smoke через harness)
□ Telemetry dashboard route в renderer
□ macOS/Linux: добавить targets в electron-builder.yml
□ TON licensing: electron/lib/licensing/ton.ts (pro-tier gate)
□ Plugin system: 3rd-party extraction roles через хук в coordinator
□ Memory profiler: heap snapshot каждые 30 мин при сессии >4 часов
□ Crystallizer streaming UI: per-chunk live preview принятых концептов
□ Auto-detect OCR language из PDF metadata (Language field) → prefs.ocrLanguages fallback
```

---

## RC Checklist (следующий release)

```
□ P0.1 + P0.2 + P0.3 закрыты
□ npm run lint                         (exit 0)
□ npm run test:fast                    (все тесты 3 прогона подряд)
□ npm run test:smoke                   (Electron E2E зелёный)
□ npm run electron:compile             (exit 0)
□ npm run electron:build-portable      (EXE собран, размер в норме)
□ Smoke install test на чистой OS Windows 10+
□ OCR проверен на scanned PDF (Windows.Media.Ocr)
□ LM Studio integration работает на свежей установке (v0.4.12+)
□ Qdrant доступен через docker compose или local install
□ CHANGELOG.md обновлён (user-facing changes)
□ README.md содержит install + first-run guide
```

После: `git tag v3.2.0 && git push --tags` + GitHub Release (если P2.2 реализован — auto-update).

---

## Что НЕ в scope

- Mobile companion app (P3 после cloud sync)
- Cloud sync (P3, требует auth инфраструктуры)
- Production-grade multi-user (Bibliary — single-user desktop)
- GPU-accelerated embeddings (Xenova ONNX достаточно для desktop library)
- Web версия (Electron first)
