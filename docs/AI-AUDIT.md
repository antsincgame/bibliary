# Bibliary — AI Audit Document

> **Version:** 3.1.0  
> **Date:** 2026-04-26  
> **Purpose:** Comprehensive project context for any AI agent performing code review, bug hunting, refactoring, or feature development.

---

## 1. What Is Bibliary?

Bibliary is a **desktop Electron application** (Windows-first) that acts as a personal knowledge library. It ingests books (PDF, EPUB, FB2, DJVU, DOCX, RTF, ODT, HTML/TXT, and archives ZIP/RAR/7z/CBZ/CBR containing them), converts them to structured Markdown with YAML frontmatter, evaluates their quality using a local LLM (via LM Studio), and stores everything in a file-system-first library backed by SQLite metadata cache.

**Core value proposition:** Turn a folder of unorganized books into a searchable, rated, AI-enriched knowledge base — entirely offline, no cloud required.

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│                    Electron Main Process             │
│                                                      │
│  main.ts ──► IPC handlers (electron/ipc/*.ipc.ts)   │
│                    │                                 │
│    ┌───────────────┼───────────────────┐             │
│    ▼               ▼                   ▼             │
│  Library        Scanner/Ingest     LM Studio        │
│  (import.ts     (parsers/*.ts)     (lmstudio-       │
│   cache-db.ts   (embedding.ts)      client.ts)      │
│   evaluator)                                         │
│    │               │                   │             │
│    ▼               ▼                   ▼             │
│  SQLite DB      Markdown files     Local LLM API    │
│  (cache)        (data/library/)    (localhost:1234)  │
└─────────────────────────────────────────────────────┘
                       │
                  contextBridge
                  (preload.ts)
                       │
┌─────────────────────────────────────────────────────┐
│                  Renderer Process                    │
│                                                      │
│  router.js ──► library/ (catalog, import, reader)   │
│              ──► chat.js (RAG chat)                  │
│              ──► forge.js (site generation)          │
│              ──► dataset-v2.js (training data)       │
│              ──► settings/ (preferences)             │
│              ──► models/ (model management)          │
│                                                      │
│  Vanilla JS (ES modules, no framework)               │
│  DOM helpers: renderer/dom.js                        │
│  i18n: renderer/i18n.js (RU/EN)                     │
└─────────────────────────────────────────────────────┘
```

### Key directories

| Path | Purpose |
|------|---------|
| `electron/` | Main process TypeScript source |
| `electron/ipc/` | IPC handler modules (one per feature domain) |
| `electron/lib/` | Business logic libraries |
| `electron/lib/library/` | Book import, evaluation, caching, dedup |
| `electron/lib/scanner/` | File parsers (PDF, EPUB, FB2, etc.) |
| `electron/lib/rag/` | Retrieval-Augmented Generation |
| `electron/lib/agent/` | AI agent with tool-calling loop |
| `electron/lib/resilience/` | Watchdog, batch coordinator, checkpoints |
| `electron/lib/forge/` | Site/app generation pipeline |
| `renderer/` | Renderer process JS (vanilla ES modules) |
| `renderer/library/` | Library UI: catalog, import pane, reader |
| `renderer/components/` | Shared UI components |
| `scripts/` | Dev tools, E2E tests, dataset tools |
| `tests/` | Unit/integration tests (node --test) |
| `docs/` | Project documentation |
| `data/` | Runtime data (gitignored): DB, library files, prefs |

### Technology stack

| Layer | Technology |
|-------|-----------|
| Runtime | Electron 41 + Node.js 22 |
| Language (main) | TypeScript 5.x (strict, ES modules) |
| Language (renderer) | Vanilla JavaScript with JSDoc @ts-check |
| Database | better-sqlite3 (SQLite, file-based) |
| LLM integration | LM Studio REST API (OpenAI-compatible) |
| Embeddings | @xenova/transformers (ONNX, local) |
| PDF parsing | pdfjs-dist + optional OCR |
| EPUB/FB2/DOCX | fast-xml-parser, jszip, mammoth |
| Build | electron-builder (portable + installer, Windows-only targets) |
| Tests | node --test (built-in) + tsx (нет vitest.config.ts) |
| Package manager | npm |

---

## 3. Data Flow: How a Book Gets Into the Library

```
User drops file/folder
        │
        ▼
  importBookFromFile() ─── electron/lib/library/import.ts
        │
        ├─ 1. SHA-256 hash of file content
        │     └─ Dedup check against DB
        │
        ├─ 2. Copy original file → data/library/{id}/original.{ext}
        │
        ├─ 3. Parse to Markdown
        │     ├─ PDF → pdfjs-dist (+ optional OCR + page gallery up to 12 pages)
        │     ├─ EPUB → fast-xml-parser + jszip (+ cover + illustrations)
        │     ├─ FB2 → fast-xml-parser (+ binary images)
        │     ├─ DJVU → djvu-cli + ddjvu (page gallery, OCR)
        │     ├─ DOCX → mammoth (+ word/media/ images)
        │     ├─ RTF/ODT/HTML → regex/zip parsers
        │     ├─ RAR/CBR/7z → bundled 7z.exe (vendor/7zip/)
        │     └─ MD/TXT → passthrough
        │
        ├─ 3.5. Vision-meta enrichment (optional)
        │     └─ Cover image → local LM Studio multimodal model
        │           (pickVisionModels: tries all loaded vision models in fallback chain)
        │           → title/author/year/language/publisher
        │
        ├─ 4. Filename metadata parsing (title, author, year)
        │
        ├─ 5. Write book.md with YAML frontmatter
        │     └─ data/library/{id}/book.md
        │
        ├─ 6. Upsert into SQLite cache (cache-db.ts)
        │     └─ Status: "imported"
        │
        └─ 7. Queue for Pre-flight Evaluation
              ├─ Surrogate prompt → LM Studio
              ├─ Chief Epistemologist prompt → LM Studio
              ├─ Quality score (0-100)
              ├─ Domain, tags, fiction flag
              └─ Status: "evaluated" → upsert DB
```

### Book storage format

Each book lives in `data/library/{uuid}/`:
- `original.pdf` (or `.epub`, `.fb2`, etc.) — pristine copy of the source file
- `book.md` — Markdown with YAML frontmatter containing all metadata

Frontmatter fields: `id`, `sha256`, `title`, `titleEn`, `author`, `authorEn`, `year`, `isbn`, `publisher`, `domain`, `tags[]`, `wordCount`, `chapterCount`, `qualityScore`, `conceptualDensity`, `originality`, `isFictionOrWater`, `verdictReason`, `evaluatorModel`, `evaluatedAt`, `status`, `originalFile`, `originalFormat`, `sourceArchive`, `warnings[]`.

---

## 4. IPC Contract (preload bridge)

The renderer communicates with the main process through `window.api`:

```
window.api.library.catalog(opts)            → { rows, total, libraryRoot, dbPath }
window.api.library.getBook(id)             → BookMeta | null
window.api.library.readBookMd(id)          → { markdown, mdPath } | null
window.api.library.deleteBook(id, del?)    → { ok, reason? }
window.api.library.importFiles(args)       → ImportResult
window.api.library.importFolder(args)      → ImportResult
window.api.library.importLogSnapshot()     → ImportLogEntry[]
window.api.library.tagStats()             → { tag, count }[]
window.api.library.rebuildCache()         → { scanned, ingested, pruned, errors }
window.api.library.reevaluateAll()        → { queued }
window.api.library.evaluatorStatus()      → EvaluatorStatus
window.api.library.evaluatorSetSlots(n)   → { ok, slots }
window.api.library.scanFolder(folder)     → { scanId }
window.api.library.onImportProgress(cb)   → unsubscribe
window.api.library.onImportLog(cb)        → unsubscribe
window.api.scanner.*                      → Scanning / ingest operations
window.api.lmstudio.*                     → LM Studio connection, model listing
window.api.agent.*                        → AI agent chat loop
window.api.forge.*                        → Fine-tuning wizard + LocalRunner WSL
window.api.datasetV2.*                    → Training data synthesis + Crystallizer
window.api.yarn.*                         → YaRN context expansion
window.api.system.*                       → App info, hardware profiling, openExternal
```

---

## 5. Known Strengths

1. **File-system-first architecture** — Books stored as plain files (MD + original), not locked in a database blob. Survives DB corruption.
2. **Fully offline** — No cloud dependencies. LM Studio runs locally. Embeddings via ONNX locally.
3. **Robust parsing pipeline** — 11 format parsers (PDF/EPUB/FB2/DJVU/DOCX/DOC/RTF/ODT/HTML/TXT + archives RAR/7z/CBR/CBZ) with OCR fallback chains.
4. **Vision-meta multi-model fallback** — Cover image → chain of all loaded vision models; falls back to next if title/author/year/language incomplete.
5. **PDF/DJVU page gallery** — First N pages (configurable via `BIBLIARY_RASTER_IMAGE_PAGE_LIMIT`, default 12) rendered as PNG and embedded in `book.md`.
6. **Pre-flight evaluation** — Books rated by AI (Chief Epistemologist) before heavy processing, saving LLM tokens on low-quality content.
7. **Resilience layer** — Checkpoint store, batch coordinator, file locks, atomic writes, telemetry, graceful shutdown.
8. **Comprehensive test suite** — ~153 unit/integration tests (22 files), E2E scripts, Electron smoke E2E with UI harness.
9. **Bilingual UI** — Russian and English with `i18n.js` (~1800+ keys); UI hardening with dropzone drag-drop, busy-lock, danger-confirm.
10. **Portable build** — Single `.exe` with co-located data directory, no install required.

---

## 6. Known Weaknesses & Technical Debt

### P0 — Настоящие баги (высокий приоритет)

| Проблема | Файл | Симптом |
|----------|------|---------|
| `loadCatalog` ошибка IPC → только `console.error` | `renderer/library/catalog.js` | Пустая таблица без объяснений для пользователя |

*По итогам **итерационного кода-ревью 2026-04-28** снято с P0: (1) гипотеза о data race в `evaluator-queue` при двух слотах — в однопоточной модели Node/Electron не подтверждена; недетерминизм в тестах снят через `setEvaluatorSlots(1)`. (2) Throw из выбора модели / `evaluateBook` при недоступном LM Studio — смягчено: `pickEvaluatorModel` в `book-evaluator.ts` обёрнут в `try/catch` → `null` и предсказуемый fail path; `evaluator-queue` ловит throw из `pickEvaluatorModel` в своём `catch`.*

### P1 — Качество и UX

| Проблема | Файл | Влияние |
|----------|------|---------|
| `visionModelKey`/`visionMetaEnabled` не в Settings UI | `renderer/settings/sections.js` | Пользователь не может управлять vision через UI |
| Bulk delete errors → `console.warn` | `renderer/library/catalog.js` | Молчаливые частичные сбои при удалении |
| Session persistence не реализована | — | Потеря выбора книг при перезапуске |
| No centralized toast manager | `renderer/components/` | Разношёрстные уведомления: showAlert / status / toast |

### Низкий приоритет

| Проблема | Файл | Влияние |
|----------|------|---------|
| Vendor JS в репозитории | `renderer/marked.umd.js`, `renderer/vendor/purify.min.js` | Могло бы быть через npm + bundler |
| ~74 пустых `catch {}` блоков | Весь код | Большинство — intentional fallback, но стоит аудита |
| ESLint только для renderer | `npm run lint` | electron/ полагается только на TypeScript strict mode |
| RTF/DOC/ODT парсеры хрупкие | `electron/lib/scanner/parsers/` | Сложные файлы часто дают пустые sections |

---

## 7. Dependencies (production)

| Package | Purpose | Critical? |
|---------|---------|-----------|
| `@lmstudio/sdk` | LM Studio TypeScript SDK | Yes |
| `@napi-rs/canvas` | Canvas for image ops / OCR | Medium |
| `@napi-rs/system-ocr` | Native OCR bindings | Medium |
| `@qdrant/js-client-rest` | Qdrant vector DB client | Yes |
| `@xenova/transformers` | Local embeddings (ONNX) | Yes |
| `better-sqlite3` | SQLite driver (native) | Yes — requires Electron rebuild |
| `dotenv` | Env file loading | Low |
| `fast-xml-parser` | XML parsing (EPUB, FB2) | Yes |
| `fastest-levenshtein` | Fuzzy string matching | Low |
| `jszip` | ZIP/EPUB extraction | Yes |
| `mammoth` | DOCX → HTML conversion | Medium |
| `marked` | Markdown → HTML (possibly redundant with UMD) | Verify |
| `pdfjs-dist` | PDF parsing | Yes |
| `proper-lockfile` | Cross-process file locking | Medium |
| `uuid` | UUID generation | Low |
| `zod` | Schema validation | Yes |

**Native modules requiring Electron rebuild:** `better-sqlite3`, `@napi-rs/canvas`, `@napi-rs/system-ocr`, `sharp` (transitive via `@xenova/transformers`).

**PostInstall:** `npx @electron/rebuild --only better-sqlite3 --force` runs automatically after `npm install`.

---

## 8. Testing

| Тип | Файлов | ~Тест-кейсов | Runner | Команда |
|-----|--------|-------------|--------|---------|
| Unit/Integration | 21 | ~153 | node --test + tsx | `npm test` (auto-rebuilds better-sqlite3) |
| Electron Smoke (UI E2E) | 1 | 1 multi-step | playwright-electron | `npm run test:smoke` |
| E2E live scripts | 12+ | — | tsx (manual, требует LM Studio+Qdrant) | `npm run test:e2e:*` |

Тест-файлы в `tests/` и `tests/smoke/`, паттерн `*.test.ts`. Используется **`node --test`** (встроенный runner) с **`tsx`** для TypeScript без компиляции. Файл `vitest.config.ts` **не существует** — проект не использует vitest.

**Smoke E2E** запускается с `BIBLIARY_SMOKE_UI_HARNESS=1` — preload перехватывает library IPC и возвращает детерминированные данные без SQLite/LM Studio/Qdrant.

**Тестовое покрытие по областям:** library import/dedup/archive/revision ✓, evaluator queue ✓, batch runner ✓, vision-meta ✓, semantic chunker (surrogate builder) ✓. **Не покрыто:** Forge wizard, BookHunter, Agent, DJVU parser, YaRN engine, resilience/watchdog.

---

## 9. Build & Deploy

```bash
# Development
npm run electron:dev          # Compile TS + launch Electron

# Build portable (.exe)
npm run electron:build-portable  # scripts/build-portable.js → release/dist-portable/

# Build installer (NSIS)
npm run electron:build        # electron-builder standard

# Compile only (no launch)
npm run electron:compile      # tsc -p tsconfig.electron.json

# Tests
npm run test:fast             # unit tests без rebuild native (быстро)
npm test                      # rebuild better-sqlite3 + unit tests
npm run test:smoke            # Electron UI E2E (playwright)

# Lint
npm run lint                  # tsc --noEmit + eslint renderer/**/*.js
```

**Portable build specifics:**
- `scripts/build-portable.js` handles pre-rebuild of `better-sqlite3` for Electron ABI
- `scripts/afterPack.js` runs post-pack fixups
- Data directory resolves relative to the parent of the `.exe` (not temp dir)
- `@xenova/transformers` imports are **lazy** (dynamic `import()`) to avoid `sharp` DLL issues in portable mode

---

## 10. Configuration

| Файл | Назначение |
|------|-----------|
| `tsconfig.electron.json` | TypeScript config for main process |
| `electron-builder.yml` | Build configuration (Windows-only: NSIS + portable) |
| `data/preferences.json` | User preferences (55 keys via PreferencesSchema) |
| `electron/defaults/prompts/` | Bundled LLM prompt templates (7 files) |
| `electron/defaults/synth-prompts/` | Domain-specific synthesis prompts (10 files) |
| `electron/defaults/curated-models.json` | Scoring database for evaluator model selection |
| `electron/defaults/hardware-presets.json` | Hardware presets for VRAM forecasting |

Переменные среды:

| Переменная | Назначение | Default |
|-----------|-----------|---------|
| `BIBLIARY_DATA_DIR` | Корневая папка данных | `./data/` |
| `BIBLIARY_LIBRARY_ROOT` | Явная папка библиотеки | `{data}/library` |
| `BIBLIARY_EVAL_SLOTS` | Параллельных слотов эвалюатора | `2` |
| `BIBLIARY_7Z_PATH` | Путь к 7z.exe | bundled `vendor/7zip/` |
| `BIBLIARY_RASTER_IMAGE_PAGE_LIMIT` | Макс страниц для PDF/DJVU gallery | `12` |
| `BIBLIARY_VISION_MODEL_MARKERS` | CSV маркеров vision-моделей (erase hardcode) | builtin list |
| `BIBLIARY_VISION_META_MODEL_ATTEMPTS` | Макс попыток fallback vision-моделей | `3` |
| `BIBLIARY_SMOKE_UI_HARNESS` | Smoke harness mode для Electron E2E | — |
| `BIBLIARY_ARCHIVE_MAX_BYTES` | Лимит байт для архива | `2 GB` |
| `BIBLIARY_PROMPTS_DEFAULT_DIR` | Override директории промптов | bundled defaults |
| `PORTABLE_EXECUTABLE_DIR` | Устанавливается portable launcher'ом | — |
| `OPENROUTER_API_KEY` | Только для vision OCR через OpenRouter (опционально) | — |

---

## 11. Coding Conventions

1. **Main process:** TypeScript with strict mode, ES modules (`"type": "module"`), `.js` extensions in imports
2. **Renderer:** Vanilla JavaScript with `// @ts-check` and JSDoc type annotations
3. **No framework in renderer** — DOM manipulation via `renderer/dom.js` helpers (`el()`, `clear()`)
4. **IPC pattern:** Each domain has `electron/ipc/{domain}.ipc.ts` exporting a `register{Domain}Handlers(dataDir)` function
5. **Error handling:** `console.error` / `console.warn` for logging (no external logger)
6. **i18n:** All UI strings through `t("key")` from `renderer/i18n.js`
7. **File naming:** kebab-case for files, camelCase for functions/variables
8. **ESLint for renderer** — `npm run lint` / `lint:fix` covers `renderer/**/*.js`; electron/ relies on TypeScript strict mode

---

## 12. How to Run an Audit

```bash
# 1. Install dependencies
npm install

# 2. Verify TypeScript compiles
npx tsc -p tsconfig.electron.json --noEmit

# 3. Run tests
npm test

# 4. Launch in dev mode
npm run electron:dev

# 5. Check for dead exports (grep for unused exports)
# 6. Check for TODO/FIXME accumulation
# 7. Verify all IPC handlers have matching preload bridge entries
# 8. Check native module compatibility (better-sqlite3 ABI)
```

### Common pitfalls

1. **`npm install` breaks `better-sqlite3`** — The postinstall script handles this, but if you see `NODE_MODULE_VERSION` errors, run `npx @electron/rebuild --only better-sqlite3 --force`
2. **`sharp` DLL issues in portable build** — `@xenova/transformers` imports MUST be dynamic (lazy). Never add static `import ... from "@xenova/transformers"` at module top level
3. **Stale compiled files in `dist-electron/`** — Always use `npm run electron:compile` (runs `electron:clean` first) instead of bare `tsc`
4. **Data directory confusion** — Dev mode uses `./data/`, portable uses `../data/` relative to exe, `BIBLIARY_DATA_DIR` env var overrides both
5. **`marked` duplication** — The npm package `marked` may be redundant; the renderer uses `renderer/marked.umd.js` loaded via `<script>` tag
6. **Нет CI/CD** — `.github/workflows/` пуста. Все проверки — ручные
7. **`DEFAULT_SLOT_COUNT=2`** — evaluator-queue по умолчанию параллелен; тесты, где важен порядок двух книг, должны вызывать `setEvaluatorSlots(1)` (см. `tests/evaluator-queue.test.ts`)
8. **ZIP + `.txt` в тестах** — `shouldIncludeImportCandidate` отсекает текст короче 10 KiB; фиктивные книги в `archive-extractor-bomb.test.ts` должны дополняться до лимита

---

## 13. File Map (key files only)

```
bibliary/
├── electron/
│   ├── main.ts                          # App entry point
│   ├── preload.ts                       # contextBridge (renderer API)
│   ├── lmstudio-client.ts               # LM Studio REST + SDK wrapper
│   ├── crystallizer-constants.ts         # Shared constants
│   ├── ipc/                             # 16 IPC handler files
│   │   ├── index.ts                     # Register all IPC handlers
│   │   ├── library.ipc.ts              # Library CRUD + import + evaluate (25+ channels)
│   │   ├── scanner.ipc.ts             # Scanner/ingest operations
│   │   ├── agent.ipc.ts               # AI agent chat loop
│   │   ├── lmstudio.ipc.ts            # Model management
│   │   ├── dataset-v2.ipc.ts          # Training data synthesis
│   │   ├── forge.ipc.ts               # Fine-tuning wizard + LocalRunner WSL
│   │   ├── qdrant.ipc.ts              # Vector DB operations
│   │   ├── yarn.ipc.ts                # YaRN context expansion
│   │   ├── bookhunter.ipc.ts          # Book search + download
│   │   ├── wsl.ipc.ts                 # WSL detection
│   │   └── validators.ts              # Zod helpers (no ipcMain.handle)
│   └── lib/
│       ├── library/
│       │   ├── import.ts               # Orchestrator + re-exports; import-book / import-composite-html
│       │   ├── cache-db.ts             # SQLite cache (barrel re-export of 6 submodules)
│       │   ├── book-evaluator.ts       # LLM-based quality evaluation
│       │   ├── evaluator-queue.ts      # Evaluation job queue
│       │   ├── surrogate-builder.ts    # Surrogate text for evaluation
│       │   ├── md-converter.ts         # Raw text → structured Markdown
│       │   ├── filename-parser.ts      # Extract metadata from filenames
│       │   ├── fuzzy-matcher.ts        # Duplicate detection
│       │   ├── archive-extractor.ts    # ZIP/RAR/7z extraction
│       │   ├── scan-folder.ts          # Recursive folder scanning
│       │   ├── file-walker.ts          # FS traversal utility
│       │   └── types.ts                # Shared type definitions
│       ├── scanner/
│       │   ├── parsers/                # PDF, EPUB, FB2, DJVU, DOCX, etc.
│       │   ├── ingest.ts               # Ingest coordinator
│       │   └── embedding.ts            # Embedding generation
│       ├── rag/index.ts                # RAG search pipeline
│       ├── agent/                       # Tool-calling AI agent (loop, tools, history)
│       ├── resilience/                  # Watchdog, checkpoints, locks (10 files)
│       ├── forge/                       # Fine-tuning wizard pipeline (8 files)
│       ├── yarn/                        # YaRN engine + patcher (5 files)
│       ├── bookhunter/                  # Book search (4 sources, 8 files)
│       ├── llm/
│       │   ├── vision-meta.ts          # Vision LLM for cover metadata extraction
│       │   └── vision-ocr.ts           # Vision LLM for DJVU OCR
│       ├── native/sharp-loader.ts      # Centralized sharp/image-to-PNG loader
│       └── endpoints/index.ts          # URL resolution (LM Studio, Qdrant)
├── renderer/
│   ├── index.html                       # App shell
│   ├── router.js                        # Client-side routing
│   ├── dom.js                           # DOM helper utilities
│   ├── i18n.js                          # Internationalization (RU/EN)
│   ├── styles.css                       # Global styles
│   ├── library/
│   │   ├── catalog.js                   # Book catalog table (Quality, Year, Tags filter)
│   │   ├── import-pane.js              # Import UI with log panel
│   │   ├── reader.js                   # Book reader (Markdown + cover)
│   │   ├── tag-cloud.js                # Tag cloud modal with search
│   │   ├── evaluator.js                # Evaluator queue status panel
│   │   ├── state.js                    # Library state management
│   │   └── format.js                   # Display formatting helpers
│   ├── components/
│   │   ├── ui-dialog.js                # Alert/Confirm/Prompt (non-blocking)
│   │   ├── context-slider.js           # YaRN slider (full/compact/embedded)
│   │   └── welcome-wizard.js           # Onboarding wizard
│   ├── chat.js                          # RAG chat interface
│   ├── forge.js                         # Fine-tuning wizard UI
│   └── dataset-v2.js                    # Crystallizer / Dataset factory UI
├── scripts/                             # Dev tools & E2E live scripts (tsx)
├── tests/                               # node --test unit/integration tests
│   └── smoke/                           # Playwright Electron smoke E2E
├── docs/                                # Project documentation
├── vendor/
│   ├── djvulibre/win32-x64/            # Bundled djvutxt/ddjvu/djvused binaries
│   └── 7zip/win32-x64/                 # Bundled 7z.exe + 7z.dll
└── data/                                # Runtime data (gitignored)
    ├── library/{id}/book.md + original.* 
    ├── bibliary-cache.db                # SQLite metadata cache
    ├── preferences.json                 # User settings (55 keys)
    ├── telemetry.jsonl                  # Structured event log
    └── prompts/                         # User-overridable LLM prompt templates
```
