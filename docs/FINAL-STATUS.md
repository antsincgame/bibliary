# Final status — what shipped, what's deferred

This document is the close-out audit of the Bibliary web-service
refactor. It catalogs every phase that closed, every primitive
that's wired, and every decision that's intentionally deferred with
the reasoning written down so future contributors don't re-litigate.

Last updated: end of the closing session.

---

## Shipped phases

### Backend foundation

| Phase | Title | Result |
|-------|-------|--------|
| 0 | Hono scaffold + Appwrite bootstrap | ✅ Backend boots, /health route, CSP + secureHeaders, rate-limit |
| 1 | Custom JWT auth (jose RS256) | ✅ 15-min access cookie + 30-day opaque refresh; bcrypt hash; first-user auto-admin |
| 2 | IPC → HTTP routes (10 domains) | ✅ preferences, system, lmstudio, vectordb, library catalog + aggregations + burn-all, datasets exports, scanner, library import-files |
| 3 | Renderer api-client (13 namespaces) | ✅ Cookie-based fetch with auto-refresh on 401; SSE EventSource adapter for live progress |
| 4 | Browser drag&drop + multipart upload | ✅ attachDropZone; uploadAndImport with upload-progress events |
| 6 | LLM provider abstraction | ✅ LLMProvider interface; Anthropic (prompt caching) + OpenAI (JSON mode + vision) + LM Studio implementations; per-user AES-256-GCM keys; withProvider(role, fn) |
| 6c-e | LLM consumers wired | ✅ Server-side evaluateBook + extractChapter; structural chunker + markdown chapter splitter; /books/:id/evaluate and /books/:id/extract HTTP routes |
| 6f-g | SSE channel split + fallback signal | ✅ evaluator_events vs extractor_events; usingFallback boolean propagated |
| 7 | Async extraction queue | ✅ Persistent dataset_jobs; FIFO drain; abort-signal cancellation; state-machine guard; orphan-reset on boot; 30s heartbeat |
| 8a-e | Dataset export pipeline | ✅ JSONL + ShareGPT + ChatML; streaming writer; multi-tier Q&A (T1/T2/T3) via crystallizer; Jaccard dedup; chunk cleanup (page numbers / ISBN / decorative dividers) |
| 9 | Batch crystallization | ✅ POST /api/library/batches/start with quality gate; UI Crystallize button rewired |
| 10 | Concept embeddings + semantic dedup + search | ✅ multilingual-e5-small lazy singleton; concepts_vec partitioned by user/collection; cosine threshold 0.9; GET /api/datasets/search |
| 11 | Admin panel | ✅ Users/Jobs/Storage/Audit tabs; requireAdmin guard; self-protection invariants; audit log writer + reader on 12 action types |
| 13a | Renderer Electron retirement | ✅ Deleted dataset-v2*.js, batch-actions.js, crystal route, BATCH state, datasetV2 stubs |
| 13b | Build tooling retirement | ✅ Dropped electron/electron-builder/playwright; deleted tsconfig.electron.json + 13 scripts; CI Windows → Linux |
| 13c-light | Electron entry-point retirement | ✅ Deleted main.ts / preload.ts / ipc/ / app-menu / smoke-harness / BrowserWindow broadcasters + 17 orphan tests |

### Δ-topology pipeline (the original "synergy" deliverable)

| Phase | Title | Result |
|-------|-------|--------|
| Δa | Hierarchy-aware chunker | ✅ splitMarkdownIntoSections preserves H1>H2>H3 breadcrumb; chunkSections never crosses heading boundaries; groupSectionsForExtraction for LLM cost parity |
| Δb | L1 chunk persistence | ✅ chunks meta table + chunks_vec; insertChunk atomic transaction; sibling links per section; deleteAllChunksForBook |
| Δc | Entity + relations graph | ✅ entities + entity_aliases + relations tables; canonicalize + alias capture; ingestRelations on every accepted delta; deleteGraphForBook with orphan sweep |
| Δd | L2 chapter summaries | ✅ RAPTOR-style summarizer reusing crystallizer role; insertChunk level=2; reparent L1 children up via setParentForChunks |
| Δe | L0 propositions | ✅ Lazy gate on qualityScore ≥ 7 AND !isFictionOrWater; buildPropositionText for each triple; embed + insert level=0 |
| Δf | PPR-aware retrieval | ✅ Sparse power iteration (damping=0.15, 25 iter, ε=1e-6); findEntityIdsForQuery via token canonicalize + alias + substring; GET /search-chunks with α/β tunable blend |
| Δ-ui | Renderer surface | ✅ /search-chunks panel on Datasets page with debounced search + α/β sliders; pipeline log topology counters; SSE batch:filtered event |

### Risk-register items

| Item | Status | Where |
|------|--------|-------|
| Streaming chapter splitter | ✅ Closed | iterateMarkdownSections + iterateExtractionUnits — hand-rolled line scanner, no Array<string> materialization |
| Heartbeat for running jobs | ✅ Closed | extraction-queue.ts:215 — setInterval(touchJob, 30s) with clearInterval in finally |
| Crash recovery | ✅ Closed | Orphan-reset on boot (state=running + updatedAt < now-5min → back to queued) |

### Infrastructure polish

| Phase | Result |
|-------|--------|
| Docker + Coolify image | ✅ Multi-stage Dockerfile (builder + slim runtime); djvulibre + p7zip + tesseract(rus/ukr/eng/chi-sim/chi-tra) |
| Coolify deployment doc | ✅ docs/deployment.md with modest-server tuning |
| CI workflow | ✅ Linux-only; required smoke (170 cases) + best-effort legacy suite; apt-installs the production binary surface |
| Audit log | ✅ 12 action types; admin operations + auth.login/register + library.burn_all |

---

## Frozen but not deleted

### `electron/lib/scanner/` and its transitive deps

~145 TypeScript files under `electron/lib/` are still alive. They power
the production parser pipeline via `server/lib/scanner/parsers-bridge.ts`,
which loads them at runtime through a non-literal `await import()`
expression that escapes tsc's static analysis.

**Why not migrated**: doing a 145-file lift-and-shift without a golden
corpus benchmark to verify PDF / EPUB / DJVU / CHM parsing didn't
regress is reckless. The benchmark scaffold landed (see
`tests/golden-corpus/`) but the corpus itself is operator-specific.

**What still runs through `electron/lib/`**:
- All book format parsers (PDF, EPUB, DJVU, DOCX, FB2, CHM, MOBI, RTF,
  ODT, HTML, TIFF, CBZ, TXT)
- Converters (CBZ→PDF, DJVU→PDF, multi-tiff→PDF, LRU disk cache)
- Two-tier OCR (Tesseract.js + native system-OCR)
- Folder-bundle classifier (book + sidecar markdown assembly)
- Mojibake repair (Cyrillic latin-homoglyph fix)

**Path forward**: Phase 13c-full (deferred). Pre-requisite is a 15-20
book golden corpus per the scaffold in
[`tests/golden-corpus/README.md`](../tests/golden-corpus/README.md).
With the corpus in place, the migration becomes mechanical and
verifiable.

### Multi-pod scaling

The extraction queue is single-process FIFO with in-memory pending
list and AbortController map. Multi-pod scale-out requires Redis
SETNX claim per job and a Redis pubsub for SSE events.

**Why deferred**: single-pod target handles 5-50 concurrent users per
the modest-server sizing. Phase exists in the original plan as
Priority 5; activate only if real demand materializes.

### Parser progressions (mupdf / Calibre / MinerU / PaddleOCR)

Researched in the closing session. Operator explicitly chose to keep
the existing CPU-only stack for a modest-server target:
- ❌ mupdf-wasm (AGPL, requires golden corpus to verify)
- ❌ Calibre subprocess (~500 MB image bloat, kills modest-server budget)
- ❌ MinerU sidecar (Python + GPU)
- ❌ PaddleOCR sidecar (Python + 1-2GB models)
- ✅ Native Tesseract with chi-sim + chi-tra added (the one progression
  that fits CPU-only constraint)

Adding any of the deferred parsers later remains an option; the golden
corpus scaffold is the gate.

---

## Test footprint at close

**~170 web-stack smoke cases** required to merge (CI), covering:

- Server boot + health route
- Auth route guards
- Rate-limit
- Library batch crystallization route
- Chunker (sections, streaming, boundaries, back-compat chapters)
- Chunk cleanup
- Embedder pure helpers
- vectordb concepts (KNN, partitions, dedup)
- vectordb chunks (L1 + L2 + L0)
- vectordb graph (entities + relations + canonicalize + delete cascade)
- L2 parent linking + per-unit listing
- Proposition text builder
- Personalized PageRank (star / path / single-seed / two-seed / edge cases)
- Evaluator + extractor provider smoke
- Extraction queue state machine
- Dataset export (JSONL / ShareGPT / ChatML / stream-writer)
- ShareGPT tiered Q&A
- Admin route guards + audit module surface

Plus **best-effort legacy suite** (~900 more cases targeting
`electron/lib/*` code, won't block merge if a Linux-specific failure
surfaces — there were 4 such cases at close).

---

## Operator surface map

### URLs after deploy

| Path | What |
|------|------|
| `GET /` | Landing → register / login → main app |
| `GET /health` | JSON health probe |
| `POST /api/auth/{register,login,logout,refresh}` | Auth |
| `GET /api/auth/me` | Current user |
| `POST /api/library/upload` | Drag-drop ingest |
| `POST /api/library/books/:id/evaluate` | Per-book quality scoring |
| `POST /api/library/books/:id/extract` | Per-book crystallization |
| `POST /api/library/batches/start` | Batch crystallization with quality gate |
| `POST /api/library/burn-all` | Self-wipe |
| `GET /api/library/jobs` | Per-user queue inspection |
| `POST /api/datasets/build` | JSONL/ShareGPT/ChatML export |
| `GET /api/datasets/exports/:jobId/download` | Stream export |
| `GET /api/datasets/search` | Concept semantic search |
| `GET /api/datasets/search-chunks` | Δ-topology chunk search with PPR blend |
| `GET /api/admin/*` | Admin panel surface (users / jobs / storage / audit) |
| `GET /api/events` | SSE multiplexed event stream |

### Settings UI tabs

- **Providers** — Anthropic / OpenAI / LM Studio key management +
  Test button + per-role model assignment (evaluator / crystallizer)
- **Library** — catalog with quality gate filters + Crystallize batch
- **Datasets** — graph-aware chunk search + export job history
- **Admin** (visible only when `role=admin`) — Users / Jobs / Storage /
  Audit

---

## Operator's first day

1. Deploy via Coolify per [`docs/deployment.md`](deployment.md).
2. Open the landing URL, register the first account — it auto-becomes
   admin.
3. Settings → Providers → paste Anthropic key (or LM Studio URL) →
   Test.
4. Assign evaluator + crystallizer roles to your chosen models.
5. Library → drag-drop 10 books → wait for status="imported".
6. Select all → Evaluate.
7. Filter by `qualityScore ≥ 5`, `isFictionOrWater = false`.
8. Crystallize → enter collection name (e.g. `training-v1`).
9. Wait — heartbeat keeps the queue alive while LLM crunches.
10. Datasets → Build new → ChatML → download `.jsonl`.

Then optionally: invite collaborators (register additional accounts,
keep them as `user` role unless you trust them), monitor in Admin →
Audit.

---

## What we'd do next, if time existed

Ordered by ROI under the modest-server constraint:

1. **Populate the golden corpus** — 4-6 hours of operator time, then
   every future scanner change is verifiable.
2. **Phase 13c full** — migrate `electron/lib/scanner/` →
   `server/lib/scanner/` once the corpus exists. Mechanical lift +
   path updates; 8-12 hours.
3. **Streaming LLM responses** — the provider abstraction can support
   chat-stream; would let SSE push per-chapter chunks instead of
   waiting for the whole crystallizer response. UX nice-to-have.
4. **Quota enforcement** — `libraryQuotaBytes` field exists on the
   user document but no middleware enforces it on upload. Add gate
   in import-pipeline.
5. **mupdf-wasm upgrade** — once corpus exists, drop-in replacement
   for pdfjs-dist. AGPL fine for self-host. Faster, more robust to
   malformed PDFs.
6. **Multi-pod scale** — Redis SETNX claim + Redis pubsub for SSE.
   Only needed if you outgrow a single Coolify VPS.

None of these block the dataset-creator workflow at close.
