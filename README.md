# Bibliary

> Self-hosted web service for dataset creators: upload books, get
> atomic knowledge with topological relations for LLM fine-tuning.

Bibliary turns a library of books (PDF / EPUB / DJVU / DOCX / FB2 /
MOBI / CHM / RTF / HTML / TXT) into a structured knowledge graph and
training-ready datasets. Multi-user, runs on a modest single-pod
Coolify deployment, bring-your-own LLM provider keys.

---

## Why

Plenty of tools turn books into RAG indexes. Bibliary's goal is the
**opposite end of the pipeline** — produce *training data* you'd
actually fine-tune a model on:

- **Topology-preserving extraction** — every concept ships with at
  least one `subject → predicate → object` triple, so the dataset is
  graph-ready without post-processing.
- **AURA filter** — refuses to extract banalities. A concept must
  satisfy ≥2 of *authorship / specialization / revision / causality*
  or the chunk gets skipped.
- **Δ-topology** — hierarchy-aware chunking (H1>H2>H3 path on every
  chunk), L0 propositions / L1 section chunks / L2 chapter summaries,
  entity graph with canonicalization + aliases, PPR-blended retrieval.
- **Per-user provider keys** — your Anthropic / OpenAI key lives
  AES-256-GCM encrypted at rest, decrypted only in process memory.
  LM Studio supported as a shared local LLM.
- **Async queue with crash recovery** — load 100 books, come back in
  an hour, dataset is ready. Heartbeat + orphan reset means a backend
  restart resumes cleanly.
- **Three export formats** — JSONL (atomic), ShareGPT (turn-based),
  ChatML (HuggingFace SFT convention). Multi-tier Q&A synthesis with
  Jaccard dedup.
- **CPU-only OCR** for Russian / Ukrainian / Chinese / English (native
  Tesseract via apt, no GPU, no Python sidecar).

---

## Quick start (Docker)

```bash
git clone <this-repo> bibliary && cd bibliary
cp .env.example .env

# Generate JWT keypair + AES master key, paste into .env:
openssl genpkey -algorithm RSA -out jwt-private.pem -pkeyopt rsa_keygen_bits:2048
openssl rsa -in jwt-private.pem -pubout -out jwt-public.pem
openssl rand -hex 32   # → BIBLIARY_ENCRYPTION_KEY

# Bring up backend + Appwrite + MariaDB + Redis stack:
docker compose -f docker-compose.prod.yml up -d

# First-run Appwrite bootstrap (idempotent):
docker compose exec bibliary npm run appwrite:bootstrap

# Open the app:
open http://localhost:3000
```

First registered user automatically becomes admin. Optionally pre-seed
admins via `BIBLIARY_ADMIN_EMAILS=alice@example.com,bob@example.com`
in `.env`.

For Coolify deployment + production hardening see
[`docs/deployment.md`](docs/deployment.md).

For migrating from the legacy Windows Electron build see
[`docs/migration-from-electron.md`](docs/migration-from-electron.md).

---

## Architecture

```
                ┌──────────────────────────────┐
                │  Renderer (Vanilla JS + Vite)│
                │   /library  /datasets  /admin│
                └──────────────┬───────────────┘
                               │ cookie-based fetch + SSE
                ┌──────────────▼───────────────┐
                │   Hono backend (Node 22)     │
                │   /api/{auth,library,        │
                │        datasets,admin,llm}   │
                └─────┬──────────────────┬─────┘
                      │                  │
                ┌─────▼──────┐    ┌──────▼──────┐
                │  Appwrite  │    │  sqlite-vec │
                │  • users   │    │  • chunks   │
                │  • books   │    │  • concepts │
                │  • concepts│    │  • chunks   │
                │  • jobs    │    │  • graph    │
                │  • audit   │    │    entities │
                │  Storage:  │    │    relations│
                │  originals,│    └─────────────┘
                │  markdown, │
                │  covers,   │
                │  datasets  │
                └────────────┘
```

**Δ-topology layers** (every accepted DeltaKnowledge produces all of):
1. **L1 chunks** — section text + breadcrumb, embedded as 384-dim
   multilingual-e5 vectors. Primary retrieval grain.
2. **L2 summaries** — RAPTOR-style chapter throughline, also embedded.
   Children L1 chunks reparented up via `parent_vec_rowid`.
3. **L0 propositions** *(only for books with `qualityScore ≥ 7` AND
   `!isFictionOrWater`)* — each triple gets its own embedded sentence,
   parented at the source L1.
4. **Entity graph** — canonical entities + alias capture; relations
   table holds typed edges with `source_chunk_vec_rowid` back-pointer.

**Retrieval**: `GET /api/datasets/search-chunks` returns chunks scored
by `α·cosine + β·normalized_PPR(entities seeded from query tokens)`.
Defaults `α=0.7 β=0.3`; tunable per request.

---

## Roles & LLM providers

Each user assigns providers per *role* in **Settings → Providers**:

| Role | Used by | Notes |
|------|---------|-------|
| `evaluator` | `POST /books/:id/evaluate` | Scores 0-10 + `isFictionOrWater` flag |
| `crystallizer` | `POST /books/:id/extract` | DeltaKnowledge JSON extraction |
| `crystallizer` | L2 chapter summarizer | Reuses crystallizer role |
| `synthesizer` (= crystallizer) | ShareGPT / ChatML export | Multi-tier Q&A |

Three provider implementations are interchangeable:

- **Anthropic** — Claude Opus / Sonnet / Haiku, supports
  prompt caching, extended thinking.
- **OpenAI** — GPT-4o / o1 with JSON response format + vision.
- **LM Studio** — OpenAI-compatible local server (Qwen / Llama / etc).

Per-user API keys are stored AES-256-GCM-encrypted; the master
`BIBLIARY_ENCRYPTION_KEY` lives only in process env.

---

## Modest-server sizing

Bibliary is built to run on a **single small VPS**, not a Kubernetes
cluster. Tested target:

| Resource | Minimum | Recommended |
|----------|---------|-------------|
| CPU | 2 vCPU | 4 vCPU |
| RAM | 2 GB | 4 GB |
| Disk | 20 GB | 100 GB |
| Network | 100 Mbps | 1 Gbps |

What runs in-pod: Hono backend + sqlite-vec + Tesseract + djvulibre +
7zip + the @xenova/transformers embedder (~120MB ONNX model). All
CPU-only. No GPU, no Python sidecars.

What runs separately: Appwrite stack (MariaDB + Redis + Appwrite +
nginx) — another ~2 GB RAM. Coolify's Appwrite template handles this
cleanly.

Heavy LLM inference does NOT run on the Bibliary pod — it goes out to
your configured provider (Anthropic / OpenAI cloud, or a separately
hosted LM Studio).

---

## Supported book formats

| Format | Parser | Notes |
|--------|--------|-------|
| PDF | pdfjs-dist + worker | + Tesseract OCR cascade for scanned PDFs |
| EPUB | jszip + fast-xml-parser | OPF spine + NCX nav |
| DJVU | djvu.js (WASM) + djvulibre CLI fallback | OCR cascade for image DjVu |
| DOCX | mammoth | Heading style mapping |
| FB2 | fast-xml-parser | Nested sections |
| CHM | 7z subprocess + composite-html | Microsoft Compiled HTML |
| MOBI / AZW / AZW3 / PDB / PRC | pure JS PalmDoc + EXTH | KF8 / AZW3 metadata only |
| RTF | pure JS | Control-code text extraction |
| HTML / HTM | chardet + iconv-lite | BOM → meta → chardet fallback |
| ODT | jszip + fast-xml-parser | OpenDocument |
| TIFF / PNG / JPEG | sharp + Tesseract | Tier-1 OCR pipeline |
| CBZ / CBR | jszip + pdf-lib | Comic ZIP → PDF |
| TXT | chardet | Encoding-aware |

OCR languages bundled: **rus, ukr, eng, chi-sim, chi-tra** (Tesseract
native, ~120 MB total). Vision LLM (any user-configured provider with
vision capability) is Tier-2 fallback.

---

## Project state

Web service is **feature-complete** for the dataset-creator workflow.
See [`docs/FINAL-STATUS.md`](docs/FINAL-STATUS.md) for the full audit
of what shipped, what's deferred, and the upgrade paths once a golden
corpus benchmark exists.

Legacy Electron desktop build is **retired** at the renderer + build
tooling level (Phase 13a-b-c-light). The scanner core stays under
`electron/lib/scanner/` consumed at runtime via
`server/lib/scanner/parsers-bridge.ts`; full lift-and-shift is gated
on a golden corpus benchmark to avoid silent parsing regressions.

---

## Development

```bash
npm install
cp .env.example .env  # fill in Appwrite + JWT + AES keys

# Dev — concurrently runs server (tsx watch) + Vite:
npm run dev

# Type-check + lint + unit tests:
npm run lint
npm run test:fast:serial

# Build server + web bundle:
npm run build
```

Tests run via Node's built-in test runner (`node --test`). The
`Web stack smoke (required)` CI step covers the Δ-topology pipeline
end-to-end; the `Legacy unit suite (best-effort)` step runs the full
tests/*.test.ts as a regression net.

---

## License

See LICENSE.

---

## Acknowledgements

- **GraphRAG** (Microsoft) — community-detection inspiration; we
  ultimately chose LightRAG-style entity merge over Leiden for cost.
- **RAPTOR** (Stanford) — bottom-up summary tree pattern (our L2 layer).
- **HippoRAG** (OSU NLP) — Personalized PageRank seeded from query
  entities (our `/search-chunks` graph score).
- **LightRAG** (HKUDS) — entity-merged dual-level retrieval.
- **multilingual-e5** (Xenova / Microsoft) — embedding model.
- **sqlite-vec** (Alex Garcia) — embedded vector store.
- **Hono** — tiny, fast HTTP framework.
- **Appwrite** — BaaS that makes multi-user self-host actually doable.
