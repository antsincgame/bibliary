# Bibliary — AI Audit Document

> **Version:** 3.0.0  
> **Date:** 2026-04-25  
> **Purpose:** Comprehensive project context for any AI agent performing code review, bug hunting, refactoring, or feature development.

---

## 1. What Is Bibliary?

Bibliary is a **desktop Electron application** (Windows-first) that acts as a personal knowledge library. It ingests books (PDF, EPUB, FB2, DJVU, DOCX, Markdown, plain text, and archives containing them), converts them to structured Markdown with YAML frontmatter, evaluates their quality using a local LLM (via LM Studio), and stores everything in a file-system-first library backed by SQLite metadata cache.

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
| `tests/` | Unit/integration tests (vitest) |
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
| Build | electron-builder (portable + installer) |
| Tests | node --test (built-in) + tsx |
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
        │     ├─ PDF → pdfjs-dist (+ optional OCR)
        │     ├─ EPUB → fast-xml-parser + jszip
        │     ├─ FB2 → fast-xml-parser
        │     ├─ DJVU → djvu-cli (external tool)
        │     ├─ DOCX → mammoth
        │     └─ MD/TXT → passthrough
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

Frontmatter fields: `id`, `title`, `titleEn`, `author`, `domain`, `tags[]`, `wordCount`, `chapterCount`, `qualityScore`, `qualityVerdict`, `status`, `sourceFile`, `importedAt`, `evaluatedAt`, `isFiction`, `language`.

---

## 4. IPC Contract (preload bridge)

The renderer communicates with the main process through `window.api`:

```
window.api.library.catalog(opts)     → BookRow[]
window.api.library.getBook(id)       → BookMeta | null
window.api.library.readBookMd(id)    → { markdown: string } | null
window.api.library.deleteBook(id)    → boolean
window.api.library.importFiles(paths, opts) → ImportResult
window.api.library.importFolder(dir, opts)  → ImportResult
window.api.library.evaluateBooks(ids)       → EvalResult
window.api.scanner.*                 → Scanning / ingest operations
window.api.lmstudio.*               → LM Studio connection, model listing
window.api.agent.*                   → AI agent chat loop
window.api.rag.*                     → RAG search
window.api.forge.*                   → Site generation
window.api.datasetV2.*               → Training data synthesis
window.api.system.*                  → App info, hardware profiling
```

---

## 5. Known Strengths

1. **File-system-first architecture** — Books stored as plain files (MD + original), not locked in a database blob. Survives DB corruption.
2. **Fully offline** — No cloud dependencies. LM Studio runs locally. Embeddings via ONNX locally.
3. **Robust parsing pipeline** — 7 format parsers with fallback chains, OCR opt-in, archive extraction (nested ZIPs/RARs).
4. **Pre-flight evaluation** — Books are rated by AI before heavy processing, saving LLM tokens.
5. **Resilience layer** — Checkpoint store, batch coordinator, file locks, atomic writes, telemetry, graceful shutdown.
6. **Comprehensive test suite** — 65+ unit/integration tests, E2E scripts, Electron smoke test.
7. **Bilingual UI** — Russian and English with `i18n.js`.
8. **Portable build** — Single `.exe` with co-located data directory, no install required.

---

## 6. Known Weaknesses & Technical Debt

### High priority

| Issue | Location | Impact |
|-------|----------|--------|
| Large files (>500 LOC) | `import.ts` (678), `lmstudio-client.ts` (618) remain; `cache-db.ts` split into 6 modules, `chat.js`/`forge.js`/`i18n.js` modularized in v2.8.0 | Reduced coupling, 4 of 6 resolved |
| Swallowed promises | 15+ `.catch(() => undefined)` across codebase | Silent failures can mask real bugs |
| Empty catch blocks | `evaluator-queue.ts`, `forge.ipc.ts`, `concept-extractor.ts`, `telemetry.ts`, `djvu-cli.ts` | Errors invisible at runtime |
| `any` types in renderer JSDoc | `context-slider.js`, `welcome-wizard.js`, `reader.js`, `forge.js` | No type safety in UI components |

### Medium priority

| Issue | Location | Impact |
|-------|----------|--------|
| Duplicated HTTP-response pattern | `resp.text().catch(() => "")` in 10+ files | Could be a shared helper |
| ~~192 TODO/FIXME markers~~ | Cleaned: 0 real TODO/FIXME in code comments (v2.8.0) | Previous count included false positives (`temp`, `xxx` in identifiers) |
| `build-gold-examples.cjs` orphan | `scripts/` | Dead code, 168 LOC |
| Functions >50 LOC | `importBookFromFile`, UI flows in `forge.js` | Complexity hotspots |
| ESLint on renderer only | `npm run lint` covers `renderer/**/*.js` | No TS lint for electron/ yet |

### Low priority

| Issue | Location | Impact |
|-------|----------|--------|
| Vendor JS in repo | `marked.umd.js`, `purify.min.js` | Could use npm + bundler instead |
| `marked` npm dep possibly redundant | `package.json` | UI uses UMD bundle from repo, not the npm package |
| 14+ scripts not in package.json | `scripts/` | Discoverability — developers won't know they exist |

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

| Type | Count | Runner | Command |
|------|-------|--------|---------|
| Unit/Integration | 133 | node --test + tsx | `npm test` (auto-rebuilds better-sqlite3 for Node ABI) |
| Electron Smoke | 1 | playwright-electron | `npm run test:smoke` |
| E2E scripts | 12+ | tsx (manual) | `npm run e2e:*` |

Test files live in `tests/` and follow the `*.test.ts` pattern.

---

## 9. Build & Deploy

```bash
# Development
npm run electron:dev          # Compile TS + launch Electron

# Build portable (.exe)
npm run build:portable        # scripts/build-portable.js → release/

# Build installer
npm run build:installer       # electron-builder standard

# Compile only (no launch)
npm run electron:compile      # tsc -p tsconfig.electron.json
```

**Portable build specifics:**
- `scripts/build-portable.js` handles pre-rebuild of `better-sqlite3` for Electron ABI
- `scripts/afterPack.js` runs post-pack fixups
- Data directory resolves relative to the parent of the `.exe` (not temp dir)
- `@xenova/transformers` imports are **lazy** (dynamic `import()`) to avoid `sharp` DLL issues in portable mode

---

## 10. Configuration

| File | Purpose |
|------|---------|
| `tsconfig.electron.json` | TypeScript config for main process |
| `electron-builder.yml` | Build configuration |
| `vitest.config.ts` | Test runner config |
| `data/preferences.json` | User preferences (model, quality thresholds) |
| `data/prompts/` | Customizable LLM prompt templates |

Environment variables:
- `BIBLIARY_DATA_DIR` — Override data directory (default: `./data/`)
- `BIBLIARY_RAG_SCORE_THRESHOLD` — RAG relevance threshold (default: 0.55)
- `PORTABLE_EXECUTABLE_DIR` — Set by portable launcher on Windows

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
2. **`sharp` DLL issues in portable build** — `@xenova/transformers` imports MUST be dynamic (lazy). Never add static `import ... from "@xenova/transformers"` at module top level. The portable `.exe` runs from a temp directory where native `.node` binaries may lack DLL dependencies
3. **Stale compiled files in `dist-electron/`** — TypeScript incremental compilation does NOT delete `.js` files when the corresponding `.ts` source is removed. Always use `npm run electron:compile` (which runs `electron:clean` first) instead of bare `tsc`. A stale `ipc-handlers.js` with static `require("@xenova/transformers")` caused a startup crash in the portable build
4. **Data directory confusion** — Dev mode uses `./data/`, portable uses `../data/` relative to exe, `BIBLIARY_DATA_DIR` env var overrides both
5. **`marked` duplication** — The npm package `marked` may be redundant; the renderer uses `renderer/marked.umd.js` loaded via `<script>` tag

---

## 13. File Map (key files only)

```
bibliary/
├── electron/
│   ├── main.ts                          # App entry point
│   ├── preload.ts                       # contextBridge (renderer API)
│   ├── lmstudio-client.ts               # LM Studio REST + SDK wrapper
│   ├── crystallizer-constants.ts         # Shared constants
│   ├── ipc/
│   │   ├── index.ts                     # Register all IPC handlers
│   │   ├── library.ipc.ts              # Library CRUD + import + evaluate
│   │   ├── scanner.ipc.ts             # Scanner/ingest operations
│   │   ├── agent.ipc.ts               # AI agent chat loop
│   │   ├── lmstudio.ipc.ts            # Model management
│   │   ├── dataset-v2.ipc.ts          # Training data synthesis
│   │   ├── forge.ipc.ts               # Site generation
│   │   ├── qdrant.ipc.ts              # Vector DB operations
│   │   ├── yarn.ipc.ts                # Yarn engine
│   │   └── validators.ts              # Zod schemas for IPC
│   └── lib/
│       ├── library/
│       │   ├── import.ts               # Book import pipeline
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
│       ├── agent/                       # Tool-calling AI agent
│       ├── resilience/                  # Watchdog, checkpoints, locks
│       ├── forge/                       # Site generation pipeline
│       └── endpoints/index.ts           # URL resolution (LM Studio, Qdrant)
├── renderer/
│   ├── index.html                       # App shell
│   ├── router.js                        # Client-side routing
│   ├── dom.js                           # DOM helper utilities
│   ├── i18n.js                          # Internationalization (RU/EN)
│   ├── styles.css                       # Global styles
│   ├── library/
│   │   ├── catalog.js                   # Book catalog table
│   │   ├── import-pane.js              # Import UI
│   │   ├── reader.js                   # Book reader (Markdown viewer)
│   │   ├── state.js                    # Library state management
│   │   └── format.js                   # Display formatting helpers
│   ├── components/                      # Shared UI components
│   ├── chat.js                          # RAG chat interface
│   ├── forge.js                         # Site generator UI
│   └── dataset-v2.js                    # Dataset factory UI
├── scripts/                             # Dev tools & E2E tests
├── tests/                               # vitest test files
├── docs/                                # Project documentation
└── data/                                # Runtime data (gitignored)
    ├── library/{id}/book.md + original.* 
    ├── bibliary-cache.db                # SQLite metadata cache
    ├── preferences.json                 # User settings
    └── prompts/                         # LLM prompt templates
```
