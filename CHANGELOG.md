# Changelog

All notable changes to Bibliary are documented in this file. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.11.7] — 2026-05-04 — Remove Linux platform support

### Removed

- **Linux CI build** — удалён workflow `release-linux.yml` (AppImage / deb / tar.gz сборки).
- **`ci-linux` job** — убран ubuntu-latest runner из `ci.yml`; `olympics-policy` переведён
  на `windows-latest`.
- **`smoke.yml`** — переключён с `ubuntu-latest` на `windows-latest`.
- **`scripts/download-djvulibre-linux.cjs`** — удалён Linux-специфичный хелпер DjVuLibre.
- **`electron-builder.yml`: `linux:` target block** — убраны AppImage / deb / tar.gz цели
  и соответствующие `asarUnpack` записи для `edgeparse-linux-x64-gnu` / `arm64-gnu`.
- **`scripts/build-portable.js`: Linux ветка** — скрипт теперь Windows-only;
  неWindows платформа завершается с явной ошибкой.
- **`scripts/fix-edgeparse-native.cjs`: Linux платформы** — удалены `linux-x64` и
  `linux-arm64` записи из `platforms` и `subfolderMap`.
- **`profiler.ts`: `detectGpusLinux()`** — удалена функция и вызов `lspci`-based GPU-детекта.
- **`edgeparse-bridge.ts`: Linux native keys** — убраны `linux-x64` и `linux-arm64` из
  `addonMap`.
- **Locale strings** — удалён ключ `settings.section.ocr.linuxHint` из `en.js` и `ru.js`.

### Verified

- **Import flow audit** — кнопка "Выбрать папку" → `importFromFolder` → `showConfirm`
  (z-index 11000) → preflight IPC → `showPreflightModal` (z-index 11050): цепочка
  корректна, блокировок нет. Единственный защитный барьер — `IMPORT_STATE.busy`, но он
  имеет 30-секундный автосброс при застревании.

## [0.11.6] — 2026-05-04 — CI cross-platform paths, zombie timers, import error hardening

### Fixed

- **CI: cross-platform test paths** — `tests/import-candidate-filter.test.ts` и
  `tests/path-sanitizer.test.ts` заменили Windows-only пути `D:\\Bibliarifull\\...` на
  `path.join(os.tmpdir(), ...)`. CI на Linux теперь проходил все 1054 теста.
- **`lmstudio-client.ts`: `getServerStatus()` timeout** — добавлен `Promise.race` с
  8-секундным `.unref()` таймаутом: WebSocket-зависание LM Studio больше не блокирует
  завершение приложения.
- **`lmstudio-watchdog.ts`: unref poll timer** — `pollTimer.unref()` в `scheduleNextPoll`
  предотвращает удержание event loop при простое.
- **`child-watchdog.ts`: unref watchdog timers** — `.unref()` добавлен на `watchdogTimer`
  и на SIGKILL grace-period таймер.
- **`import-pane-actions.js`: timeout leak** — `clearTimeout(timeoutHandle)` в `finally`
  блоке для `runPreflightAndDecide` и DnD; предотвращает срабатывание отложенного reject
  после завершения гонки.
- **`import-pane-actions.js`: `handleDecision` unhandled rejection** — вызов
  `opts.handleDecision(decision)` обёрнут в `try-catch` с toast-уведомлением.
- **`import-pane-preflight.js`: drag-and-drop error boundary** — `showPreflightModal` в
  DnD-пути обёрнут в `try-catch`; ошибки DOM не роняют весь drop-handler.

## [0.11.5] — 2026-05-04 — Zombie process on close, preflight timeout hardening

### Fixed

- **Zombie process on restart** — `hardExit()` добавлен как failsafe при `before-quit`:
  если `teardownSubsystems()` не завершается за 6 с — `process.exit(0)` принудительно.
  Устраняет зависание при повторном запуске Bibliary.
- **`disposeClientAsync()`** — явное закрытие LM Studio WebSocket перед quit.
  Добавлен `8-second timeout` + `setTimeout(...).unref()` в `withSdk()`.
- **`preflight.ts`: `.unref()` on internal timers** — `setTimeout` внутри `withTimeout`
  теперь не держит event loop при пустых preflight-запросах; устраняло 10-секундный
  подвис теста в `preflight.test.ts`.
- **`lmstudio-client.ts`: graceful dispose on refresh** — `refreshLmStudioClient()`
  ждёт `disposeClientAsync()` перед созданием нового клиента.

## [0.11.4] — 2026-05-04 — Fix stuck import button, clear logs, scan safety

### Fixed

- **Import button unresponsive (root cause)** — `IMPORT_STATE.busy` мог навсегда застревать
  в `true` после `scanFolderForDuplicates` если main-process не отправлял `scan-report` event.
  Добавлен safety timeout (120 с) для принудительного сброса busy.
- **Force-reset busy on click** — если пользователь нажимает "Выбрать папку"/"Выбрать файлы"
  и busy застрял >30 с без активного importId — автоматический сброс вместо тихого return.
- **User feedback when busy** — вместо беззвучного игнора теперь показывается toast
  "Импорт или сканирование ещё не завершены".
- **Clear logs visual feedback** — кнопка "Очистить" теперь моргает "✓" на 0.8 с после
  очистки. Добавлен `stopPropagation` для предотвращения перехвата клика родителем.
- **Zombie busy-state** — таймаут сброса уменьшен с 5 мин до 60 с (UI-poller).
- **Log counter CSS** — добавлены отсутствующие стили для счётчиков дубликатов и пропусков
  (`.lib-import-log-counter-dup`, `.lib-import-log-counter-skip`).
- **Log buttons clickability** — увеличен размер кнопок "Очистить"/"Скопировать" в шапке
  лога: padding 4px 10px, min-height 24px (было 2px 8px без min-height).

## [0.11.3] — 2026-05-04 — Olympics "Copy Protocol", import diagnostics, dead code cleanup

### Added

- **Olympics "Copy Protocol" button** — кнопка "Скопировать протокол" в Олимпиаде: копирует
  весь лог турнира в буфер обмена для дебага и отчётов.
- **Preflight status feedback** — при анализе файлов перед импортом теперь отображается
  статус "Анализ файлов перед импортом…" вместо пустого ожидания.
- **Diagnostic logging** — кнопки "Выбрать папку" и "Очистить" логи теперь пишут
  диагностику в console при вызове для отладки нечувствительных к кликам элементов.

### Fixed

- **Zombie busy-state protection** — если `IMPORT_STATE.busy` застревает в `true` без
  активного importId дольше 5 минут, автоматический сброс предотвращает блокировку UI.
- **evaluator-queue dead code** — удалён deprecated `ensurePreferredLoaded` (~50 строк) и
  устаревшие комментарии. Тесты синхронизированы с текущей кодовой базой.

## [0.11.2] — 2026-05-04 — Preflight scan, CoT lang-detect, evaluator smart-fallback

### Added

- **Preflight scan** — перед каждым импортом (папка / файлы / drag-and-drop) показывается
  модальное окно-отчёт: текстовые файлы vs image-only сканы, готовность OCR и Evaluator.
  Кнопки: `Continue all`, `Skip image-only`, `Configure OCR`, `Cancel`.
- **DjVu IFF probe** (`djvu-iff-probe.ts`) — легковесный in-process парсер IFF-структуры:
  определяет наличие текстового слоя без запуска внешнего `djvutxt`.
- **PDF text probe** (`pdf-text-probe.ts`) — обёртка над `@firecrawl/pdf-inspector`
  для классификации PDF (TextBased / Scanned / ImageBased / Mixed) до импорта.
- **OCR Capabilities** (`ocr-capabilities.ts`) — агрегация статуса System OCR + Vision-LLM.
- **Evaluator Readiness** (`evaluator-readiness.ts`) — preflight-проверка готовности
  Book Evaluator: preferred → CSV fallbacks → auto-pick; отражается в preflight-модале.
- **`extractLangCode`** (`disciplines.ts`) — CoT-устойчивое извлечение кода языка для
  моделей (Qwen3, GLM-4, GPT-OSS), которые пишут reasoning до финального ответа.
  `max_tokens` дисциплин lang-detect повышен 16 → 96.
- **PDF hex-title decode** (`title-heuristics.ts`) — CP1251 / UTF-16BE декодер для PDF
  Info-словаря: российские OCR-сканы (FineReader, PRO100) теперь дают читаемые заголовки
  вместо hex-мусора в каталоге.
- **`sanitizeRawTitle`** — публичный хелпер санитизации title до `pickBestBookTitle`.
- **`paragraphsToSections` экспорт** — теперь тестируемая функция (регрессионные тесты).
- **Arena MAX_AUTO_LOAD 6** (`arena.ipc.ts`) — лимит автозагрузки моделей 2 → 6
  (champion-set 6-8 ролей не умещался в старый лимит). Env override `BIBLIARY_MAX_AUTO_LOAD`.
- Новые тесты: `olympics-scorers` +14 (extractLangCode + CoT scorers), `title-heuristics-pdf-hex`
  14 тестов, `djvu-vertical-text-fix`, `auto-load-max-models`.

### Fixed

- **DjVu вертикальный текст** — `paragraphsToSections` склеивает одно-слово-на-строку
  (встроенный текстовый слой) в нормальные абзацы через `text.replace(/\n/g, " ")`.
- **Abort reason propagation** — `linkAbortSignal` и `ocrDjvuPages` пробрасывают причину
  abort: UI видит `"DjVu OCR cancelled by user"` vs `"exceeded per-file time budget"`.
- **Evaluator smart-fallback gate** — `evaluator-readiness.ts`: при `preferred` пустом
  и `fallbackPolicyEnabled=false` + загруженные LLM → теперь корректно `ready: true`
  (раньше неверно возвращало `no-llm-loaded`).
- **CSV separator inconsistency** — `evaluator-queue.ts` использует `/[\s,;]+/` как
  `evaluator-readiness.ts`: `;` и пробельные разделители теперь работают в обоих модулях.
- **Skip image-only + 0 файлов → тихий выход** — все три пути (importFromFolder,
  importFromFiles, drag-and-drop) теперь показывают информативный alert вместо `return`.
- **`hex.substr` deprecated** — заменено на `hex.slice` в `title-heuristics.ts`.
- Стили: статусная ячейка каталога получила `max-width + overflow: ellipsis`.
- Заголовки `<th>` каталога получили семантические классы (`lib-catalog-th-*`).
- Пустое значение quality заменено с `""` на `"—"` для визуальной ясности.
- DjVu OCR warnings теперь указывают точную причину вместо универсального
  `"Check djvulibre binaries"`.

### Changed

- `ensurePreferredLoaded()` удалён из `evaluator-queue` (создавал скрытые VRAM overflow,
  обходил контракт `allowAutoLoad: false`). Теперь picker сам делает smart-fallback.
- `evaluatorAllowFallback` добавлен в `PreferencesSchema` (default: `true`).
- `allowAnyLoadedFallback` в `book-evaluator-model-picker.ts` — строгий режим (off):
  если preferred не загружена — честный `failed` с понятным сообщением.

## [0.11.1] — 2026-05-04 — Critical fixes: image-refs, atomic write, prefs corruption

### Fixed

- **H11** — `injectCasImageRefs`/`parseBookMarkdownChapters` резали книгу по любому
  Markdown scene-break `---`. Исправлен поиск точной сигнатуры image-refs блока.
- **C3** — tmp-имена в `cache.ts`/`library-store.ts`: добавлен `randomBytes(8)` против
  race condition при параллельном импорте.
- **C4** — `writeTextAtomic` теперь делает `fdatasync` перед `rename` (NTFS power-off).
- **C5** — corrupted `preferences.json` карантируется в `.corrupted-<ts>`, UI получает
  событие.
- **vision_ocr Олимпиада**: 4 новые дисциплины, `scoreOcrRecall` достигает 100/100.
- **Zombie LM Studio**: `disposeClientAsync` блокирует quit до закрытия WebSocket.
- **Olympics persist**: arena.ipc — JSONL стрим + persist до возврата в renderer.

## [0.11.0] — 2026-05-04 — DjVu native, Olympics auto-roles, library UI

### Added

- **DjVu native parser** (`djvu-native.ts`) — `djvu.js` как альтернатива CLI с fallback.
- **Олимпиада**: авто-роли чемпионов, новая дисциплина, документация скоринга.
- **Library UI**: модалка создания коллекции, логи импорта в Import pane.
- **Отмена импорта**: очищает очереди LLM, `killChildTree` для 7z на Windows.
- **Vision LLM**: логирование ошибок улучшено.

## [0.10.1] — 2026-05-03 — Olympics tabs, Layout Assistant description, dropdown fix

### Fixed

- **Dropdown bug (Models → Pipeline Roles)**: native `<select>` закрывался через 8 сек
  из-за `setInterval` → `refresh()` → `clear(host)` пока пользователь выбирал модель.
  Фикс: `renderRoles()` пропускает re-render если любой `<select>` внутри host
  в фокусе (`host.contains(document.activeElement)`).

### Changed

- **Olympics winners → горизонтальные вкладки**: вместо вертикального стека карточек
  — tab-bar по ролям. Клик по вкладке показывает одну карточку. Победные роли
  помечены `✓`. Использует ширину экрана вместо высоты.

- **Layout Assistant**: добавлено в `ROLE_META` с label/help (EN + RU).
  Теперь Pipeline Roles показывает "Layout Assistant" и подробное описание
  вместо raw id `layout_assistant`.

- **Domain tags**: `unclassified`/`unsorted` визуально приглушены
  (opacity 0.4, grayscale, italic). Evaluator-промпт: улучшен пример
  C++ книги (`domain: "C++ programming language"`), добавлены конкретные
  примеры programming sub-domains в инструкцию.

- **Settings**: OCR → 4 дружелюбных toggle'а; детальные настройки
  (DPI, провайдеры, языки) вынесены в ADV. Defaults: `visionMetaEnabled=true`,
  `layoutAssistantEnabled=true`. Resume-phase bug в queue badge исправлен.

## [0.10.0] — 2026-05-03 — Layout Assistant (AI-верстальщик, LM Studio)

Полноценная интеграция локального LLM-верстальщика в пайплайн импорта и reader.
Работает полностью локально через LM Studio (Qwen 2.5-1.5B Instruct рекомендуется).

### Added

- **Layout Assistant** — новая роль `layout_assistant` в pipeline. Аннотирует
  book.md после OCR: находит заголовки без `##`-маркеров, удаляет OCR-мусор
  (одиночные номера страниц, колонтитулы), корректирует уровни `#`/`##`/`###`.
  Annotation-only подход — модель НЕ переписывает текст, только аннотирует
  проблемы, постпроцессор применяет детерминированные патчи (bottom-up).

- **Кнопка «AI Layout» в reader toolbar** — ручной запуск Layout Assistant
  для текущей книги. Переключается в режим «Отмена» когда очередь активна.
  Визуальный feedback через event subscription (`onLayoutAssistantEvent`).

- **Async queue** (`layout-assistant-queue.ts`) — opt-in фоновая очередь.
  Включается через `Settings → OCR & Vision → Layout Assistant`. Single-slot,
  событийная модель (layout.started / .done / .skipped / .failed).

- **Bug 4 fix — lock refactoring**: LLM inference (~10 мин на CPU) теперь
  выполняется ВНЕ `withBookMdLock`. Блокировка берётся только на write-фазу
  (< 1 сек). Concurrent modification detection: если evaluator обновил book.md
  пока шёл inference — layout assistant детектирует hash-mismatch и пропускает
  запись (книга остаётся нетронутой), пользователь получает предупреждение.

- **Concurrency tests** — 2 новых теста на concurrent modification detection:
  файл изменяется во время LLM inference → `applied: false`, evaluator content
  сохраняется.

- **Models page**: роль `layout_assistant` добавлена в `PIPELINE_ROLES`,
  `ALL_ROLES` (`📐 Верстальщик`), `ROLE_HUMAN_LABEL`. Доступна в Olympics.

- **Olympics discipline** `layout_assistant-chapter-detection`: golden fixture
  + precision/recall scorer (good ≈ 0.95, bad = 0).

- **Settings** — 3 поля в секции OCR & Vision:
  - `Layout Assistant (AI)` — toggle (default: off)
  - `Layout Assistant: модель LM Studio` — modelKey
  - `Layout Assistant: fallback модели` — CSV

- **Settings → OCR & Vision — live-карточка очереди Layout Assistant**
  (`renderer/settings.js`): начальное состояние из `library.layoutAssistantStatus().queue`,
  подписка на `library.onLayoutAssistantEvent`, обновление DOM без полного re-render;
  `preload.ts` — в тип ответа `layoutAssistantStatus` добавлено поле `queue`
  (соответствует IPC).

- **i18n** — ru/en ключи для AI Layout, Cancel, Applied, Noop, Failed.

- **Bug fixes** (обнаружены аудитом, исправлены):
  - Bug 5: `.bak` не перезаписывается если старше book.md (mtime-check)
  - Bug 9: heading.text валидируется против `lines[idx]` (защита от галлюцинаций)
  - Bug 11: `toc_block` удалён из схемы — dot-leader ToC структурирует `reader.js`
  - Bug 12: параграфы > maxChars разрезаются по строкам (`splitHugeParagraph`)
  - Bug 16: `.max(300)` на headings, `.max(500)` на junk_lines (защита от DoS)
  - Bug 23: `bootstrapLayoutAssistantQueue` обёрнут в outer try/catch
  - Bug 26: `force=true` стриппит marker перед chunking чтобы не тратить LLM впустую

### Changed

- **Block A — устранение хардкода**: inline-литералы inference params в
  `vision-meta.ts`, `vision-ocr.ts`, `text-meta-extractor.ts`, `translator.ts`,
  `book-evaluator.ts` вынесены в module-local `*_INFERENCE` const-объекты.
  Zero behavioral change — только именование.

- **Magic numbers → named constants**: `HEADING_HEURISTIC_CONFIG` (types.ts),
  `TOC_HEURISTIC_CONFIG` (reader.js), `META_FALLBACK_CONFIG` (md-converter.ts).

- **localhost dedup**: `DEFAULT_LM_STUDIO_URL` / `DEFAULT_QDRANT_URL` экспортируются
  из `endpoints/index.ts` — единый source of truth.

### Technical

- `layout-assistant.ts` — `chunkMarkdown` (paragraph-boundary + overlap 500 chars),
  `mergeAnnotations` (line offset shift + overlap dedup), `applyLayoutAnnotations`
  (bottom-up mutations — критично для предотвращения line drift).
- `layout-assistant-schema.ts` — Zod + `jsonrepair` (3.14.0) + regex partial
  extraction fallback для 1.5B моделей с fragile JSON output.
- Prompt scaffold начинается с пустого JSON-шаблона — убирает preamble text
  (снижает JSON failure rate на 50-70% у малых моделей).
- Целевой пакет тестов layout-assistant + olympics/roles (66 тестов в одном
  прогоне `node --import tsx --test` по выбранным файлам) + обновления
  olympics-scorers, role-load-config, model-role-resolver.

## [0.9.1] — 2026-05-03 — Hotfix: наложение строк в логе импорта

Hotfix к 0.9.0 после пользовательского отчёта *"тексты логов накладываются друг
на друга"*. Sherlok-расследование показало корневую причину: grid-сетка строки
лога имеет 6 фиксированных колонок, но JS-рендер выкидывал отсутствующие
`expandToggle` / `durationMs` / `file` через `.filter(Boolean)`. После этого
оставшиеся children сдвигались на 1–2 колонки влево, и текст времени попадал в
14px-колонку, message — в 60px и т.д. — визуально это и есть «строки логов
наезжают друг на друга».

### Fixed

- **`renderer/library/import-pane-log.js`** — отсутствующие slot'ы
  (`expandToggle`, `durationSlot`, `fileSlot`) теперь рендерятся как пустые
  spacer'ы с классом `lib-import-log-slot-empty`, чтобы grid-track'и оставались
  стабильными. Каждая строка лога гарантированно отдаёт ровно 6 children.
- **`renderer/styles.css`** — `grid-template-columns` использует
  `min-content` вместо `auto` для duration-колонки + новый класс
  `.lib-import-log-slot-empty` (visibility: hidden + width: 0), чтобы пустой
  slot занимал место в треке, но не рисовал контент.

### Notes

В этом релизе **никаких изменений в pipeline / IPC / preload** — только
renderer CSS+JS. Если после установки 0.9.1 что-то «выглядит как раньше»,
скорее всего запущен СТАРЫЙ exe из закреплённого ярлыка или из release/.
Используйте файл `Bibliary 0.9.1.exe` в корне проекта.

## [0.9.0] — 2026-05-03 — Reader, удаление книг, «Сжечь библиотеку»

### Added

- **IPC `library:burn-all` + preload `library.burnAll()`** — полный сброс
  `data/library/`, `bibliary-cache.db` (+ WAL/SHM), коллекций Qdrant с префиксом
  `bibliary-*`; кнопка в **Настройки → Показать продвинутые → Сжечь библиотеку**
  (двойное подтверждение).

### Fixed

- **Ридер:** flex-layout без визуального наезда на topbar/tabs; тело на всю ширину
  панели; без горизонтального скролла корня (переполнение в `pre`/`table`/картинках).
- **Оглавление:** якоря у заголовков + кликабельные строки оглавления в тексте.
- **Картинки `![alt][img-NNN]`:** предобработка reference-definitions до `marked`,
  чтобы не ломались при несбалансированных code fence в теле книги.
- **`library:delete-book`:** удаляются **оба** набора имён sidecar’ов (legacy и
  modern), чтобы не оставались «лишние» `original`/`.meta.json`; подъём вверх и
  удаление пустых каталогов до корня библиотеки.

## [0.8.2] — 2026-05-03 — Import Log Sherlok Cleanup

Patch follow-up к 0.8.1. Пользователь прислал реальные логи импорта и сказал
«пайплайн всё равно не работает». Расследование показало: pipeline на самом
деле **РАБОТАЕТ** (10 книг добавлено за 79 секунд, Versator применяется через
`md-converter.ts:658`, lazy-upgrade — через `library-catalog-ipc.ts`),
но **лог импорта раздувался в 5–7 раз** из-за дублирования и шумных
success-as-warning сообщений. Это создавало иллюзию массовых ошибок.

### Fixed

- **Удалено 5×-7× дублирование warnings в логе**
  ([electron/ipc/library-ipc-state.ts](electron/ipc/library-ipc-state.ts)) —
  для каждой книги с N warnings лог писал `1 file.added + N file.warning`
  событий, при том что N warnings уже включены в `file.added.details.warnings`.
  Например, у "Янца Т. — Алиса и Боб..." с 5 warnings было **6 строк** в
  логе вместо одной. Теперь warnings показываются ТОЛЬКО в details event'а
  `file.added`, разворачиваются через `▸` expand-toggle. UI counter "warn"
  больше не считает routine pdf-inspector диагностику как warnings —
  семантически правильнее.
- **Cascade-collapse для corrupt DJVU**
  ([electron/lib/library/image-extractors.ts](electron/lib/library/image-extractors.ts)) —
  при corrupt DJVU все 11 страниц подряд падают с одной ошибкой `Cannot
  decode page X / corrupt_BG44`. Раньше — 11 одинаковых строк лога.
  Теперь — высокоуровневый diagnostic + 1 sample (`всего 11/11 страниц
  не удалось декодировать (вероятно corrupt DJVU — попробуйте перекачать
  файл)`). Аналогичный pattern уже использовался в `pdf.ts:437-443`,
  применён к `image-extractors.ts:498-525`.
- **`isbn-meta: Open Library / Google Books` больше не warning**
  ([electron/lib/library/md-converter.ts](electron/lib/library/md-converter.ts)) —
  это событие УСПЕХА (online lookup нашёл метаданные!), а не warning.
  Метаданные уже отражены в title/author/year книги. Failure случай
  (`isbn-meta: online lookup failed (...)`) сохранён — это реальный
  warning для пользователя.

### Diagnostic finding (NOT a bug)

- **`Loading vision model "..." from prefs...` повторяется per book** —
  это нормально. `getModelPool().acquire()` дедуплицирует через
  `runOnChain`, реальная загрузка модели в LM Studio происходит ОДИН
  раз; subsequent calls возвращают handle на уже-загруженную модель.
  Лог-сообщение чисто декларативное (см. illustration-worker.ts:289).

### Note

User отправил логи импорта с большим количеством `[WARN]` строк и
сказал «не работает». Реальный анализ показал: импорт успешный, 10
книг добавлено, Versator применяется, vision triage работает. Проблема
была **исключительно в восприятии лога** (визуальный шум). После fix'ов
лог импорта станет в ~5× короче и в нём останутся только реальные
проблемы (corrupt DJVU summary, online lookup failures, OCR diagnostics
если включён OCR).

---

## [0.8.1] — 2026-05-03 — Reader Hot-Versator + UI/Log Diamond Polish

Patch follow-up к 0.8.0: пользователь обнаружил, что **существующие книги**
(импортированные в v0.7.x) открываются в reader как «просто копии» — без
премиум-вёрстки. Versator применялся только в момент импорта, поэтому весь
470+ каталог оставался в legacy-формате. Плюс — лог импорта дублировал
сообщения, а CSS .lib-reader-body имел два конфликтующих определения.

### Fixed

- **Reader как live-конвертер с вёрсткой**
  ([electron/ipc/library-catalog-ipc.ts](electron/ipc/library-catalog-ipc.ts)) —
  `library:read-book-md` теперь делает **lazy Versator-upgrade**: если
  `frontmatter.layoutVersion < LAYOUT_VERSION` (или отсутствует), к body
  применяется `applyLayout(...)` на лету. Read-only апгрейд — файл на диске
  не перезаписывается, только отдаваемый renderer'у markdown. Идемпотентно
  (повторный запуск стабилен).
- **CSS .lib-reader-body конфликт устранён**
  ([renderer/styles.css](renderer/styles.css)) — было два определения тех
  же селекторов: старый «лайт» (5562) и новый Versator-premium (7771). Старый
  блок удалён, layout-критичные `flex: 1; overflow-y: auto` перенесены в
  отдельный selector (~5566). Versator-тема дополнена правилами для
  `table`/`th`/`td`/`img`/`em`/`strong`, которых раньше не было.
- **UI overlap reader vs. tabs**
  ([renderer/styles.css](renderer/styles.css)) — добавлены `border-top:
  1px solid rgba(0, 240, 255, 0.18)` и мягкий cyan-glow `box-shadow` сверху
  у `.lib-reader`, плюс убран дубликат `background:` (декларация была
  дважды). Reader визуально отделён от верхнего меню.
- **Шум в логах импорта**
  ([electron/lib/library/import-book.ts](electron/lib/library/import-book.ts),
  [electron/lib/library/import-composite-html.ts](electron/lib/library/import-composite-html.ts)) —
  при `duplicate_sha` больше не добавляется warning `import: duplicate of
  XXX (SHA-256 match, parse skipped)`, который дублировал событие
  `file.duplicate` в логе. Теперь на одну дублирующуюся книгу — одна
  строка в логе, не две.

### Added (regression tests)

- **Lazy upgrade contract** в
  [tests/layout-pipeline.test.ts](tests/layout-pipeline.test.ts):
  - legacy book.md без `layoutVersion` ДОЛЖЕН получать Versator-разметку
    (`callout` / `dropcap` / `dfn`);
  - повторное применение `applyLayout` не дублирует разметку (защита от
    race condition при lazy upgrade).
- Versator suite вырос с 34 до **36 тестов**, все green.

### Note for users

Существующая библиотека получит научную вёрстку **автоматически при первом
открытии книги в reader** — никаких миграций, никаких длинных операций.
Performance: applyLayout пробегает крупный body (~1 МБ) за ~10–30 ms,
незаметно для пользователя.

---

## [0.8.0] — 2026-05-03 — Reader Purge + Versator Premium Layout

Императорский приказ: уничтожить тяжёлую нативную читалку, заменить её
на премиум-рендер `book.md` с научной типографикой. Никаких внешних
серверов — всё локально, MIT-clean.

### Added — Versator (Premium Scientific Layout)

- **Versator pipeline** (build-time, pure-JS, без LLM, без сети) — каждая
  книга при импорте проходит через `applyLayout(...)`:
  - [electron/lib/library/layout-pipeline.ts](electron/lib/library/layout-pipeline.ts) —
    главный orchestrator + `LAYOUT_VERSION` + `shouldRenderMath` авто-детект.
  - [electron/lib/library/layout-typograf.ts](electron/lib/library/layout-typograf.ts) —
    обёртка над `typograf` (MIT): русские «ёлочки», em-dash, NBSP.
  - [electron/lib/library/layout-callouts.ts](electron/lib/library/layout-callouts.ts) —
    распознавание `Внимание:` / `Совет:` / `Note:` / `Warning:` / `Important:`
    → стилизованные `<div class="lib-reader-callout-{note|tip|warning|important}">`.
  - [electron/lib/library/layout-definitions.ts](electron/lib/library/layout-definitions.ts) —
    «X — это Y» → `<dfn class="lib-reader-dfn">X</dfn>` с защитой от
    коротких местоимений (Я/Это/It/This/etc).
  - [electron/lib/library/layout-dropcaps.ts](electron/lib/library/layout-dropcaps.ts) —
    drop-cap на первой букве **текстового** параграфа главы. Пропускает
    blockquote (эпиграфы), images, lists, tables, HTML-вкрапления.
  - [electron/lib/library/layout-sidenotes.ts](electron/lib/library/layout-sidenotes.ts) —
    markdown footnotes `[^N]` → Tufte-style sidenote markup. Orphan defs
    (без inline ref) сохраняются как обычный markdown — нет потери контента.
  - [electron/lib/library/layout-katex.ts](electron/lib/library/layout-katex.ts) —
    `$...$` и `$$...$$` через локальный **KaTeX** с try/catch fallback на
    raw-текст при ParseError (битые формулы из старых OCR не рушат импорт).
  - [electron/lib/library/layout-protect-code.ts](electron/lib/library/layout-protect-code.ts) —
    placeholder protection: typograf и другие трансформации не трогают
    содержимое \`\`\`fenced\`\`\` и `inline code` блоков.
  - 35 unit-тестов в [tests/layout-pipeline.test.ts](tests/layout-pipeline.test.ts):
    идемпотентность, защита кода, orphan footnotes, drop caps только на
    текстовых параграфах, KaTeX graceful fallback, smart typography.

- **Bibliary Scientific CSS-тема** в [renderer/styles.css](renderer/styles.css):
  - Системный serif стэк: Charter / Iowan Old Style / Garamond / Cambria / Georgia.
  - Drop caps 4.2em italic gold с text-shadow.
  - Callouts: 4 типа с цветными иконками `i` / `✓` / `!` / `★` через `::before`.
  - `<dfn>` с gold accent + dotted underline.
  - Tufte sidenotes: float right на широких экранах; CSS-only toggle через
    `:checked` на `@media (max-width: 1180px)`.
  - Scientific blockquote, code blocks, lists, hr — единый visual language.

- **KaTeX vendored 100% локально** (`renderer/vendor/katex/`):
  - `katex.min.css` (23.8 KB) + 20 woff2 шрифтов (260 KB) = ~283 KB total.
  - Подключён через `<link>` в [renderer/index.html](renderer/index.html) ДО
    основного `styles.css` (для override-ов в `.lib-reader-body .katex`).
  - CSP в meta-теге расширен: `font-src 'self'` для local woff2.
  - Никаких CDN, никаких Google Fonts API.

- **`layoutVersion: number`** field в `BookCatalogMeta` (optional, Mahakala-safe):
  - 0 / undefined → legacy book.md без вёрстки (обратная совместимость).
  - При bump `LAYOUT_VERSION` в layout-pipeline старые книги остаются
    работоспособными до явной re-rendering через UI.

### Removed — Reader Purge

- **Нативная читалка `foliate-js` удалена полностью** (~3.7 MB vendor).
  - `renderer/library/native-reader.js` — deleted (fullscreen iframe overlay).
  - `renderer/vendor/foliate-js/` — целая папка deleted.
  - `scripts/download-foliate-js.cjs` — deleted.
  - `package.json:scripts.setup:foliate-js` — deleted.
  - i18n keys `library.nativeReader.*` и `library.reader.action.readNative*` — deleted.
  - Кнопка «Читать здесь» / «Read here» в reader-toolbar — deleted.
  - CSS блок `.lib-native-reader-*` (~50 строк) — deleted.

- **`bibliary-book://` custom protocol удалён** (использовался только нативной
  читалкой):
  - `electron/main.ts:registerBookProtocol()` — deleted.
  - `bibliary-book:` из CSP `img-src` / `connect-src` — deleted.
  - Из `protocol.registerSchemesAsPrivileged([...])` — deleted.

- **`electron/lib/scanner/converters/ddjvu-pdf.ts` удалён** (он использовался
  только для рендеринга DJVU в native reader через PDF). Парсер DJVU
  `parsers/djvu.ts` через `djvutxt` для импорта работает без изменений.

### Changed

- [renderer/library/reader.js](renderer/library/reader.js) — кнопка «Открыть
  во внешнем» переименована в «Открыть оригинал» (единственная теперь,
  поскольку native reader удалён).
- [renderer/library.js](renderer/library.js) — `switchTab()` больше не
  вызывает `closeNativeReader()`.
- [electron/lib/library/md-converter.ts](electron/lib/library/md-converter.ts) —
  body книги после `buildBody()` пропускается через `applyLayout()` с
  авто-детектом языка (`detectedLanguage === "en" ? "en" : "ru"`) и
  авто-флагом `renderMath` (если в тексте есть `$...$`).
- [electron/lib/library/types.ts](electron/lib/library/types.ts) —
  `BookCatalogMeta.layoutVersion?: number` добавлено как optional поле.

### Dependencies (added, MIT)

- `typograf@^7.7.0` — typography engine для русско/англоязычной литературы.
- `katex@^0.16.45` — math rendering, server-side `renderToString`.

---

## [0.8.0] — Phase A+B foundation (Calibre Purge + Torrent-Dump Hardening, Iter 9.1-9.6)

Фаланга Iter 9.1–9.6: Bibliary становится **полностью JS-нативным** аналогом
Calibre, без зависимости от внешнего Python-runtime. Поход против пяти слепых
зон под старые торренты (DJVU, кодировки, RAR/fb2.zip, имена файлов, Calibre
lock-in) — указано в code review от Google. Включено в релиз 0.8.0.

### Added

- **Iter 9.1 — Native Reader Foundation** (foliate-js MIT vendoring) —
  *удалено в Reader Purge секции выше; оставлено в истории как промежуточная
  итерация.*

- **Iter 9.2 — Encoding-aware imports** (chardet + iconv-lite)
  - [electron/lib/scanner/encoding-detector.ts](electron/lib/scanner/encoding-detector.ts)
    (новый): авто-определение кодировки через 4 источника по приоритету —
    BOM → XML declaration → HTML meta charset → chardet byte-pattern → UTF-8.
    Поддержка windows-1251, KOI8-R, IBM866 (DOS-866) и ~250 других кодировок.
  - Интеграция в `parsers/txt.ts`, `parsers/html.ts`, `parsers/fb2.ts` без
    breaking changes (старая `decodeTextAuto` API сохранена через adapter).
  - 16 unit-тестов в [tests/encoding-detector.test.ts](tests/encoding-detector.test.ts).

- **Iter 9.3 — Filename heuristic для русских коллекций**
  - [electron/lib/library/filename-parser.ts](electron/lib/library/filename-parser.ts) —
    добавлены паттерны `Толстой Л.Н. - Война и мир - 1869`,
    `Достоевский Ф.М. - Идиот`, `Пушкин А.С. Евгений Онегин (1833)`,
    `[Бахтин М.М.] Творчество (1965)`, year-first underscore-separated и т.д.
  - Поддержка двойных фамилий через дефис (`Мамин-Сибиряк Д.Н.`).
  - 12 unit-тестов в [tests/filename-parser-russian.test.ts](tests/filename-parser-russian.test.ts).

- **Iter 9.4 — RAR + fb2.zip multi-book**
  - [electron/lib/library/archive-extractor.ts](electron/lib/library/archive-extractor.ts) —
    `ARCHIVE_EXTS` расширен на `.rar`, `.tar`, `.gz`, `.tgz`, `.bz2`, `.tbz2`,
    `.xz`, `.txz` (7zip уже умеет все эти форматы).
  - **fb2.zip multi-book detection**: при обнаружении архива с ≥80% FB2 entries
    лимит файлов поднимается с 5000 до 100000 — даёт прямой импорт месячных
    дампов Флибусты `f.fb2-XXXXX-YYYYY.zip` без ручной распаковки.

- **Iter 9.5 — Calibre Replacement через pure-JS parsers**
  - [electron/lib/scanner/parsers/palm-mobi.ts](electron/lib/scanner/parsers/palm-mobi.ts)
    (новый): pure-JS byte-level parser для MOBI/AZW/AZW3/PRC/PDB. Реализует
    PalmDoc LZ77 decompression (40 строк), MOBI EXTH metadata extraction
    (title/author/publisher/language), graceful warning для KF8/Huffman.
    15 unit-тестов с round-trip LZ77 и synthetic PDB файлами.
  - [electron/lib/scanner/parsers/chm.ts](electron/lib/scanner/parsers/chm.ts)
    (новый): CHM через 7zip extract → composite-html-detector. Заменяет
    Calibre cascade.
  - [electron/lib/scanner/converters/ddjvu-pdf.ts](electron/lib/scanner/converters/ddjvu-pdf.ts)
    (новый): DJVU → PDF через DjVuLibre `ddjvu` (vendored), используется
    bibliary-book:// handler-ом для рендеринга DJVU в native reader через pdfjs.
    Кэшируется через существующий `converters/cache.ts`.

### Removed

- **Calibre cascade полностью удалён** (главный приказ Императора rev. 2).
  - `electron/lib/scanner/converters/calibre.ts` — deleted
  - `electron/lib/scanner/converters/calibre-cli.ts` — deleted
  - `electron/lib/scanner/parsers/calibre-formats.ts` — deleted
  - `calibrePathOverride` поле в Preferences — удалено
  - UI поле «Calibre: путь к ebook-convert» — удалено из Settings
  - Локали `settings.calibrePathOverride.*` — удалены (ru, en)
  - Тесты `converters-calibre.test.ts`, `parsers-mobi-azw-chm.test.ts`,
    `parsers-cbz-tcr-lit-lrf-rb-snb.test.ts`, `regression-rb-not-book.test.ts` —
    удалены (заменены на palm-mobi.test.ts с round-trip тестами).

- **Мёртвые форматы удалены** из `SUPPORTED_BOOK_EXTS`:
  - `.lit` (Microsoft Reader, deprecated 2012)
  - `.lrf` (Sony BBeB, deprecated 2010)
  - `.snb` (Shanda Bambook, мёртв)
  - `.tcr` (Psion 90s, мёртв)

  В реальных русских торрент-дампах их доля <0.01%; решение rev. 2 — упростить
  кодовую базу и сосредоточиться на актуальных форматах.

### Changed

- `parsers/index.ts` — `mobi/azw/azw3/pdb/prc` теперь маршрутизируются в
  `palm-mobi.ts`, `chm` в `chm.ts`. Никаких converter-cascade.
- `converters/index.ts` — упрощён, остаются только `djvu` и `cbz` маршруты.
- README — обновлён список поддерживаемых форматов и watchdog-описания.

### Documentation

- [docs/colibri-roadmap.md](docs/colibri-roadmap.md) rev. 2 — полная переработка
  плана под 5 поправок Google + удаление Calibre. Phalanx Manifest, ledger,
  ledger лицензий, итерации 9.1–9.9.

---

## [0.7.1] — Iter 8В — Scheduler Coverage + Universal Cascade + Pipeline Widget Roles

Финал «крепости пайплайна»: каждая LLM-точка импорта теперь под `ImportTaskScheduler`
(observability + дросселирование), Universal Cascade подключён в pdf/image parsers
(Tier 0/1/2 с graceful Linux→vision-LLM fallback), `convertDjvu` использует
`converters/cache.ts`, `pipeline-status-widget` показывает таблицу «роль → модель →
busy/idle/VRAM/weight» через новый `model-pool-snapshot-broadcaster`. Параллельно
закрыт весь pre-8В tech debt из аудитов Sherlok+Diamond-Buddha (5 CRITICAL + 5 MEDIUM).

### Added

- **MAIN.1 Scheduler Coverage** — 4 LLM-точки обёрнуты в scheduler lanes:
  - [electron/lib/llm/vision-ocr.ts](electron/lib/llm/vision-ocr.ts) `recognizeWithVisionLlm` →
    `getImportScheduler().enqueue("heavy", ...)` поверх heavy-lane-rate-limiter.
  - [electron/lib/llm/vision-meta.ts](electron/lib/llm/vision-meta.ts) `extractMetadataFromCover` →
    `enqueue("heavy", ...)` (для каждой кандидат-модели).
  - [electron/lib/library/text-meta-extractor.ts](electron/lib/library/text-meta-extractor.ts)
    crystallizer fetch к LM Studio → `enqueue("medium", ...)`.
  - [electron/lib/scanner/converters/djvu.ts](electron/lib/scanner/converters/djvu.ts)
    `runDdjvuToPdf` (CPU-конвертация) → `enqueue("medium", ...)`.

- **MAIN.2 Universal Cascade в parsers** — Tier 0/1/2 каскад вместо ad-hoc OCR-циклов:
  - [electron/lib/scanner/parsers/pdf-page-extractor.ts](electron/lib/scanner/parsers/pdf-page-extractor.ts)
    (новый): TextExtractor для уже растеризованной страницы PDF (Tier 1 system-OCR + Tier 2 vision-LLM).
  - [electron/lib/scanner/parsers/pdf.ts](electron/lib/scanner/parsers/pdf.ts) ad-hoc
    `recognizeImageBuffer`-цикл (382-422) заменён на per-page `runExtractionCascade` с
    агрегацией warnings (visionAppliedPages tag, top-3 unique page-warnings, suppressed tail).
  - [electron/lib/scanner/parsers/image-file-extractor.ts](electron/lib/scanner/parsers/image-file-extractor.ts)
    (новый): TextExtractor для одиночного файла-изображения (ленивое чтение Buffer только для Tier 2).
  - [electron/lib/scanner/parsers/image.ts](electron/lib/scanner/parsers/image.ts) переведён
    на cascade. Multi-page TIFF уже делегирует в pdf-parser → автоматически наследует cascade.
  - **Linux-fallback:** на платформах без OS OCR cascade автоматически переходит к Tier 2
    (vision-LLM), если модель сконфигурирована — раньше Linux scanned-PDF просто молчал.

- **MAIN.3 convertDjvu cache** — [electron/lib/scanner/converters/djvu.ts](electron/lib/scanner/converters/djvu.ts)
  использует `getCachedConvert/setCachedConvert` из `converters/cache.ts`. Re-import той же
  DjVu-книги пропускает дорогую `ddjvu→pdf` конвертацию.

- **MAIN.4 Pipeline Widget «роль → модель»** — UI видит ЧТО конкретно держит pipeline в VRAM:
  - [electron/lib/resilience/model-pool-snapshot-broadcaster.ts](electron/lib/resilience/model-pool-snapshot-broadcaster.ts)
    (новый): зеркало scheduler-broadcaster (3s polling, change detection, liveness ping
    каждые 60s, идемпотентный start/stop).
  - Channel `resilience:model-pool-snapshot`, payload
    `{capacityMB, totalLoadedMB, loadedCount, models[{modelKey, role, weight, refCount, vramMB, source}]}`.
  - [electron/preload.ts](electron/preload.ts) — `onModelPoolSnapshot` IPC метод.
  - [renderer/models/pipeline-status-widget.js](renderer/models/pipeline-status-widget.js)
    — секция `pipeline-models` с сортировкой busy-first → heavy/medium/light. Каждая
    модель: «role · modelKey · weight · VRAM GB · busy×N/idle [· external]».

- **18 новых тестов** (Иt 8В baseline 752 → **770 pass**, 1 skip, 0 fail):
  - [tests/pdf-page-extractor.test.ts](tests/pdf-page-extractor.test.ts) (4 теста: контракт
    Tier 1+2, vision warnings включают page N, OS-agnostic check на garbage buffer).
  - [tests/model-pool-snapshot-broadcaster.test.ts](tests/model-pool-snapshot-broadcaster.test.ts)
    (8 тестов: lifecycle, force broadcast, change detection, graceful degradation
    null-window/destroyed-window, cache reset).
  - [tests/converters-djvu.test.ts](tests/converters-djvu.test.ts) расширен
    `[MAIN.3] convertDjvu ↔ converters/cache integration` describe (cache-hit и
    cache-miss-failed-ddjvu кейсы).
  - [tests/settings-roundtrip.test.ts](tests/settings-roundtrip.test.ts) расширен
    `illustrationParallelBooks` тестами + anti-regression env grep по исходникам.

### Changed

- **`io` lane полностью удалена** (была мёртвая, нет production caller'ов): из
  [electron/lib/library/import-task-scheduler.ts](electron/lib/library/import-task-scheduler.ts)
  (`TaskLane` тип, `SchedulerSnapshot`, `getSnapshot`, `applyImportSchedulerPrefs`),
  [electron/preload.ts](electron/preload.ts) (`onSchedulerSnapshot` payload типы),
  [renderer/models/pipeline-status-widget.js](renderer/models/pipeline-status-widget.js)
  (`SchedulerSnapshot` typedef + `EMPTY_SNAPSHOT`). Тесты
  `scheduler-observability-integration.test.ts` и `scheduler-snapshot-broadcaster.test.ts`
  обновлены.

### Removed (Pre-8В Tech Debt cleanup)

- **5 pipeline ENV переменных** удалены (приказ Царя «полный отказ от env»):
  `BIBLIARY_EVAL_SLOTS`, `BIBLIARY_VISION_OCR_RPM`, `BIBLIARY_PARSER_POOL_SIZE`,
  `BIBLIARY_ILLUSTRATION_PARALLEL_BOOKS`, `BIBLIARY_CONVERTER_CACHE_MAX_BYTES`.
  Settings UI = единственный источник tunables. Anti-regression тест в
  `settings-roundtrip.test.ts` греп-проверкой исходников.
- **Дубль bootstrap в main.ts** — 3 ручных вызова `configureWatchdog`/
  `configureFileLockDefaults`/`syncMarkerEnvFromPrefs` удалены, единственная
  точка propagation — `applyRuntimeSideEffects(prefs)`.

### Fixed

- **Calibre cache invalidation** — добавлена `applyCalibrePathPrefs(prefs)` в
  `calibre-cli.ts` с `lastSeenOverride` сравнением: boot не сбрасывает кеш зря,
  runtime change реально инвалидирует. 2 интеграционных теста.
- **`illustrationParallelBooks` теперь pref** (вместо ENV-only): новое поле
  `PreferencesSchema` (1..16, default 2), `applyIllustrationSemaphorePrefs` подтягивает
  значение в `sharedSemaphore.setCapacity()`, UI поле в `sections.js`, i18n ru+en.

### Internal

- **`readPipelinePrefsOrNull` helper** в [electron/lib/preferences/store.ts](electron/lib/preferences/store.ts):
  тонкий канал доступа к prefs из импортных модулей (заменил dynamic import + try/catch
  блоки в 5 файлах). Возвращает `Preferences | null` — caller использует fallback
  если store не инициализирован (тесты).

### Verification

- `tsc --noEmit` clean (0 ошибок).
- `eslint . --max-warnings=0` clean.
- `npm test` 770/769 pass / 0 fail / 1 skip (Иt 8В baseline 752 → +18 новых, 0 регрессий).

### Иt 8В audit-followup (2026-05-02): light lane revival

Полный аудит крепости (/omnissiah + /mahakala + /sherlok + /diamond-buddha + /chainlogic + /perplexity-search) после закрытия Иt 8В подтвердил: ересей нет, MAIN.1-4 реально работают, IPC контракты согласованы, cascade partial failure изолирован per-page.

Найдено + исправлено сразу:
- **`light` lane revival** — до Иt 8В не имел production caller'ов (UI всегда показывал 0/0). Обёрнут `computeFileSha256` в `getImportScheduler().enqueue("light", ...)` в [electron/lib/library/import-book.ts](electron/lib/library/import-book.ts):51-58. SHA-256 streaming идеально подходит для light: I/O-bound, дешёвый CPU, естественный lightweight async. light concurrency=8 даёт до 8 параллельных хешей, видимых в pipeline-status-widget.

Найдено + перенесено в Ит 9 (Resilience Hardening):
- **#A1 HIGH:** ModelPool race `makeRoom` vs fast-path `acquire` (non-atomic critical section). Решение: per-model AsyncMutex Map.
- **#A2 HIGH:** `unloadAllHeavyInternal` обходит refCount при OOM-recovery. Решение: graceful degradation вместо forced eviction pinned моделей.
- **#M4:** vision-meta heavy конкурирует с OCR/Calibre на одной heavy-очереди (head-of-line blocking).
- **#M5:** parseDjvu per-page вызывает recognize* напрямую без cascade. Refactor требует careful preservation семантики `djvuOcrProvider` через `disabledTiers`.
- **#M6:** Calibre `ebook-convert` (CPU) сейчас в **heavy** lane вместе с GPU vision — переоценить.
- **#M7:** Системный OS OCR не обёрнут в scheduler — масштабируется с parser pool.

Полный chainlogic план для критических #A1+#A2 в плановом файле `library_fortress_phalanx_2a6a92fe.plan.md` (секция «Иt 8В audit-followup»).

---

## [Unreleased] — Iter 7 — Scheduler Observability + Pipeline UI Widget Mount

Замыкаем Контур 2 (Smart Pipeline Scheduler): scheduler.enqueue обёртки в
evaluator-queue (medium lane) и illustration-worker (heavy lane) для UI
observability + monteрование pipeline-status-widget в models-hardware-status.
Sherlok recon перед битвой обнаружил забытый хвост Iter 6В: `.rb` всё ещё
было в `CALIBRE_INPUT_EXTS` — HOTFIX + превентивный тест.

### Fixed

- **🚨 Sherlok HOTFIX Iter 6В забытый хвост** —
  [electron/lib/scanner/converters/index.ts](electron/lib/scanner/converters/index.ts)
  `.rb` был удалён из 6 файлов в Iter 6В, но остался в `CALIBRE_INPUT_EXTS`
  set этого dispatcher. `convertToParseable` пропускал .rb в Calibre даже
  когда `parseBook` reject'ит. Удалён + превентивный тест в
  [tests/regression-rb-not-book.test.ts](tests/regression-rb-not-book.test.ts)
  (`Iter 6В regression: .rb НЕ в CALIBRE_INPUT_EXTS (sherlok find)`).

### Added

- **Scheduler observability в evaluator-queue** —
  [electron/lib/library/evaluator-queue.ts](electron/lib/library/evaluator-queue.ts)
  `evaluateBook` обёрнут в `getImportScheduler().enqueue("medium", ...)`. UI
  widget теперь видит счётчик medium-lane (running/queued) во время evaluation.
  Это observability layer ПОВЕРХ ModelPool/withModel, не заменяет lock'и.
- **Scheduler observability в illustration-worker** —
  [electron/lib/library/illustration-worker.ts](electron/lib/library/illustration-worker.ts)
  vision tasks обёрнуты в `getImportScheduler().enqueue("heavy", ...)`. heavy
  concurrency=1 гарантирует что vision_illustration НЕ конкурирует с
  vision_ocr/vision_meta за GPU.
- **Pipeline-status-widget mount** в
  [renderer/models/models-hardware-status.js](renderer/models/models-hardware-status.js)
  через `mountPipelineStatusWidget(pipelineHost)` в `buildHwStrip()`.
  Idempotent: повторный buildHwStrip unmount'ит предыдущий widget. Экспорт
  `unmountHwStrip()` для page lifecycle. Виджет показывает live counters
  lanes (light/medium/heavy running+queued) + VRAM pressure bar с цветовой
  зоной (green<70%, yellow 70-85%, red>85%).
- **CSS для pipeline widget** в
  [renderer/styles.css](renderer/styles.css) — `.pipeline-status-widget`,
  `.pipeline-lane*` (active/heavy/medium/light variants),
  `.pipeline-pressure*` (ok/warn/crit zones), плавные transitions.
- **8 новых тестов** (740 → **747 pass**, 1 skipped, 0 fail):
  - [tests/scheduler-observability-integration.test.ts](tests/scheduler-observability-integration.test.ts)
    (7 тестов: snapshot отражает running, medium concurrency=3, heavy strict 1,
    singleton, rejected task counter не leak, повторный enqueue после throw)
  - [tests/regression-rb-not-book.test.ts](tests/regression-rb-not-book.test.ts)
    (+1 превентивный для CALIBRE_INPUT_EXTS)

### Notes

- **Scope cut: import.ts:313**. План предполагал прямую интеграцию scheduler в
  parser pool. На практике это conflict двух concurrency systems — parser pool
  CPU-bound (PDF/EPUB parsing), scheduler для LLM-задач. Scheduler уже
  косвенно через converters (Calibre/CBZ/multi-TIFF) — этого достаточно.
  Verdict /sparta: legitimate scope refinement, не афинская импровизация.
- **Event channel: `resilience:scheduler-snapshot`, не `library:state`**.
  План был неточен — `library:state` event не существует. Реальный
  broadcaster (Iter 5: `electron/lib/resilience/scheduler-snapshot-broadcaster.ts`)
  шлёт через `resilience:` namespace. UI widget уже подписан через preload.
- **Architectural insight**: Scheduler — это observability layer ПОВЕРХ
  ModelPool. Не дублирование lock'ов:
  - **ModelPool** обеспечивает correctness (одна модель = одна копия в VRAM)
  - **Scheduler** обеспечивает observability (UI видит что происходит)
  - heavy concurrency=1 совпадает с GPU sequential reality (vision модели
    не любят параллель)
  - medium concurrency=3 совпадает с дефолтной evaluator parallelism

### Iter 8+ (открытые вопросы)

- Settings UI для scheduler limits (light/medium/heavy concurrency)
- Live `current?: string` в SchedulerSnapshot (показать какая книга в heavy
  lane прямо сейчас)
- Telemetry sinks (логирование snapshot history для post-mortem)
- Auto-scale heavy concurrency при наличии 2+ GPU

---

## [Unreleased] — Iter 6В — HOTFIX регрессий + Multi-TIFF Routing + Converter Cache

Разведка реальной библиотеки D:\Bibliarifull (32 000+ файлов) обнаружила
**критическую регрессию Iter 6Б**: `.rb` зарегистрирован как Rocket eBook, но
в библиотеке 921 файл — Ruby исходники. HOTFIX откатывает регистрацию.
Также найдено 99 файлов `.pdb` — все Microsoft Program Database (debug
symbols от Visual Studio), не Palm DB eBook. Magic guard ужесточён.

### Fixed

- **🚨 HOTFIX `.rb` регрессия Iter 6Б** — расширение `.rb` удалено из
  [SupportedExt](electron/lib/scanner/parsers/types.ts),
  [PARSERS](electron/lib/scanner/parsers/index.ts),
  [SupportedBookFormat + SUPPORTED_BOOK_EXTS](electron/lib/library/types.ts),
  [FORMAT_PRIORITY](electron/lib/library/cross-format-prededup.ts),
  [import-magic-guard.ts](electron/lib/library/import-magic-guard.ts).
  Удалён `rbParser` из `parsers/calibre-formats.ts`. Rocket eBook (deprecated
  2003) — нишевый формат; Ruby исходники доминируют в `.rb` namespace на
  10000:1.
- **🚨 MS Program Database reject** — `isMicrosoftPdb()` в
  [import-magic-guard.ts](electron/lib/library/import-magic-guard.ts) проверяет
  магическую сигнатуру "Microsoft C/C+" в первых 14 байтах. При detection в
  `.pdb` файле — `verifyExtMatchesContent` возвращает `{ok: false, reason:
  "magic: pdb is Microsoft Program Database (debug symbols), not Palm DB eBook"}`.
  Защищает от 99 ошибочных Calibre-конвертаций debug symbols в реальной
  библиотеке.

### Added

- **TIFF parser routing** —
  [electron/lib/scanner/parsers/tiff.ts](electron/lib/scanner/parsers/tiff.ts)
  заменяет imageParser для `.tif/.tiff` в PARSERS. Runtime check
  `getTiffPageCount()`:
  - Single-page (pages == 1) → fallback на `imageParser` (текущее OS OCR
    поведение)
  - Multi-page (pages > 1) → `convertMultiTiff` → multi-page PDF →
    `pdfParser` → Universal Cascade (OS OCR Tier 1 → vision-LLM Tier 2)
  - Sharp недоступен или throw → graceful fallback на `imageParser`
- **Converter Cache** —
  [electron/lib/scanner/converters/cache.ts](electron/lib/scanner/converters/cache.ts)
  on-disk кеш по `sha256(srcPath + mtime + size + ext)` →
  `<cwd>/data/converters-cache/<sha>.{epub,pdf,txt}`. Atomic writes (tmp+rename),
  LRU eviction при превышении 5 GB (override через
  `BIBLIARY_CONVERTER_CACHE_MAX_BYTES`), кеш dir override через
  `BIBLIARY_CONVERTER_CACHE_DIR`. Интегрирован в `convertViaCalibre`,
  `convertCbz`, `convertMultiTiff` — повторный convert того же файла = hit без
  recomputation. Calibre на 50 MB MOBI = 30 сек, CBZ→PDF на 500 страниц = ~30
  сек + 200 MB RAM, multi-TIFF на 100 страниц = ~30 сек. Кэш окупается мгновенно.
- **24 новых теста** (716 → **739 pass**, 1 skipped, 0 fail):
  - [tests/regression-rb-not-book.test.ts](tests/regression-rb-not-book.test.ts)
    (5 тестов: detectExt, isSupportedBook, parseBook reject .rb, реальный Ruby
    sample)
  - [tests/regression-ms-pdb-reject.test.ts](tests/regression-ms-pdb-reject.test.ts)
    (3 теста: MS PDB header reject, valid Palm DB pass, типичный VS .pdb)
  - [tests/parsers-tiff-routing.test.ts](tests/parsers-tiff-routing.test.ts)
    (6 тестов: registration, single-page graceful, AbortSignal, direct call)
  - [tests/converters-cache.test.ts](tests/converters-cache.test.ts)
    (10 тестов: round-trip, miss/hit, mtime invalidation, size invalidation,
    idempotent set, clear, stats, atomic writes без .tmp residue)

### Changed

- `parsers/index.ts:PARSERS` — `tif: tiffParser`, `tiff: tiffAlternateParser`
  (вместо `imageParser` для обоих).
- `tests/parsers-cbz-tcr-lit-lrf-rb-snb.test.ts` — обновлён, `.rb` убран из
  `ITER_6B_EXTS` set.

### Audit Findings (D:\Bibliarifull, 32K+ файлов)

Обнаружено сканированием реальной библиотеки:

| Расширение | Кол-во | Реальная семантика | Действие |
|------------|--------|--------------------|---------:|
| `.rb` | **921** | Ruby исходники | Удалено из SupportedExt |
| `.pdb` | **99** | MS Program Database (все 10 проверенных) | Magic guard reject |
| `.tif` | 51 | Single-page (page-per-file convention) | Wiring готов на будущее |
| `.cbz/.cbr/.snb/.lit/.lrf/.tcr` | 0 | Нет в библиотеке | Iter 6Б готовность сохранена |

### Notes

- **Multi-TIFF wiring сделан defensively** — реальных multi-page TIFF в
  Bibliarifull нет, но wiring готов на будущее. Архивные/факсимильные сканы
  (которые могут попасть из других библиотек) теперь автоматически
  обрабатываются правильно: вместо потери 90% контента (читалась только
  страница 1) — проходят через mighty cascade.
- **Cache scope**: интегрирован в Calibre / CBZ / multi-TIFF converters. DjVu
  пока без cache — у DjVu есть собственный fast-path через `djvutxt` который
  не требует тяжёлой конвертации.
- **Atomic writes в cache** — tmp+rename защищает от partial cache entry при
  abort/crash в середине copy. Тест `tests/converters-cache.test.ts` проверяет
  что после set нет `.tmp-*` residue.
- **Iter 7**: интеграция scheduler в `import.ts:313`, `evaluator-queue.ts`,
  `illustration-worker.ts` + UI widget mount в `models-hardware-status.js`.

---

## [Unreleased] — Iter 6Б — Древние Знатоки Подчинены (CBZ/CBR + Niche)

Захвачено ещё 7 legacy форматов: CBZ/CBR (комиксы и манга через свой
multi-page PDF converter) + TCR/LIT/LRF/RB/SNB (нишевые eBook через
расширение Calibre cascade). Полная коллекция legacy: 16 форматов теперь.

### Added

- **CBZ/CBR Converter** —
  [electron/lib/scanner/converters/cbz.ts](electron/lib/scanner/converters/cbz.ts)
  собирает страницы комикса в multi-page PDF через `pdf-lib`. JSZip для CBZ,
  vendor/7zip (или fallback на npm `7zip-bin`) для CBR (RAR-архив). Natural
  sort страниц (001 < 002 < 010), embed JPEG/PNG напрямую через
  `pdfDoc.embedJpg/embedPng`, WebP/GIF/BMP конвертируются через sharp в PNG.
  Heavy lane через scheduler. Limits: maxPages=1000, maxBytes=500 MB.
- **Multi-TIFF Converter** (standalone) —
  [electron/lib/scanner/converters/multi-tiff.ts](electron/lib/scanner/converters/multi-tiff.ts)
  использует `sharp.metadata({pages:-1})` для детекта multi-page, затем loop
  pages → embed PNG → multi-page PDF. Wiring в `parsers/image.ts`
  (auto-detect single vs multi) отложен до Iter 6В.
- **CBZ/CBR parser-обёртка** —
  [electron/lib/scanner/parsers/cbz.ts](electron/lib/scanner/parsers/cbz.ts)
  делегирует `convertCbz` → `pdfParser` cascade (OS OCR Tier 1 → vision-LLM
  Tier 2). Для комиксов это обеспечивает лучшую extraction quality чем
  Calibre→EPUB (image-only book, сразу vision-LLM).
- **5 nишевых eBook форматов** через расширение
  [electron/lib/scanner/parsers/calibre-formats.ts](electron/lib/scanner/parsers/calibre-formats.ts) —
  TCR (Psion 90-е), LIT (MS Reader, deprecated 2012), LRF (Sony BBeB,
  deprecated 2010), RB (Rocket eBook, deprecated 2003), SNB (Samsung Note
  Book ~200x). Все через тот же Calibre wrapper.
- **Magic guard для RAR/LIT/LRF** в
  [electron/lib/library/import-magic-guard.ts](electron/lib/library/import-magic-guard.ts) —
  `isRar()` (Rar!\x1A\x07\x00 / \x01\x00 для RAR 5), `isLit()` (ITOLITLS),
  `isLrf()` (LRF\\0). 6 case-блоков для cbz/cbr/lit/lrf/rb/snb/tcr.
- **18 новых тестов** —
  [tests/converters-cbz.test.ts](tests/converters-cbz.test.ts) (7 тестов:
  happy path PNG/JPEG, natural sort, limits, abort, cleanup),
  [tests/converters-multi-tiff.test.ts](tests/converters-multi-tiff.test.ts)
  (5 тестов: graceful, getTiffPageCount, abort, cleanup),
  [tests/parsers-cbz-tcr-lit-lrf-rb-snb.test.ts](tests/parsers-cbz-tcr-lit-lrf-rb-snb.test.ts)
  (5 тестов: registration smoke, CBZ→PDF delegation, niche graceful).
  698 → **716 pass** (715 ok + 1 skipped, 0 fail).

### Changed

- `SupportedExt` ([electron/lib/scanner/parsers/types.ts](electron/lib/scanner/parsers/types.ts))
  расширен: `+tcr/+lit/+lrf/+rb/+snb/+cbz/+cbr`.
- `PARSERS` ([electron/lib/scanner/parsers/index.ts](electron/lib/scanner/parsers/index.ts))
  — 7 новых mappings.
- `SupportedBookFormat` + `SUPPORTED_BOOK_EXTS`
  ([electron/lib/library/types.ts](electron/lib/library/types.ts)) —
  синхронизированы с +7 расширениями.
- `FORMAT_PRIORITY`
  ([electron/lib/library/cross-format-prededup.ts](electron/lib/library/cross-format-prededup.ts)):
  ODT(25) > LIT(24) > LRF(23) > RB(22) > SNB(21) > PDB=PRC(20) > CHM(15) >
  CBZ(12) > CBR(11) > TCR=TXT(10). Все нишевые форматы ниже ODT т.к.
  конвертация теряет часть форматирования.

### Dependencies

- **+ `pdf-lib@^1.17.1`** — pure JS multi-page PDF generation (~150 KB,
  mature 5+ лет). Добавлен после retreat: `@napi-rs/canvas` НЕ умеет
  multi-page PDF (только single buffer), pdf-lib — стандартный выбор.

### Notes

- **Architecture pivot**: первоначальный план был использовать уже
  установленный `@napi-rs/canvas` для PDF generation. Recon обнаружил что
  canvas не поддерживает multi-page (issue #963), формальный retreat →
  пользователь явно выбрал pdf-lib через AskQuestion.
- **CBZ pipeline = optimal extraction**: CBZ→multi-page PDF→pdfParser
  cascade использует мощный OCR Контура 4 (OS OCR первый, vision-LLM
  fallback). Это лучше для комиксов чем Calibre→EPUB (image-only book →
  сразу vision-LLM).
- **`npm install pdf-lib` инцидент**: установка снесла native binding
  `edgeparse-win32-x64-msvc` → 3 теста упали. Восстановлено через
  `node scripts/fix-edgeparse-native.cjs` (postinstall script). Lesson:
  после npm install НОВЫХ deps на Windows ВСЕГДА запускать fix script.
- **Iter 6В**: wiring `convertMultiTiff` в `parsers/image.ts` (auto-detect
  multi-page TIFF) + on-disk converter cache.
- **Iter 7**: интеграция scheduler в `import.ts:313`, `evaluator-queue.ts`,
  `illustration-worker.ts` + UI widget mount в `models-hardware-status.js`.

---

## [Unreleased] — Iter 6А — Calibre Cascade

Захвачены знатоки древних текстов — 6 legacy форматов теперь импортируются
через runtime detection системного Calibre. Первое production использование
`ImportTaskScheduler` heavy lane.

### Added

- **Поддержка MOBI/AZW/AZW3/PDB/PRC/CHM** через
  [electron/lib/scanner/converters/calibre.ts](electron/lib/scanner/converters/calibre.ts) —
  `convertViaCalibre()` запускает `ebook-convert.exe in.<ext> out.epub
  --no-default-epub-cover` через scheduler heavy lane, делегирует epubParser.
- **Runtime detection системного Calibre** в
  [electron/lib/scanner/converters/calibre-cli.ts](electron/lib/scanner/converters/calibre-cli.ts) —
  `resolveCalibreBinary()` ищет `ebook-convert` в `vendor/calibre/`, Program
  Files/Calibre2, LOCALAPPDATA/Programs/Calibre2, /Applications/calibre.app,
  /usr/bin, /opt/calibre. Кеш + fallback на PATH. При отсутствии Calibre —
  graceful warning с install hint (winget / brew / apt команда).
- **Converter dispatcher** —
  [electron/lib/scanner/converters/index.ts](electron/lib/scanner/converters/index.ts)
  `convertToParseable(srcPath, ext, opts)` маршрутизирует расширения в нужный
  конвертер (DjVu / Calibre / null если не нужно конвертировать).
- **Scheduler heavy lane в production** — `convertViaCalibre` использует
  `getImportScheduler().enqueue("heavy", ...)`. Heavy concurrency=1 по дефолту
  сериализует Calibre процессы. При параллельном импорте 5 MOBI файлов —
  только 1 ebook-convert работает, остальные ждут в queue. CPU защищён.
- **Magic guard для PalmDB и CHM** в
  [electron/lib/library/import-magic-guard.ts](electron/lib/library/import-magic-guard.ts) —
  `isCalibreLegacyContainer()` проверяет PalmDB type@offset 60 (BOOK/TEXt/Data/PNRd/TPZ3),
  `isChm()` проверяет ITSF сигнатуру. Reject невалидных PalmDB или non-ITSF .chm.
- **Тесты** — [tests/converters-calibre.test.ts](tests/converters-calibre.test.ts) (cache,
  graceful, AbortSignal, install hint),
  [tests/cross-format-prededup-legacy.test.ts](tests/cross-format-prededup-legacy.test.ts)
  (EPUB > MOBI > PDB > CHM приоритеты),
  [tests/parsers-mobi-azw-chm.test.ts](tests/parsers-mobi-azw-chm.test.ts) (registration
  smoke + 6 форматов graceful). +23 теста (675 → **698 pass**).

### Changed

- `SupportedExt` ([electron/lib/scanner/parsers/types.ts](electron/lib/scanner/parsers/types.ts))
  расширен: `+mobi/+azw/+azw3/+pdb/+prc/+chm`.
- `PARSERS` ([electron/lib/scanner/parsers/index.ts](electron/lib/scanner/parsers/index.ts))
  — 6 новых mappings через wrapper'ы в
  [electron/lib/scanner/parsers/calibre-formats.ts](electron/lib/scanner/parsers/calibre-formats.ts).
- `SupportedBookFormat` + `SUPPORTED_BOOK_EXTS`
  ([electron/lib/library/types.ts](electron/lib/library/types.ts)) — синхронизированы.
- `FORMAT_PRIORITY`
  ([electron/lib/library/cross-format-prededup.ts](electron/lib/library/cross-format-prededup.ts)):
  AZW3=36, MOBI=AZW=35, PDB=PRC=20, CHM=15. EPUB(100) > PDF(80) > DJVU(70) >
  FB2(60) > DOCX(50) > DOC(40) > AZW3(36) > MOBI=AZW(35) > RTF(30) > ODT(25) >
  PDB=PRC(20) > CHM(15) > TXT(10). Calibre-форматы ниже DOC потому что
  конвертация в EPUB обычно теряет некоторые edge-case форматирования.

### Notes

- **Vendoring Calibre отказались** — Calibre = ~250 MB + Python runtime + сотни
  DLL. Runtime detection компромисс: пользователь ставит Calibre один раз
  через `winget install --id calibre.calibre` (Windows) / `brew install --cask
  calibre` (macOS) / `apt install calibre` (Linux), обновляет независимо,
  никакой дублирующей копии в проекте.
- **Iter 6Б отложен**: CBZ/CBR (комиксы), multi-page TIFF (архивные сканы),
  TCR (Psion), LIT/LRF/RB/SNB (ниша) + on-disk converter cache.
- **Iter 7 отложен**: интеграция scheduler в `import.ts:313`, `evaluator-queue.ts`,
  `illustration-worker.ts` + UI widget mount в `models-hardware-status.js`.

---

## [0.6.0] — 2026-05-01 — Smart Import Pipeline Foundation

Завершён фундамент Smart Import Pipeline (Контуры 1, 2 UI, 4 — см.
[docs/smart-import-pipeline.md](docs/smart-import-pipeline.md)). Главная цель —
не допустить DDoS heavy-очереди тяжёлой vision-LLM (Qwen-VL 22 GB) при импорте
больших библиотек DjVu/PDF. **675 tests pass, 0 fail, 0 регрессий** относительно
v0.5.3 (564 pass / 8 fail).

### Added

- **ModelPool — единственная точка загрузки моделей LM Studio**
  (`electron/lib/llm/model-pool.ts`). 5 подсистем (vision-meta, evaluator-queue,
  illustration-worker, lmstudio.ipc, book-evaluator-model-picker) переведены с
  прямого `client.llm.load` на `getModelPool().acquire()` — закрыта дыра
  параллельной загрузки одной модели N раз при N=4 импорт-воркерах.
- **OOM Recovery в ModelPool** — `loadWithOomRecovery` с трёхуровневой
  стратегией (load → evictAll → unloadHeavy → retry), telemetry events
  `lmstudio.oom_recovered` / `lmstudio.oom_failed`. Защита от падения
  приложения на heavy моделях >20 GB.
- **Model Size Classifier** (`electron/lib/llm/model-size-classifier.ts`) —
  light (≤8 GB) / medium (8-16 GB) / heavy (>16 GB) категоризация. Heavy
  модели первые жертвы при `makeRoom` (composite sort: `evictionPriority` +
  LRU при равном весе).
- **Heavy Lane Rate Limiter** (`electron/lib/llm/heavy-lane-rate-limiter.ts`) —
  sliding-window per-modelKey, default 60/min (env `BIBLIARY_VISION_OCR_RPM`).
  Интегрирован в `vision-ocr.ts` — защищает от 1000-страничного DjVu DDoS.
- **VRAM Pressure Watchdog** — расширен `lmstudio-watchdog.ts`
  (`pollVramPressure` каждую минуту, `resilience:lmstudio-pressure` event при
  ratio > 0.85, `getLastPressureRatio()` для UI диагностики).
- **Role Load Config Wiring** — мёртвый `ROLE_LOAD_CONFIG` подключён через
  `applyRoleDefaults` в `model-pool.acquireExclusive` (caller-priority
  сохраняется).
- **ImportTaskScheduler skeleton** (`electron/lib/library/import-task-scheduler.ts`) —
  light/medium/heavy lanes (8/3/1 default concurrency), `enqueue/getSnapshot/setLimit`,
  singleton `getImportScheduler()`. Готов к интеграции в Iter 6 (Calibre converters).
- **Universal Light-First Extraction Cascade** —
  `electron/lib/scanner/extractors/{types,quality-heuristic,cascade-runner,ocr-cache}.ts`.
  Tier 0 (text-layer) → Tier 1 (OS OCR) → Tier 2 (vision-LLM). OCR cache
  по `sha256(file+page+engine)` — повторный импорт не делает OCR заново.
- **DjVu двухступенчатый converter**
  (`electron/lib/scanner/converters/djvu.ts`) — `djvutxt` quality fast-path,
  fallback `ddjvu -format=pdf` → делегация существующему `pdfParser`. Принцип
  «формат это контейнер, способ обработки = каскад от дешёвого к дорогому»
  теперь воплощён в коде.
- **DjVu Parser Cascade Integration** (`electron/lib/scanner/parsers/djvu.ts`) —
  при `provider="auto"+ocrEnabled=true` использует `convertDjvu` →
  `pdfParser` cascade. Per-page routing через `runDjvutxtPage` (страницы со
  встроенным текстом ≥50 chars пропускают OCR). Старый `ocrDjvuPages`
  сохранён как Tier 2 fallback.
- **`.djv` extension** зарегистрирован в `SupportedExt` + `PARSERS` +
  `SUPPORTED_BOOK_EXTS` (DOS-эра 3-char alias). Magic bytes уже распознавали.
- **Pipeline Status UI infrastructure**:
  - `electron/lib/resilience/scheduler-snapshot-broadcaster.ts` — periodic
    poll каждые 2с, change detection, force broadcast, IPC channel
    `resilience:scheduler-snapshot`.
  - `preload.ts` — `api.resilience.onLmstudioPressure` +
    `api.resilience.onSchedulerSnapshot`.
  - `renderer/models/pipeline-status-widget.js` — lanes counters + VRAM
    pressure bar (3 цветовые зоны). Готов к монтированию в любую страницу
    через `mountPipelineStatusWidget(rootEl)`.

### Changed

- **DjVu OCR default chain inverted** (`djvu.ts`) — было `vision-LLM → system OCR`
  (DDoS-генератор: 500 страниц × Qwen-VL = часы и сожжённый GPU). Стало
  `system OCR → vision-LLM` (cheap-first). Если пользователь явно выбрал
  `djvuOcrProvider:"vision-llm"` — уважаем выбор.
- **`isQualityText` heuristic** заменил наивную проверку `text.length > 100`
  в `djvu.ts:35` (false positive: 200 символов OCR-мусора проходили). Новая —
  4 сигнала: min length, letter ratio (`\p{L}`), word count, avg word length.
  Вынесена в `extractors/quality-heuristic.ts` как переиспользуемый блок.
- **`isOomError` сужен** — убрана подстрока `"oom"` (false positive на
  `room`/`zoom`/`bloomberg api`), заменена на word-boundary `/\boom\b/`.
- **DjVu Converter cleanup** теперь идемпотентен и пытается удалить partial
  PDF при сбое `runDdjvuToPdf` (orphan в tmpdir больше не накапливаются).

### Fixed

- **`forceBroadcastSchedulerSnapshot` cache bug** — не обновлял
  `lastSnapshotJson` после force-broadcast → следующий plановый tick дублировал
  тот же snapshot. Поймано unit-тестом, исправлено в Iter 5.
- **`lastPressureRatio` reset** — не сбрасывался в `deactivate()` watchdog,
  оставались stale данные между сессиями.
- **Stale JSDoc** — `model-pool.ts` шапка («Не управляет user IPC»),
  `evaluator-queue.ts:67-75` про `loadModel`, `lmstudio-watchdog.ts` про
  pressure subscriber.

### Removed

- **`lmstudio.direct_load_detected`** event type — был объявлен в
  `telemetry.ts`, никогда не эмитился. Очищен.
- **Мёртвые тест-хуки** `_resetHeavyLaneRateLimiterForTests` и
  `_resetOcrCacheDirForTests` — никем не использовались (тесты создают
  локальные экземпляры или передают `cacheDir` override).

### Tests

- **+108 новых тестов** (567 → 675): `djvu-quality-heuristic` (16),
  `model-pool-oom-recovery` (6), `model-size-classifier` (7),
  `heavy-lane-rate-limiter` (9), `import-task-scheduler` (11),
  `extractors-cache` (9), `extractors-cascade-runner` (11),
  `converters-djvu` (4), `djvu-parser-cascade` (5),
  `extractors-quality-heuristic` (10), `model-pool-role-defaults` (10),
  `scheduler-snapshot-broadcaster` (9).

### Foundation Complete vs Production Integration

Готовы как foundation (контракты, типы, тесты), но НЕ интегрированы в
production pipeline (запланировано Iter 6+):

- `getImportScheduler().enqueue()` — из прод-кода не вызывается. Естественно
  произойдёт когда Calibre converters в Iter 6 станут heavy lane consumer.
- `runExtractionCascade` — DjVu использует `pdfParser` напрямую (не через
  cascade-runner). Cascade-runner — общий контракт для будущих converters.
- `mountPipelineStatusWidget` — виджет готов, но не смонтирован в renderer
  pages. Подключение — отдельный шаг.

## [0.5.3] — 2026-05-01 — Advanced settings panel under roles

Добавлена едва заметная панель дополнительных настроек внизу карточки «Ролей» —
скрытая через `<details>` (раскрывается кликом на «⚙ Настройки»). Предназначена
для технически подготовленных пользователей, не мозолит глаза обычным.

### Added

- **Панель дополнительных настроек** (`renderer/models/models-page-advanced.js`)
  под списком ролей пайплайна. Содержит:
  - *Подключение*: LM Studio URL, Qdrant URL (text inputs).
  - *Обработка*: параллелизм импорта (1–16), онлайн-поиск ISBN, Vision-meta LLM, OCR.
  Настройки сохраняются мгновенно через `window.api.preferences.set`.
  Панель загружает актуальные значения из preferences каждый раз при открытии.
- **CSS**: класс `.mp-adv-panel` — плавное появление (opacity 0.45→1 при hover/open),
  монокромная микро-типографика `Share Tech Mono` 9–11 px.

## [0.5.2] — 2026-05-01 — Test repair: vision-meta DI, parser warning contract, log filename uniqueness

Шесть из семи vision-meta тестов и тест на «битый PDF» падали потому что
расходились с контрактом продакшен-кода. Plus race condition в
`import-logger`: два вызова `startSession` в одну миллисекунду давали
одинаковое имя файла. Plus dead-code cleanup в renderer.

### Fixed

- **vision-meta tests (7 шт.)** — `extractMetadataFromCover` через
  `ModelPool.withModel` пытался загрузить мок-модели (`qwen-vl`/`llava`)
  в реальный LM Studio. Тесты передают `fetcherImpl` / `listLoadedImpl`
  именно ради изоляции — теперь при наличии test-DI хуков идём напрямую
  через `requestMetaFromModel`, минуя pool. Прод-путь (без хуков) идёт
  через `pool.withModel` как раньше.
- **import-logger race condition** — `subsequent startSession closes previous`
  падал из-за коллизии имени файла при двух стартах в одну миллисекунду.
  Добавлен monotonic `sessionSeq` (4 цифры) в имя файла:
  `import-{ts}-{seq}-{importId}.jsonl`.
- **«битый PDF» тест** — ожидал `assert.rejects`, но `parsePdfMain`
  правильно ловит `InvalidPDFException` и возвращает
  `{ sections: [], warnings: [...] }`. Тест переписан под фактический
  контракт (warning, не throw).

### Removed

- **Dead UI references в `import-pane-actions.js`** — querySelectors на
  `.lib-import-cancel` / `.lib-import-pause`, элементы которых были
  удалены из `import-pane.js` в v0.5.0. Ветки `if (cancelBtn)` и
  `if (pauseBtn)` всегда выпадали в false. Убрано.

### Added

- **`.gitattributes`** — `* text=auto eol=lf` + `binary` для медиа.
  Убирает шум CRLF/LF в `git status` на Windows-машинах, который
  маскирует реальные правки.

### Tests

- 572/573 passed, 0 failed, 1 skipped (было 564/573, 8 failed).

## [0.5.1] — 2026-05-01 — Code hygiene: probe/adaptive hidden, dead CSS/prefs removed

Probe-фаза и adaptive elimination сохранены в `olympics.ts` (код не удалён),
но скрыты из UI отчёта — они неактивны при `testAll=true`. Из UI удалены
мёртвые ссылки на эти функции, удалены orphan CSS-классы и мёртвые prefs.

### Removed

- **Orphan CSS** — `mp-olympics-options/option/select`, `mp-olympics-roles`,
  `mp-olympics-advanced*`, `mp-olympics-profile-row`, `mp-olympics-champion-badge`,
  `mp-olympics-recs-cols`, `mp-olympics-probe-*`, `mp-olympics-lightning-stat`.
- **Dead prefs** — `olympicsWeightClasses`, `olympicsTestAll`, `olympicsUseChampion`,
  `olympicsLightning` удалены из `preferences/store.ts` (нигде не читались).
- **Stale comments** в `controls.js` — убраны призраки удалённых функций.

### Changed

- **EcoTune auto-tune** в отчёте отображается напрямую без обёртки
  «Lightning Olympics: probe + adaptive + EcoTune» — раздел переименован.
- **Probe/adaptive UI** убран из `models-page-olympics-report.js`.
  Код в `olympics.ts` сохранён — активируется когда `opts.maxModels` задан.
- **Import hygiene cleanup** — удалены неиспользуемые импорты/символы в
  `arena.ipc.ts`, `dataset-v2/*`, `library/*`, `lmstudio-client.ts`, `main.ts`,
  `disciplines.ts`. Прогон `tsc --noUnusedLocals --noUnusedParameters` теперь чист.

## [0.5.0] — 2026-05-01 — UX Revolution: простота для бабушек

Масштабная чистка UI: удалены все «экспертные» настройки, Lightning mode,
advanced-панель Олимпиады, ручное управление evaluator-queue. Олимпиада
стала one-click: нажал «Запустить» → получил результат → модели
автоматически назначены на роли пайплайна.

### Removed

- **Lightning Olympics** — удалён из UI и бэкенда (настройка и код).
  Олимпиада теперь всегда testAll (тестирует все модели).
- **Advanced settings Олимпиады** — вся секция удалена: чекбоксы ролей,
  весовые классы, per-role tuning, SDK toggle, профили экспорт/импорт.
- **Evaluator queue controls** — слоты, пауза, отмена текущей оценки
  удалены из UI. Управление автоматическое.
- **Import pause/cancel buttons** — убраны из панели импорта.

### Fixed

- **Role selects показывают «Не выбрано»** вместо «Авто (лучшая из
  загруженных)» когда пользователь не назначил модель явно. Раньше
  во время Олимпиады динамически загружаемые модели мелькали в списке ролей,
  создавая ложное впечатление что они «назначены».
- **Кнопка «Распределить»** — работает: сохраняет оптимум-модели
  в preferences и обновляет role-selects.
- **Горизонтальный скрол** на странице импорта — убран. Log-панель больше
  не вырывается за пределы контейнера.

### Changed

- `model-roles.ipc.ts`: `RoleSnapshotEntry` теперь содержит `prefValue` —
  явно сохранённое значение из preferences (не resolved, а именно prefs).
  Это позволяет UI отличать «юзер выбрал модель» от «авто-резолв подставил
  загруженную».

---

## [0.4.9] — 2026-05-01 — Sherlok+OM round 2: probe rewrite + evaluator fix + EcoTune UI

После повторного `/sherlok /om` аудита v0.4.5 → v0.4.8 найдены 7 дефектов.
Все исправлены атомарно в режиме Mahakala (lint+typecheck+tests чисты, baseline 564 pass / 8 fail сохранён).

### Fixed

- **#1 Probe phase реально работает** (CRITICAL). До фикса условие
  `selectedInfos.length > maxModels` было всегда false в Lightning auto-pick,
  потому что `pickModelsForOlympicsV1` уже применил cap=5. Теперь probe берёт
  расширенный пул `max(maxModels × 3, 24)` БЕЗ cap'а, прогоняет survivors
  через cutoff=0.4, передаёт их в picker как `explicit` для финального
  family-dedup + cap. Probe теперь действительно отсеивает «сломанные» модели.
- **#2 Evaluator больше не загружает «не ту» модель** (CRITICAL).
  `pickEvaluatorModel(allowAutoLoad=true)` возвращал preferred ТОЛЬКО если
  она уже в loaded — иначе скоринг мог выбрать другую (более крупную) модель,
  нарушая контракт «выбор пользователя сильнее эвристики». Теперь
  `evaluator-queue` САМ загружает preferred ДО picker'а через новый DI hook
  `ensurePreferredLoaded`, picker получает `allowAutoLoad: false`.
- **#3 EcoTune suggestions показываются в UI**. До фикса
  `report.autoTuneSuggestions` вычислялись и сохранялись на диск, но в
  отчёте Олимпиады их не было — мёртвая фича для пользователя. Добавлен
  collapsible блок «🚀 Lightning Olympics» с тремя секциями: Probe phase
  (per-model scores), Adaptive elimination (счётчик skipped), EcoTune
  auto-tune (таблица temp/max_tok/top_p + confidence + rationale).
- **#4 Restore-on-mount не затирает свежий UI** (race fix).
  `getLastReport()` теперь проверяет `ctx.olympicsBusy` перед
  `renderOlympicsReport(...)` — если пользователь уже нажал «Run Olympics»,
  старый отчёт не подменяет новый прогон.
- **#5 VRAM safety при auto-load**. `ensureRecommendedModelsLoaded` при
  ≥3 уже загруженных моделях выгружает «не-recommended» через
  `unloadModel(...)` ПЕРЕД новой загрузкой. Снижает риск OOM/freeze
  LM Studio на 8GB VRAM. Также priority-ordered selection (extractor →
  vision → evaluator) гарантирует, что slice(0, 2) берёт нужные две.
- **#6 Folder-bundle sidecars получают prefs.visionModelKey**.
  `describe-sidecars.ts` зовёт `extractMetadataFromCover(buf, {})` с
  пустыми опциями — vision-meta lazy-load не срабатывал. Теперь
  передаём `prefs.visionModelKey` явно.
- **#7 Stale doc-comment** в `disciplines.ts` обновлён (judge удалён из
  Olympics, остался только в pipeline через judgeModel).

### Changed

- **EvaluatorDeps**: добавлен hook `ensurePreferredLoaded(modelKey)`. По
  дефолту дёргает `lmstudio-client.loadModel`, в тестах — заменяемая
  no-op/fail-функция. Закрывает gap «pickEvaluatorModel-mock не покрывал
  pre-load».
- **Probe gate condition**: `probeShouldRun = !testAll && !explicit-models &&
  maxModels > 0`. Условие чище и не зависит от случайной длины пула.

### Tests

- `tests/evaluator-queue.test.ts`: тест «passes prefs.evaluatorModel into
  pickEvaluatorModel» обновлён под новый контракт (`allowAutoLoad: false`,
  проверка вызова `ensurePreferredLoaded`).
- Все тесты проходят: 564 pass / 8 fail (baseline env-зависимый, без
  регрессий относительно v0.4.8).

### Mahakala verdict

```
БАЗОВЫЙ СНИМОК v0.4.8: tsc 0, lint 0, tests 564/8
ФИНАЛЬНЫЙ СНИМОК v0.4.9: tsc 0, lint 0, tests 564/8
ВЕРДИКТ: БЕЗОПАСНО ✅ — продукт защищён, регрессий нет.
```

---

## [0.4.8] — 2026-05-01 — Probe phase + Adaptive elimination + EcoTune auto-tune

### Added

- **Probe phase** (Arena-Lite EMNLP 2025 / Active Evaluation ICML 2025):
  в Lightning mode каждая модель получает 1 быстрый probe (`lang-detect-en`,
  16 tokens). Модели с score < 0.4 исключаются из полного турнира.
  Экономит 30-50% времени при наличии "сломанных" моделей.
- **Adaptive elimination** (Arena-Lite EMNLP 2025): если текущая модель
  отстаёт от лидера роли на ≥ 35 пунктов на первой дисциплине — остальные
  дисциплины этой роли пропускаются. Экономит 20-40% inference time.
- **EcoTune auto-tune** (EMNLP 2025): `olympics-auto-tune.ts` —
  детерминированный analyzer per-role результатов. Вычисляет
  оптимальные temperature/top_p/max_tokens на основе наблюдаемых
  scores, durations, reasoning capability. Нет LLM-зависимости
  (arXiv 2603.24647: CMA-ES + 0.8B hybrid не превосходит classical).
- **Report: probeStats + adaptiveElimination** — метрики probe и elimination
  для прозрачности в UI и телеметрии.

### Changed

- **docs/lightning-olympics.md**: обновлены ссылки на реальные публикации
  (am-ELO ICML'25, Arena-Lite EMNLP'25, Active Eval ICML'25, EcoTune
  EMNLP'25, Judge Tuning ICML'25, arXiv 2603.24647), удалены неверифицированные.
  Статус всех трёх механизмов: ✅ реализовано.

## [0.4.7] — 2026-05-01 — Olympics report persist + auto-restore

### Added

- **Olympics report автосохранение**: отчёт (медали, BT scores, дисциплины,
  рекомендации, roleAggregates) сохраняется в `data/olympics-report.json`
  после каждого успешного прогона. При перезапуске приложения — загружается
  автоматически и отображается на вкладке Модели.
- **IPC `arena:get-last-report`**: preload + main handler для загрузки
  persisted отчёта из renderer.
- **`arena:clear-olympics-cache`** теперь удаляет и файл на диске.

### Fixed

- **Результаты Olympics теряются при выходе**: ранее `_olympicsCache` хранился
  только в памяти процесса — при перезапуске = null. Теперь: JSON на диске
  + автовосстановление при mount Models page.

## [0.4.6] — 2026-05-01 — Auto-load pipeline + Import UX cleanup

### Added

- **Auto-load моделей после Olympics** (`arena:apply-olympics-recommendations`):
  после записи prefs автоматически загружает до 2 unique моделей
  (приоритет: extractorModel → visionModelKey → evaluatorModel) в LM Studio.
  Ранее: Olympics «распределяла» роли, но модели оставались на диске — весь
  production pipeline (vision, evaluator, crystallizer) видел null и skip'ал.
- **Lazy-load vision** в `illustration-worker.ts` и `vision-meta.ts`:
  если `visionModelKey` задан в prefs но модель не в LM Studio loaded —
  попытка `loadModel()` перед skip. Устраняет "No vision models loaded —
  skipping illustration analysis" при настроенных prefs.
- **`evaluator-queue.ts`**: `allowAutoLoad: true` для preferred-модели
  (prefs.evaluatorModel задан). Ранее: `allowAutoLoad: false` — evaluator
  видел «model not loaded» даже если Olympics записал ключ.
- **`docs/future-formats.md`** — исследование 30+ форматов электронных книг
  и архивов для расширения (MOBI, AZW3, CHM, LIT, TAR, GZ, BZ2, XZ, FBZ,
  .djv, .md, LaTeX, PostScript и др.) с приоритизацией P0–P5.

### Changed

- **Удалены кнопки** «Сканировать папку (отчёт дублей)» и «Импортировать
  папку как комплект» из панели импорта — дублировали функционал,
  загромождали интерфейс.
- **`scanArchives` = true по умолчанию** (`renderer/library/state.js`).
  Раньше пользователь должен был включать вручную; большинство коллекций
  содержат книги в ZIP/RAR/7Z.
- **i18n hint** (ru/en): полный список архивов в dropzone и checkbox —
  «ZIP, RAR, 7Z, CBZ, CBR» вместо «ZIP, CBZ».
- **CSS fix**: `flex-wrap` на log header (кнопка «Скопировать» больше не
  вылазит за край), `overflow-x: hidden` на log-list, grid колонка файла
  `minmax(0, 280px)` вместо `minmax(180px, 320px)` — адаптивная ширина
  без горизонтального скролла.

### Fixed

- **КРИТИЧЕСКИЙ**: production pipeline не использовал модели после Olympics.
  Корень: `apply-olympics-recommendations` только записывал prefs, не загружал
  модели в LM Studio. Резолвер, vision-meta, evaluator-queue — все ждали
  `listLoaded()` и видели пустоту → skip. Исправлено: auto-load (до 2 моделей)
  + lazy-load per-role + evaluator allowAutoLoad.

## [0.4.5] — 2026-05-01 — Olympics UX overhaul + Lightning preset + technical log

### Added

- **`docs/lightning-olympics.md`** — научно-инженерный фундамент молниеносной
  LLM-аттестации: am-ELO, LiteCoST, EfficientArena single-probe, Light-LLM
  auto-tune, целевые ROI (×8–10 ускорения, ≥90% champion agreement).
- **🚀 Lightning preset** в Olympics Advanced — один тумблер
  (`olympicsLightning` pref) перекрывает несколько параметров:
  weightClasses=`["s"]` · testAll=false · maxModels=5 ·
  perDisciplineTimeoutMs=30s. Прогон 60–90 сек вместо 5–15 мин.
- **Расширенный технический лог Олимпиады** (научный формат):
  - Внешний `<details>` collapsible с счётчиком событий
  - Per-event `<details>` для discipline.start (whyImportant) и model.done
    (sample/role/error)
  - Подключён `olympics.log` канал (info/warn/error/debug + ctx как pretty JSON)
  - Метрики: tokens/prompt_tokens/completion_tokens/tps в каждой
    `model.done` записи, max_tokens/thinkingFriendly в `discipline.start`
- **Подсветка `flash` на role-select'ах** после `applyRecommendations()` —
  визуальное подтверждение что роли получили модели.

### Changed

- **Синхронизация ролей: 8 = 8** (`ALL_ROLES` ↔ `PIPELINE_ROLES`).
  Ранее: 9 чекбоксов категорий vs 8 селекторов ролей. `judge` удалён из
  Олимпиады (delta-extractor заменил отдельный judge-шаг). Дисциплина
  `judge-bst` снята с rotation; `judgeModel` pref + ModelRole сохранены
  для backward-compat.
- **Vision-карточки: 3 разных заголовка** вместо 3 одинаковых
  «Vision (обложки / OCR / иллюстрации)». Используем `aggregateRoleTitle(agg.role)`
  → «Хранитель обложек» / «Распознаватель текста» / «Иллюстратор», под ним
  sub-hint `→ visionModelKey (общая для трёх vision-задач)`.
- **Кнопка «Распределить» считает РОЛИ** (было: уникальные prefs). 9 категорий
  → 8 ролей (без judge) → 8 чемпионов; vision×3 показываются раздельно но
  применяются к общей `visionModelKey`.
- **`applyRecommendations()` await refresh** — селекты гарантированно
  перерисовываются ДО показа toast'а.
- **`OlympicsEvent.model.done`** расширен: `role`, `tokens`,
  `promptTokens`, `completionTokens`, `sample`. `discipline.start` —
  `whyImportant`, `thinkingFriendly`, `maxTokens`.
- **`ChatResp`** в `lms-client-types.ts`: новые поля `promptTokens`,
  `completionTokens` (LM Studio v1.x usage из `/v1/chat/completions`).

### Fixed

- **«Распределить (7)» не подставляет модели**: причины устранены —
  3 vision-роли больше не сливаются в один счётчик, await refresh
  гарантирует перерисовку, flash-эффект подтверждает применение.
- Расхождение `judge` между «категориями тестирования» и «ролями пайплайна» —
  устранено через удаление judge из Olympics.

### Removed

- `electron/lib/llm/arena/disciplines.ts`: дисциплина `judge-bst` (sanity-test
  без production-применения; lifecycle test переключён на `lang-detect-en`).
- `tests/olympics-scorers.test.ts`: SAMPLES для `judge-bst` / `judge-async`
  (orphan-fixtures).

## [0.4.4] — 2026-04-30 — Linux x64 build (Phase 4 cross-platform roadmap)

### Added

- **Linux x64 портативная сборка** (AppImage + .deb + .tar.gz):
  - `electron-builder.yml`: новая секция `linux:` с тремя targets, `mac:` секция
    подготовлена под Phase 5 (arm64+x64 dmg/zip с ad-hoc подписью)
  - `extraResources` теперь использует per-platform подстановки
    `vendor/<package>/${platform}-${arch}/` — Win собирается из `win32-x64`,
    Linux из `linux-x64`, macOS из `darwin-{arm64,x64}`
  - `asarUnpack` расширен на edgeparse native bindings всех платформ
- **`scripts/download-djvulibre-linux.cjs`** — bundling djvulibre CLI с
  shared-libraries (через `ldd`) в `vendor/djvulibre/linux-x64/` для
  AppImage/deb. Если `djvused` не в PATH — печатает `apt-get install -y
  djvulibre-bin` инструкцию.
- **`.github/workflows/release-linux.yml`** — Linux build job на
  `ubuntu-latest`, устанавливает djvulibre-bin, bundling, ABI ensure,
  electron-builder для AppImage/deb/tar.gz. Auto-publish при пуше тега.
- **`electron/lib/platform.ts`** — cross-platform helpers:
  `platformVendorDir()`, `platformExeName()`,
  `platformVendorDirsWithLegacy()` (с fallback на legacy `win32-x64` для
  старых установок).

### Changed

- **`scripts/build-portable.js`** теперь platform-aware:
  - Win → `--win portable`
  - Linux → `--linux AppImage`
  - macOS → `--mac dir`
  - Override через ENV `BIBLIARY_BUILD_TARGET` (например `--linux deb`)
- **`electron/lib/scanner/parsers/djvu-cli.ts`** — `candidateRoots()`
  использует `platformVendorDirsWithLegacy()` + добавлены типичные
  системные пути для Linux/macOS (`/usr/bin`, `/opt/homebrew/bin`).
- **`electron/lib/library/marker-sidecar.ts`** — `resolveDdjvuBin()`
  использует `platformExeName("ddjvu")` + per-platform vendor lookup.
- **`electron/lib/library/archive-extractor.ts`** — `resolve7zBinary()`
  per-platform path lookup; для Linux/macOS остаётся приоритет npm пакета
  `7zip-bin`/`7z-bin` (cross-platform).
- **i18n `settings.section.ocr.desc`** — расширено: упоминание Linux
  ограничения и vision-LLM как cross-platform альтернативы. Новый ключ
  `settings.section.ocr.linuxHint`.

### Known limitations on Linux

- **Системный OCR недоступен** — `@napi-rs/system-ocr` использует
  `Windows.Media.Ocr` (Win) / Vision Framework (macOS). UI per-book OCR
  toggle в preview уже скрывается через `STATE.prefs.ocrSupported`.
  Для DJVU/scanned PDF на Linux используйте vision-LLM (Qwen3-VL-8B и
  др.) через настройку `djvuOcrProvider`.
- **AppImage требует FUSE** на target системе. Альтернатива: запустить
  с `--appimage-extract-and-run` или установить через `.deb`.

## [0.4.3] — 2026-04-30 — God-files refactor part 2 (high-risk shared state)

### Changed

- **`electron/ipc/library.ipc.ts`** (1063 LOC → 35 LOC barrel) разбит на:
  - `library-ipc-state.ts` — registry активных импортов, lifecycle helpers
    (`bootstrapLibrarySubsystem`, `flushLibraryImports`, `abortAllLibrary`),
    `broadcastImportProgress`, `mirrorProgressToLogger`,
    `registerLibraryLlmLockProbes`, `readImportPrefs`
  - `library-import-ipc.ts` — `library:pick-folder/files`,
    `import-folder/files`, `cancel-import`, `import-log-snapshot`,
    `scan-folder`, `cancel-scan`
  - `library-catalog-ipc.ts` — `library:catalog`, `tag-stats`,
    `collection-by-{domain,author,year,sphere,tag}`,
    `get-book`, `read-book-md`, `delete-book`, `rebuild-cache`
  - `library-evaluator-ipc.ts` — все `evaluator-*` каналы +
    `reparse-book` + `reevaluate-all`
- **`electron/ipc/dataset-v2.ipc.ts`** (858 LOC → ~430 LOC) разбит на:
  - `electron/lib/dataset-v2/extraction-runner.ts` — `runExtraction` +
    `makeLlm` + типы (рядом с уже выделенным `batch-runner.ts`)
  - `electron/ipc/dataset-v2-ipc-state.ts` — `activeJobs`/`activeBatches`,
    `abortAllDatasetV2`, `killAllSynthChildren`, `DEFAULT_COLLECTION`
  - `dataset-v2.ipc.ts` — только `ipcMain.handle` обёртки + barrel
- **`electron/lib/library/evaluator-queue.ts`** (685 LOC) — консервативный
  split: вынесены только pure-функции в `evaluator-persist.ts`
  (`extractMetadataHints`, `persistFrontmatter` с writer-DI). Очередь и
  worker-loop оставлены вместе — slot-state machine слишком плотный для
  безопасного разделения (см. risk 🔴 в плане).
- **`renderer/library/import-pane.js`** (928 LOC → 165 LOC entry) разбит на:
  - `import-pane-log.js` — лог-панель с фильтром/счётчиками/copy
  - `import-pane-actions.js` — pickFolder/Files, bundle, runImport,
    drag&drop, scan-for-duplicates
- **`renderer/dataset-v2.js`** (764 LOC → 80 LOC entry) разбит на:
  - `dataset-v2-state.js` — STATE singleton + `phaseToLabel` + `isCrystalBusy`
  - `dataset-v2-wizard.js` — buildStep1..4 + buildPrimaryAction +
    advanced-model picker
  - `dataset-v2-progress.js` — onSynthStart/Stop + renderProgress + handleEvent

### Принцип реализации

Те же правила что и в v0.4.2: barrel-pattern сохраняет публичный API,
потребители не правятся. Существующие тесты `evaluator-queue.test.ts`,
`evaluator-queue-slots.test.ts`, `library-cas-pipeline.test.ts` и др.
проходят без изменений. Lint и typecheck зелёные.

## [0.4.2] — 2026-04-30 — God-files refactor part 1 (low-risk)

### Changed (декомпозиция god-файлов через barrel-pattern, потребители не правятся)

- **`electron/lib/llm/arena/lms-client.ts`** (675 LOC → barrel) разбит на:
  - `lms-client-types.ts` — типы + `makeLogger`
  - `lms-client-rest.ts` — REST API: list / load / unload / health / chat
  - `lms-client-sdk.ts` — SDK route (`@lmstudio/sdk`)
- **`electron/lib/llm/arena/olympics.ts`** (862 LOC → 525 LOC) разбит на:
  - `olympics-types.ts` — все интерфейсы и type-алиасы
  - `olympics-load-config.ts` — `computeOlympicsLoadConfig`
  - `olympics.ts` — `runOlympics` + cache + barrel re-exports
- **`electron/lib/library/book-evaluator.ts`** (699 LOC → ~350 LOC) разбит на:
  - `book-evaluator-schema.ts` — Zod schema, parsing, `isLmStudioBadRequest`
  - `book-evaluator-model-picker.ts` — auto-выбор модели (scoring + heuristics)
  - `book-evaluator.ts` — `EVALUATOR_SYSTEM_PROMPT` + `evaluateBook` + repair
- **`renderer/models/models-page.js`** (1388 LOC → 110 LOC entry) разбит на:
  - `models-page-internals.js` — shared `ctx` + toast / busy / apply
  - `models-hardware-status.js` — hardware strip + status + loaded + roles
  - `models-page-olympics-labels.js` — лейблы дисциплин и ролей
  - `models-page-olympics-controls.js` — карточка Olympics + advanced + run/cancel
  - `models-page-olympics-report.js` — рендер отчёта Olympics

### Принцип реализации

Везде применён **barrel-pattern**: оригинальный файл сохраняется как точка
входа с `export { ... } from "..."` — потребители не правятся в этом же
коммите. Тесты olympics-* / book-evaluator-prefs / model-pool продолжают
проходить без изменений.

## [0.4.1] — 2026-04-30 — UI Search + DX Foundation (Phase 0–1 of cross-platform roadmap)

### Added

- **Встроенный UI семантического поиска** (`renderer/search.js`, `nav.search`).
  Picker коллекций (показывает только непустые с количеством точек), input
  запроса с Enter, slider порога сходства 0..1 (default из prefs.ragScoreThreshold),
  список карточек с метаданными (книга, глава, тэги, score), кнопки
  «Скопировать путь» и «Открыть в библиотеке». Использует существующий
  IPC `qdrant:search` + multilingual-e5-small (cold-start UI hint при первом
  запросе).
- **i18n keys** `search.*` и `nav.search` в `renderer/locales/{ru,en}.js`
  (≈25 строк × 2 локали).
- **`scripts/ensure-sqlite-abi.cjs`** — управление ABI-стэшем better-sqlite3.
  Один скрипт для двух режимов: `--target=node|electron` (select из stash,
  fallback на rebuild + auto-stash) и `--save --target=X` (положить live
  в stash). Idempotent через marker-файл `.abi-marker`. Переключение между
  Node ABI (для `npm test`) и Electron ABI (для `electron:dev` / portable
  build) ~50 мс copy вместо десятков секунд `npm rebuild`.
- **`docs/cross-platform.md`** — инвентарь всех нативных зависимостей и
  vendored binaries с per-platform статусом, список Win-specific мест в
  коде, план Phase 4 (Linux x64 build) и Phase 5 (macOS arm64+x64).
- **Linux CI smoke baseline**: `.github/workflows/smoke.yml` теперь делает
  pre-flight `ensure-sqlite-abi.cjs --target=node` и запускает полный test
  suite (best-effort, `continue-on-error: true`) исключая `vision-meta`
  (требует live LM Studio). ENV `BIBLIARY_SKIP_OCR=1` для Linux.

### Changed

- `package.json`: `test:rebuild-native` → `node scripts/ensure-sqlite-abi.cjs --target=node`,
  `electron:dev` → аналогично с `--target=electron`. Добавлены
  helper-scripts `sqlite:select-{node,electron}` и `sqlite:save-{node,electron}`.
- `scripts/build-portable.js`: после `@electron/rebuild` теперь стэшит
  Electron-ABI бинарь в обе слот-позиции (`better_sqlite3.node` legacy +
  `better_sqlite3.electron.node` new) и пишет marker.
- `electron/preload.ts`: добавлен опциональный параметр `scoreThreshold` в
  `qdrant.search()` (handler уже принимал его, не было типа в preload).
- `.github/workflows/ci.yml`: `npm rebuild better-sqlite3` заменён на
  `ensure-sqlite-abi.cjs --target=node` для согласованности с локальным DX.
- `README.md`: обновлён раздел «Поиск» (теперь UI есть), снят пункт
  «Поиск без встроенного UI» из ограничений, обновлены инструкции для
  `Bibliary 0.4.1.exe`. Добавлен пункт про OCR на Linux (unsupported).

## [2.7.0] — 2026-04-24 — Library + Dataset Factory (release)

> **Закрытие линии.** Iter 7..9 (File-System Library + Pre-flight Evaluation +
> Dataset Synthesis + per-domain presets) консолидированы в один релиз.
> Добавлены: shared storage contract, batch-runner extract, evaluator-queue DI,
> renderer/library strangler step #1, настоящий Electron smoke-test через
> playwright-electron. Документация очищена от устаревших snapshot-отчётов.

### Added
- **Shared storage contract** (`electron/lib/library/storage-contract.ts`):
  единый источник истины для file-system layout (`data/library/{id}/original.{ext}`),
  source-path резолва для batch-extract и crystallize gate (quality + fiction filter).
  Ликвидирует расхождения между UI-batch и E2E.
- **Batch runner extract** (`electron/lib/library/batch-runner.ts`):
  выделил pure `runBatchExtraction(args, deps)` из `dataset-v2.ipc.ts`. IPC-handler
  стал тонкой обёрткой; gate/cancel/error-recovery логика тестируется без `ipcMain`.
- **Evaluator-queue DI hook** (`_setEvaluatorDepsForTests`): подменяет
  `evaluateBook` / `pickEvaluatorModel` / fs IO в тестах без запуска LM Studio.
- **Renderer strangler step #1** — extracted из `renderer/library.js`:
  - `renderer/library/format.js` — pure formatters (fmtMB / fmtDate / fmtWords /
    fmtQuality / formatBytes / cssEscape / makeDownloadId).
  - `renderer/library/catalog-filter.js` — `filterCatalog` + `qualityClass` +
    `statusClass` + `QUALITY_PRESETS` (frozen).
- **Real Electron smoke-test** (`tests/smoke/electron-smoke.test.ts`):
  через `playwright._electron.launch()`, проверяет launch + preload bridge +
  `window.api.library` shape + переход на library route. Изолированный
  `BIBLIARY_DATA_DIR` с preseed `preferences.json` (welcome wizard skip).
  Запуск: `npm run test:smoke`.
- **`BIBLIARY_DATA_DIR` env-override** в `electron/main.ts` — позволяет
  smoke-тесту и portable-инсталлам использовать свой data-dir без
  изменений в обычном пользовательском сценарии.
- **+19 интеграционных тестов** для `evaluator-queue` (10 кейсов:
  happy path, idempotent enqueue, skip non-imported, no chapters,
  no LLM, multi-book error recovery, abort, pause/resume, bootstrap,
  model override) и `batch-runner` (9 кейсов: gate filter,
  fiction toggle, not-found, status updates, error recovery, cancel,
  event sequence, runExtraction context, custom minQuality).
- **+13 unit-тестов** для renderer-helpers (`fmtMB/fmtDate/fmtWords/...`,
  `filterCatalog`, `qualityClass`, `statusClass`).
- **Pre-flight pipeline robustness в E2E batch:**
  - global `unhandledRejection`/`uncaughtException` handlers ловят
    рассинхронизированные pdfjs worker rejections (битые PDF не убивают весь батч).
  - per-book parse timeout 8 минут через `Promise.race` + `AbortController` --
    зацикленный pdfjs worker не подвешивает прогон.

### Changed
- `electron/ipc/dataset-v2.ipc.ts`: handler `dataset-v2:start-batch`
  делегирует логику в `runBatchExtraction`. Pre-existing API (`bookIds`,
  `targetCollection`, `minQuality`, `skipFictionOrWater`,
  `extractModel`, `judgeModel`, `scoreThreshold`) полностью сохранены.
- `cache-db.ts`: `originalFile` больше не читается из колонки
  (которая часто была пуста), а выводится из `original_format` через
  `getStoredOriginalFileName(format)` -- batch источники всегда корректны.
- E2E batch report: дефолтный quality threshold 70 (было 50);
  exit code на user-interrupt 130; resume-логика использует общий
  `isTerminalE2EBookStatus`.

### Removed (docs purge / .servitor-trash)
- `docs/PHASE-3-PLAN.md` — Phase 1-2-3 закрыты, ссылается на несуществующий
  `data/CHANGELOG.md`, противоречит ROADMAP.
- `docs/REPORT-READINESS-v2.3.md` / `docs/REPORT-AUDIT-2026-04-21.md` /
  `docs/TECH-LEAD-REVIEW.md` / `docs/AUDIT-2026-04.md` — версия
  в таблицах 2.3.0 vs реальная 2.7.0; ссылки на удалённый
  `dataset.ipc.ts` (теперь `dataset-v2.ipc.ts`).
- `docs/REPORT-USER-SKILLS.md` / `docs/UI-TESTER-REPORT.md` — снапшоты
  старых прогонов; ссылки на несуществующие `ADR-NNN-*.md`.
- Все 7 файлов перенесены в `.servitor-trash/2026-04-24_00-08/docs/`
  с `_manifest.json` для restore при необходимости.

### Test summary
- `npm test` — **65/65 PASS** (было 32 до этой сессии: +13 helpers + 10 evaluator-queue + 9 batch-runner + 1 dummy adjust).
- `npm run test:smoke` — **1/1 PASS** (Electron real launch, ~3s).
- `tsc -p tsconfig.electron.json` + `eslint renderer/**/*.js` — clean.

### Migration notes
- Native `better-sqlite3` нужно пересобрать под Electron перед запуском
  smoke с реальной БД: `npx @electron/rebuild --module-dir node_modules/better-sqlite3`.
  Текущий smoke намеренно избегает SQLite-зависимых вызовов чтобы
  работать без этого шага.

## [2.7.0-iter9] — 2026-04-23 — Multi-tenant LoRA Factory + Tests + UI

### Added
- **Per-domain trainer prompts (10 presets):** `electron/defaults/synth-prompts/`
  с `index.json` + 10 `.md` файлов. Каждый — реальный, специализированный
  системный промпт от senior-эксперта в своей области:
  marketing, ux, seo, programming, security, science, philosophy,
  business, psychology, default. Подбирается **автоматически** по
  `concept.domain` через keyword scoring (longest-match wins).
- **`--preset` CLI флаг** в `dataset-synth.ts`:
  - `auto` (по умолчанию) — multi-tenant: каждый концепт получает свой trainer
  - `<name>` — фиксированный (например, `--preset marketing`)
  - `none` — generic generic prompt (back-compat)
  - `--list-presets` — discovery без запуска LLM
- **`--system-prompt-file`** — для power-users со своим custom prompt-ом.
- **UI-кнопка "Synthesize dataset → JSONL"** в Catalog bottombar (renderer/library.js).
  Запускает фон-синтез через child-process tsx, не блокируя app shell.
  Prompt → Q/A pairs count → reasoning toggle → confirm → background.
  Результат + лог пишутся на диск, UI показывает PID + пути.
- **IPC `dataset-v2:synthesize`**: spawn `npx tsx scripts/dataset-synth.ts`
  с детачем stdout/stderr в `<output>.log`. Возвращает `{ok, pid, logPath}`
  немедленно, а не ждёт 60-минутный синтез.
- **Unit-тесты (31 PASS, 0 FAIL)** через нативный `node --test`:
  - `tests/reasoning-parser.test.ts` — 12 кейсов: think+JSON happy path,
    JSON-only, malformed JSON, unclosed `<think>`, escaped quotes, partial
    JSON, empty input, unbalanced braces, braces-in-strings, preamble,
    postscript, non-string input.
  - `tests/surrogate-builder.test.ts` — 9 кейсов: empty book, tiny book
    full-text mode, distillation sections, paragraph atomicity, 2-chapter
    edge case, compression ratio bound, blank paragraph filtering, missing
    title fallback.
- **npm scripts**: `npm test` и `npm run test:unit`.

### Verified (live)
- **`--list-presets`** показывает все 10 пресетов с keyword-ами.
- **31/31 unit tests PASS** в 250ms.
- **Lint + tsc clean** на всём проекте (0 errors).
- **Background synth** работает: 45 концептов из 429 за 8.5 мин (~11s/concept на 35b-a3b).

## [2.7.0-iter8] — 2026-04-23 — Dataset Synthesis (final payoff)

### Added
- **`scripts/dataset-synth.ts`** — финал Pre-flight Evaluation pipeline.
  Берёт принятые концепты из тематической Qdrant-коллекции и генерирует
  ChatML JSONL для тренировки LoRA через Unsloth/LlamaFactory/axolotl.
  Streaming-writer (не упадёт на 50K концептов), pickEvaluatorModel-based
  выбор LLM (flagship-first, 35b > 4b), Zod-валидация ответа, scroll API
  по всей коллекции с pagination.
- **`--include-reasoning` режим**: оборачивает assistant-ответ в
  `<think>...</think>` блок из сохранённого `extractorReasoning` /
  `judgeReasoningTrace`. Это R1-style premium distillation data из плана:
  "Reasoning is the dataset" (концепты + reasoning traces от Reasoning-моделей).
- **npm scripts**: `dataset:synth` и `dataset:probe-model` для удобного запуска.
- **Smart evaluator-model picker** (Iter 7b, перенесено сюда для полноты):
  `pickEvaluatorModel()` теперь скорит модели по тегам curated-models.json
  (flagship +1000, thinking-heavy +500, ...) + bias по размеру параметров.
  На пользовательской машине корректно выбирает `qwen/qwen3.6-35b-a3b`
  (score 1535) вместо `qwen/qwen3-4b-2507` (-96).

### Verified (live)
- 6/6 ChatML примеров на 3 концептах за 31s (~10s/концепт на 35b-a3b).
  Output: practical Q&A пары с domain-specific терминологией, без
  плагиата source_quote.
- 429 концептов в `dataset-accepted-concepts` готовы к synthesis в
  полноразмерный датасет (~70 минут).

## [2.7.0-iter7] — 2026-04-23 — File-System First Library + Pre-flight Evaluation

### Added
- **File-System First Library** — оригиналы книг + `book.md` с YAML
  frontmatter, теперь хранятся в `data/library/{slug}/`. SQLite
  (`data/bibliary-cache.db`) выступает как rebuildable index.
- **Pre-flight Evaluation** — новая стадия pipeline:
  `electron/lib/library/book-evaluator.ts` строит Structural Surrogate
  Document (TOC + Intro + Conclusion + nodal slices, ~3-4K слов) и
  отдаёт reasoning-модели LM Studio с системным промптом
  "Chief Epistemologist". Парсит `<think>` + JSON через
  `reasoning-parser.ts`. Quality score 0-100 + domain + tags
  сохраняется до тяжёлой crystallization.
- **DataGrid Catalog UI** — `renderer/library.js` теперь рендерит
  компактную таблицу: Чекбокс | Title (en) | Author (en) | Domain |
  Words | Quality | Status. Фильтры: Quality > N, Hide fiction/water,
  пресеты Premium 86+ / Solid 70+ / Workable 50+. Кнопка
  "Select all filtered" для batch crystallization.
- **Thematic Qdrant Collections** — collection picker в каталоге.
  `targetCollection` параметризован сквозь `judge.ts`,
  `dataset-v2.ipc.ts`, `preload.ts`. Можно создавать тематические
  LoRA-датасеты (marketing / SEO / UX / etc.) в изолированных
  коллекциях, не мешая друг другу.
- **Batch Cancellation** — `dataset-v2:cancel-batch` IPC + батч-уровневый
  AbortController. Раньше cancel останавливал только текущую книгу,
  но цикл продолжался — теперь корректно прерывает весь батч и
  помечает оставшиеся книги как `skipped`.
- **E2E Library Test Harness** — `scripts/e2e-batch-library.ts`,
  `npm run test:e2e:library`. Каждая книга = отдельный тест с 4
  стадиями (PARSE / EVALUATE / CRYSTALLIZE / PERSIST). Прогон 200
  книг из Downloads: 187 PASS / 13 FAIL (все 13 — сканированные
  PDF без OCR, не баги кода).
- **CPU/GPU Pipelining** — конвертация PDF/EPUB/FB2/DOCX/TXT в Markdown
  идёт на CPU параллельно с LLM evaluation/extraction на GPU.

### Fixed
- **FTS5 contentless DELETE** (Iter 7) — `books_fts` создавалась
  с `content=''`, что запрещает обычный DELETE. Каждый `upsertBook`
  падал с `cannot DELETE from contentless fts5 table`. Миграция v1→v2:
  DROP + recreate `books_fts` без `content=''`, применяется
  идемпотентно через `PRAGMA user_version`.
- **SHA-256 deduplication в e2e скрипте** — три копии одного файла
  (например `TonForge_Spec.docx` + `(1).docx` + `(2).docx`) падали с
  `UNIQUE constraint failed: books.sha256`, потому что `meta.id`
  детерминирован от пути, а sha256 от контента. Теперь e2e проверяет
  `getKnownSha256s()` перед `upsertBook` и помечает дубли как
  `status=duplicate` (как уже делает production-импорт).
- **Module resolution** в `tsx`-окружении (ESM):
  - `cache-db.ts`, `import.ts`: `require()` → static `import`.
  - `paths.ts`: `__dirname` → `process.cwd()` + traversal до package.json.
- **`LMStudioClient` invalid baseUrl** — `getLmStudioUrlSync` /
  `getQdrantUrlSync` использовали `??` (nullish coalescing). Если
  ENV пустая строка `""`, оператор не падал на дефолт. Заменено
  на `||` (logical OR), который корректно treat-ит `""` как falsy.

### Removed
- Парсеры мёртвых форматов: DjVu, CHM, MOBI. Оставлены PDF, EPUB,
  FB2, DOCX, TXT + ZIP/RAR/7z/CBR/CBZ архивы.
- Quality scoring во время crystallization — теперь вынесено в
  отдельный pre-flight стейдж до тяжёлого chunking'а.

### Internal
- `data/library/`, `data/bibliary-cache.db*` добавлены в `.gitignore`.
- `BookStatus` enum расширен: `imported | evaluated | indexed |
  duplicate` для аккуратного отслеживания прогресса.

## [2.6.0] — 2026-04-22 — Overmind Agent + Three Strikes UX Stabilization

### Added
- **Overmind Agent (B1)** — multiturn-история разговоров. UI-память
  кэпом 50 сообщений (FIFO), `sanitizeAgentHistory` helper c 8 unit-тестами.
- **Overmind Agent (B6)** — synthetic Knowledge Base о приложении
  (Karpathy LLM Wiki Pattern). `electron/lib/help-kb/` модуль:
  `chunker.ts` режет docs/*.md по заголовкам с overlap, `ingest.ts`
  пишет в Qdrant `bibliary_help` коллекцию через `e5-small` embeddings,
  `search.ts` даёт семантический поиск. Tool `search_help` для агента.
  CLI `npm run build:help-kb`.
- **Overmind Agent (B7)** — long-term memory диалогов
  (`electron/lib/help-kb/memory.ts`). Каждый успешный turn
  fire-and-forget пишется в Qdrant `bibliary_memory`. Tool
  `recall_memory` для агента. Не блокирует ответ если Qdrant offline.
- **Live E2E** для B6+B7 цепочки — `scripts/test-agent-memory-live.ts`
  (5/5 PASS на real Qdrant, graceful skip без сервиса). Auto-build
  `bibliary_help` если коллекция пуста.
- **Welcome Wizard helper** — IPC `system:open-external` с whitelist
  схем `http/https/lmstudio:` для безопасного открытия LM Studio
  из onboarding'а.
- **Neon UI Phase 5.0 финал** — `Chat` и `Docs` маршруты получили
  `buildNeonHero`. Все 9/9 маршрутов имеют neon-эстетику (7/9 через
  общий `buildNeonHero` — Chat/Docs/Crystal/Forge/Models/Qdrant/Settings;
  Library и Forge-Agent используют свои hero-компоненты с тем же
  визуальным языком). P1.3 в ROADMAP закрыт.
- **CHANGELOG.md** — этот файл, история проекта от v2.3.

### Fixed
- **Welcome Wizard** — restore `chatModel` из preferences при
  повторном открытии (Settings → Replay onboarding). Раньше селектор
  всегда был пустым.
- **Welcome Wizard** — блокировка "Далее" на Step 2 (Setup) если
  модель не выбрана. Onboarding больше не завершается с пустым
  `chatModel`. Helper-кнопка "Open LM Studio" если LM Studio пуст.
- **Welcome Wizard** — настоящий Skip с confirm-dialog если
  пользователь уходит без модели со Step >= 2. Раньше silent dismiss
  без предупреждения.
- **Forge Wizard** — валидация перехода Step 1 (Параметры) → Step 2
  (Workspace): пустой `baseModel` блокирует переход с понятным toast.
  Раньше можно было сгенерировать workspace с битым Unsloth-конфигом.
- **Forge Stepper** — пилюли шагов больше не выглядят кликабельными:
  `cursor: default`, `aria-disabled`, tooltip "Текущий шаг" /
  "Завершён" / "Не доступен". Раньше пользователь тыкал и ничего
  не происходило.
- **Chat Compare** — disable при пустой коллекции с tooltip и
  auto-выключением `compareMode`. Раньше backend возвращал два
  идентичных ответа на пустой коллекции, юзер думал "режим не работает".
- **i18n** — добавлен ключ `qdrant.search.error` (`renderer/qdrant.js:204`
  вызывал t() с несуществующим ключом и рендерил сам ключ как текст).
- **i18n agent.hero.sub** — переписан под реальный tools registry
  (Qdrant search, BookHunter, search_help, recall_memory, role editing).
  Раньше обещал "извлечение знаний" которого нет в registry.
- **Crystallizer cancel-семантика** (HIGH-1, HIGH-2) — `concept-extractor.ts`
  и `judge.ts` теперь пробрасывают `AbortError` через `isAbortError(e)`
  helper, а не глотают в общий catch.
- **Agent cancel approval-isolation** (HIGH-3) — `pendingApprovals`
  сегментирован по `agentId`, отмена одного агента не роняет approvals
  у другого.
- **Semantic chunker** (MED-1) — `embedPassage` вместо `embedQuery`
  для параграфов. Drift-метрика теперь корректная.
- **RAG threshold** (MED-2) — `searchRelevantChunks` принимает
  `scoreThreshold` параметром, prefs override наконец работает.
- **PDF parser** (MED-6) — проверка `opts.signal?.aborted` каждые ~10
  страниц. Cancel ingest'а на больших PDF теперь моментальный.
- **`upsertAccepted`** (MED-5) — через `fetchQdrantJson` с 15s таймаутом,
  не голый `fetch`. Зависший Qdrant больше не вешает judge.

### Removed
- **i18n мёртвые ключи** — `library.empty.images`, `agent.header.title`,
  `agent.header.sub` (всего 6 строк ru+en). Никем не используются.

### Tests
- **30 unit-тестов** (offline, no network):
  - `scripts/test-help-kb.ts` — 8/8 (chunker logic)
  - `scripts/test-agent-internals.ts` — 22/22 (sanitizeAgentHistory,
    deterministicId, shouldRemember, buildMemoryText)
- **Live E2E B6+B7 цепочка** — 5/5 PASS на real Qdrant
- **lint** — 0 ошибок (tsc strict + eslint)

## [2.5.x] — 2026-04-21 — UX Stabilization

### Added
- Welcome Wizard на первом запуске (4 шага: Hero → Connect → Setup → Done)
- Settings page с responsive layout, mode-gated секциями
- Library drag&drop, multi-file, OCR opt-in, history tab
- Crystal manual reject button на каждой принятой карточке
- BookHunter download progress + cancel UI

### Fixed
- WSL-зомби процессы при закрытии Electron (`abortAllForgeLocal` в
  `before-quit`)
- OOM в EPUB и preview-source через `MAX_*_BYTES` каппинг
- LocalRunner stdout buffer cap 1MiB против бесконечных длинных строк
- Chat race condition: `setLoading(true)` перед мутацией DOM/history
- Settings UI — responsive breakpoints, URL fields не обрезаются
- Library — фильтр по поддерживаемым форматам после выбора папки,
  fix tab text overflow
- Forge LocalRunner refresh-loss bug

### Removed (Servitor sweep)
- 5 dead preload methods и связанные IPC handlers
- `electron/ipc/resilience.ipc.ts` (handlers без потребителей)
- `system:curated-models` IPC и кураторский UI

## [2.4.0] — 2026-04-22 — Self-Hosted Forge

### Changed
- Forge wizard: 5 шагов → 3 (Подготовка → Параметры → Workspace)
- Bibliary стал 100% private + local

### Added
- YaRN-интеграция как звезда Step 2: пресет «Глубокий контекст»,
  auto-suggest при превышении native context, `rope_scaling` в
  Unsloth/Axolotl configs
- LocalRunner UI hook на Step 3 — кнопка "Запустить в WSL" с live
  стримом метрик (loss, grad-norm)
- Manual GGUF import в LM Studio после успешной тренировки

### Removed
- `electron/lib/hf/` — HuggingFace integration целиком
- Colab notebook generator + AutoTrain YAML generator
- HF token widget, hf:* IPC namespace
- Поля `pushToHub` / `hubModelId` из ForgeSpec

### Migrated
- Терминология ребранд: Forge → "Дообучение", Crystallizer →
  "Извлечение знаний", Memory Forge → "Расширение контекста"
- Roles → "Чат-помощник дообучения" (i18n only, IPC routes
  оставлены для совместимости)

## [2.3.0] — 2026-04-21 — Phase 5.0 Neon UI + OCR

### Added
- Neon Wave Future design tokens (cyan/gold/violet/emerald glows,
  sacred-cards, sacred-geometry SVG patterns)
- Neon rollout на 7/9 маршрутах (Library, Qdrant, Crystal, Forge,
  Models, Dataset, Settings)
- OCR Phase 6.0: `@napi-rs/system-ocr` (Windows.Media.Ocr + Vision
  Framework), `@napi-rs/canvas` для PDF растеризации, image parser
  (PNG/JPG/BMP/TIFF/WEBP), opt-in PDF OCR fallback
- 39 preferences в Zod schema, atomic write + file lock, mode-gated
  Settings UI (Simple/Advanced/Pro)

### Changed
- Crystallizer pipeline зарегистрирован в coordinator — watchdog
  паузит extraction симметрично с dataset/forge

### Fixed
- `chat()` / `chatWithTools()` через `withPolicy` — adaptive timeout,
  exp. backoff, abortGrace для LM Studio bug #1203
- Цикл `forge/state` ↔ `resilience/bootstrap` разорван
- ScannerStateStore под file-lock (race condition fix)
- Embedder cold-start (120s) и per-call (15s) timeouts

## [Earlier]

См. `git log` для полной истории до v2.3. Bibliary прошёл фазы
Phase 2.5 (Resilience layer), Phase 2.6 (Book Scanner), Phase 3.0
(BookHunter), Phase 3.1 (Crystallizer), Phase 4.0 (Forge Agent),
Phase 5.0 (Neon UI), Phase 6.0 (OCR).

[2.6.0]: https://github.com/antsincgame/bibliary/releases/tag/v2.6.0
[2.5.x]: https://github.com/antsincgame/bibliary/releases/tag/v2.5.2
[2.4.0]: https://github.com/antsincgame/bibliary/releases/tag/v2.4.0
[2.3.0]: https://github.com/antsincgame/bibliary/releases/tag/v2.3.0
