# Changelog

All notable changes to Bibliary are documented in this file. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
