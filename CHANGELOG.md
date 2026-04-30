# Changelog

All notable changes to Bibliary are documented in this file. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
